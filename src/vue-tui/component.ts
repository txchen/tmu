import { Box, Text, useApp, useInput, useWindowSize } from "@vue-tui/runtime";
import { defineComponent, h, onScopeDispose, shallowRef, watch } from "vue";
import { createActionRegistry } from "../action-registry";
import type { AppCoordinator, AppStateChangeReason } from "../coordinator";
import { sameIdentity, type PickerOverlay, type QueueEntry, type ResponsiveTier } from "../domain";
import { RootInputRouter } from "../input-router";
import { dispatchTerminalResize } from "./resize";
import {
  StatePublicationGate,
  type PublicationCause,
  type PublicationSnapshot,
} from "../state-publication";

export type TmuRootOptions = {
  coordinator: AppCoordinator;
  measureCellWidth?: (value: string) => number;
  noColor?: boolean;
};

export function createTmuRoot(options: TmuRootOptions) {
  const presentation = createPresentation(options);
  return defineComponent({
    name: "TmuRoot",
    setup() {
      const { coordinator } = options;
      coordinator.dispatchUi({
        type: "updateView",
        patch: { activeTargetId: "queue", focusedPane: "queue" },
      });
      coordinator.dispatchUi({
        type: "syncQueue",
        identities: coordinator.queueTrackIdentities(),
        preferredIdentity: coordinator.appState.playback.currentTrackIdentity,
      });

      const cadence = coordinator.appState.config.lowPower;
      const publication = new StatePublicationGate({
        readState: () => ({ appState: coordinator.appState, uiState: coordinator.uiState }),
        cadence: {
          playbackCadenceMs: null,
          downloadProgressMs: cadence.downloadProgressThrottleMs,
          providerProgressMs: cadence.providerProgressThrottleMs,
        },
      });
      const snapshot = shallowRef<PublicationSnapshot>(publication.publishInitial());
      const publishSnapshot = (next: PublicationSnapshot) => {
        snapshot.value = next;
      };
      const unsubscribePublication = publication.subscribe(publishSnapshot);
      const unsubscribeCoordinator = coordinator.onStateChange((reason) => {
        publication.notify(publicationCause(reason));
      });

      const router = new RootInputRouter({
        registry: createActionRegistry(),
        appState: () => coordinator.appState,
        uiState: {
          get snapshot() {
            return coordinator.uiState;
          },
          dispatch(action) {
            return coordinator.dispatchUi(action);
          },
        },
        dispatchApp: (intent) => coordinator.dispatch(intent),
        dispatchUiIntent: (intent) => coordinator.dispatch(intent),
      });
      const app = useApp();
      const { columns, rows } = useWindowSize();

      watch([columns, rows], ([nextColumns, nextRows]) => {
        dispatchTerminalResize(coordinator, nextColumns, nextRows);
        publication.notify("resize");
      }, { immediate: true });

      useInput((input, key) => {
        const routedKey = terminalKey(input, key);
        void routeInput(routedKey);
      });

      async function routeInput(key: string): Promise<void> {
        if (coordinator.uiState.terminal.tier === "terminal-too-small" && key !== "\u0003") {
          publication.notify("input");
          return;
        }
        const hadOverlay = coordinator.uiState.overlays.length > 0;
        if (!hadOverlay && (key === "o" || key === "/" || key === "?" || key === ":")) {
          coordinator.dispatchUi({
            type: "openOverlay",
            overlay: key === "?"
              ? simpleOverlay("shortcut-help")
              : key === ":"
                ? simpleOverlay("command-palette")
                : pickerOverlay(key === "/"),
          });
          publication.notify("input");
          return;
        }

        await router.route(key);
        publication.notify("input");
        if (key === "\u0003" || (key === "q" && !hadOverlay)) app.exit();
      }

      onScopeDispose(() => {
        router.cancelPendingSequence();
        unsubscribeCoordinator();
        unsubscribePublication();
        publication.stop();
      });

      return () => renderTmu(snapshot.value, presentation);
    },
  });
}

type Presentation = {
  markers: { selected: string; current: string; unavailable: string };
  useColor: boolean;
};

function createPresentation(options: TmuRootOptions): Presentation {
  const measure = options.measureCellWidth ?? Bun.stringWidth;
  const unicode = ["›", "●", "!"].every((marker) => measure(marker) === 1);
  return {
    markers: unicode
      ? { selected: "›", current: "●", unavailable: "!" }
      : { selected: ">", current: "*", unavailable: "!" },
    useColor: !(options.noColor ?? process.env.NO_COLOR !== undefined),
  };
}

function renderTmu(snapshot: PublicationSnapshot, presentation: Presentation) {
  const { appState, uiState } = snapshot;
  const tier = uiState.terminal.tier;
  const current = appState.queue.entries[appState.queue.currentIndex];
  const overlay = uiState.overlays.at(-1);

  if (tier === "terminal-too-small") {
    return h(Box, { flexDirection: "column" }, () => [
      h(Text, { bold: true }, () => "Queue Home · terminal-too-small"),
      h(Text, () => "Terminal too small · need 60×16 · resize to continue"),
    ]);
  }

  const settings = queueSettings(appState.queue.shuffle, appState.queue.repeatAll, appState.volume);
  const queueWidth = queuePaneWidth(tier, uiState.terminal.columns);
  const visibleRows = Math.max(1, uiState.terminal.rows - (tier === "narrow" ? 4 : 3));
  const start = Math.min(uiState.scrollByPane.queue, Math.max(0, appState.queue.entries.length - visibleRows));
  const entries = appState.queue.entries.slice(start, start + visibleRows);
  const currentState = playingTrackState(current, appState.playback);
  const footer = footerText(tier, uiState.pendingVimChord !== null, uiState.terminal.columns);

  return h(Box, { flexDirection: "column", width: "100%", height: "100%" }, () => [
    h(Box, { flexDirection: "row", justifyContent: "space-between", width: "100%" }, () => [
      h(Text, { bold: true, wrap: "truncate-end" }, () => `Queue · ${appState.queue.entries.length} Tracks`),
      h(Text, { dimColor: true, wrap: "truncate-start" }, () => `Queue Home · ${tier}${tier === "narrow" ? "" : `  ${settings}`}`),
    ]),
    tier === "narrow"
      ? narrowContent(entries, current, currentState, appState.queue.currentIndex, uiState, queueWidth, presentation, settings, start)
      : horizontalContent(entries, current, currentState, appState.queue.currentIndex, uiState, queueWidth, presentation, tier, start),
    h(Text, { dimColor: true, wrap: "truncate-end" }, () => footer),
    overlay ? overlayView(overlay) : null,
  ]);
}

function horizontalContent(
  entries: readonly QueueEntry[],
  current: QueueEntry | undefined,
  state: PlayingTrackState,
  currentIndex: number,
  uiState: PublicationSnapshot["uiState"],
  queueWidth: number,
  presentation: Presentation,
  tier: "wide" | "medium",
  start: number,
) {
  return h(Box, { flexDirection: "row", gap: 2, flexGrow: 1 }, () => [
    queuePane(entries, currentIndex, uiState, queueWidth, presentation, tier, start),
    h(Box, { flexDirection: "column", flexGrow: tier === "wide" ? 2 : 1, flexBasis: 0 }, () => [
      h(Text, { bold: true }, () => "Playing Track"),
      h(Text, { bold: state.kind === "playing", color: state.kind === "unavailable" && presentation.useColor ? "yellow" : undefined, wrap: "truncate-end" }, () => state.headline),
      current?.track.artist ? h(Text, { wrap: "truncate-end" }, () => current.track.artist) : null,
      tier === "wide" && current?.track.album ? h(Text, { wrap: "truncate-end" }, () => current.track.album) : null,
      tier === "wide" && current ? h(Text, { dimColor: true, wrap: "truncate-end" }, () => `${current.track.providerLabel} · ${formatDuration(current.track.durationSeconds)}`) : null,
      state.guidance ? h(Text, { color: state.kind === "unavailable" && presentation.useColor ? "yellow" : undefined, wrap: "truncate-end" }, () => state.guidance) : null,
      state.kind === "unavailable" ? h(Text, { color: presentation.useColor ? "yellow" : undefined }, () => "Retry or choose another Track") : null,
    ]),
  ]);
}

function narrowContent(
  entries: readonly QueueEntry[],
  current: QueueEntry | undefined,
  state: PlayingTrackState,
  currentIndex: number,
  uiState: PublicationSnapshot["uiState"],
  queueWidth: number,
  presentation: Presentation,
  settings: string,
  start: number,
) {
  return h(Box, { flexDirection: "column", flexGrow: 1 }, () => [
    h(Text, { bold: true, color: state.kind === "unavailable" && presentation.useColor ? "yellow" : undefined, wrap: "truncate-end" }, () => current
      ? `Current: ${current.track.title} · ${state.shortLabel} · ${settings}`
      : `Current: No Current Track · ${settings}`),
    queuePane(entries, currentIndex, uiState, queueWidth, presentation, "narrow", start),
    state.kind === "unavailable" ? h(Text, { color: presentation.useColor ? "yellow" : undefined, wrap: "truncate-end" }, () => `${state.guidance} · Retry`) : null,
  ]);
}

function queuePane(
  entries: readonly QueueEntry[],
  currentIndex: number,
  uiState: PublicationSnapshot["uiState"],
  width: number,
  presentation: Presentation,
  tier: "wide" | "medium" | "narrow",
  start: number,
) {
  return h(Box, { flexDirection: "column", flexGrow: tier === "wide" ? 3 : 2, flexBasis: 0, overflow: "hidden" }, () => [
    h(Text, { bold: true }, () => "Queue"),
    entries.length === 0
      ? h(Box, { flexDirection: "column" }, () => [
          h(Text, { bold: true }, () => "Queue is empty"),
          h(Text, () => "/ Global Search"),
          h(Text, () => "o Local music"),
          h(Text, () => "u YouTube URL Download"),
        ])
      : entries.map((entry, visibleIndex) => {
          const index = start + visibleIndex;
          const selected = sameIdentity(entry.track.identity, uiState.selectedQueueIdentity);
          const isCurrent = index === currentIndex;
          const unavailable = entry.availability.status === "unavailable";
          return h(Text, {
            inverse: selected,
            bold: isCurrent,
            color: unavailable && presentation.useColor ? "yellow" : undefined,
            wrap: "truncate-end",
          }, () => formatQueueRow(entry, tier, width, presentation.markers, { selected, current: isCurrent, unavailable }));
        }),
  ]);
}

function formatQueueRow(
  entry: QueueEntry,
  tier: "wide" | "medium" | "narrow",
  width: number,
  markers: Presentation["markers"],
  state: { selected: boolean; current: boolean; unavailable: boolean },
): string {
  const prefix = `${state.selected ? markers.selected : " "} ${state.current ? markers.current : " "} ${state.unavailable ? markers.unavailable : " "} `;
  const duration = formatDuration(entry.track.durationSeconds);
  if (tier === "narrow") {
    const status = state.unavailable ? "Unavailable" : duration;
    return columnLine(prefix, width, [entry.track.title, status], [Math.max(8, width - Bun.stringWidth(prefix) - Bun.stringWidth(status) - 1), Bun.stringWidth(status)]);
  }
  if (state.unavailable) {
    const reason = entry.availability.status === "unavailable" ? entry.availability.reason : "Unavailable";
    const reasonWidth = tier === "wide" ? 26 : 20;
    return columnLine(prefix, width, [entry.track.title, reason], [Math.max(8, width - Bun.stringWidth(prefix) - reasonWidth - 1), reasonWidth]);
  }
  if (tier === "medium") {
    return columnLine(prefix, width, [entry.track.title, entry.track.artist ?? "Unknown Artist", duration], [Math.max(8, width - Bun.stringWidth(prefix) - 20), 13, 5]);
  }
  return columnLine(prefix, width, [entry.track.title, entry.track.artist ?? "Unknown Artist", entry.track.providerLabel, duration], [Math.max(8, width - Bun.stringWidth(prefix) - 32), 13, 10, 5]);
}

function columnLine(prefix: string, width: number, values: readonly string[], widths: readonly number[]): string {
  const columns = values.map((value, index) => padCell(truncateCell(value, widths[index] ?? 1), widths[index] ?? 1));
  return truncateCell(`${prefix}${columns.join(" ")}`.trimEnd(), width);
}

function truncateCell(value: string, width: number): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(value) <= width) return value;
  if (width === 1) return "…";
  let result = "";
  for (const character of value) {
    if (Bun.stringWidth(result + character) > width - 1) break;
    result += character;
  }
  return `${result}…`;
}

function padCell(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - Bun.stringWidth(value)))}`;
}

type PlayingTrackState = { kind: "empty" | "playing" | "paused" | "stopped" | "restored" | "unavailable"; headline: string; shortLabel: string; guidance: string };

function playingTrackState(current: QueueEntry | undefined, playback: PublicationSnapshot["appState"]["playback"]): PlayingTrackState {
  if (!current) return { kind: "empty", headline: "No Current Track", shortLabel: "Idle", guidance: "Choose a Track to begin" };
  if (current.availability.status === "unavailable" || playback.status === "error") {
    const reason = current.availability.status === "unavailable"
      ? current.availability.reason
      : playback.message ?? "Playback failed";
    return { kind: "unavailable", headline: `Unavailable · ${current.track.title}`, shortLabel: "Unavailable", guidance: reason };
  }
  if (playback.status === "playing") return { kind: "playing", headline: `Playing · ${current.track.title}`, shortLabel: "Playing", guidance: "" };
  if (playback.status === "stopped") return { kind: "stopped", headline: `Stopped · starts from beginning`, shortLabel: "Stopped", guidance: "Space to Play from the beginning" };
  if (playback.status === "paused" && (playback.positionSeconds ?? 0) > 0) {
    const position = formatDuration(playback.positionSeconds ?? 0);
    return { kind: "restored", headline: `Restored · Resume from ${position}`, shortLabel: `Resume ${position}`, guidance: "Space to Resume" };
  }
  if (playback.status === "paused") return { kind: "paused", headline: "Paused · Space to Resume", shortLabel: "Paused", guidance: "Resume keeps the current position" };
  return { kind: "stopped", headline: `Stopped · starts from beginning`, shortLabel: "Stopped", guidance: "Space to Play from the beginning" };
}

function queuePaneWidth(tier: ResponsiveTier, columns: number): number {
  if (tier === "narrow") return columns;
  const usable = Math.max(1, columns - 2);
  return tier === "wide" ? Math.floor(usable * 0.6) : Math.floor(usable * (2 / 3));
}

function queueSettings(shuffle: boolean, repeatAll: boolean, volume: PublicationSnapshot["appState"]["volume"]): string {
  return `Shuffle ${shuffle ? "On" : "Off"} · Repeat ${repeatAll ? "All" : "Off"} · Vol ${volume.ready ? `${volume.percent}%` : "—"}`;
}

function footerText(tier: ResponsiveTier, pendingG: boolean, columns: number): string {
  if (pendingG) return truncateCell("g… Go to first  ? Help  : Commands", columns);
  const text = tier === "narrow"
    ? "Space Play/Resume  ? Help  : Commands"
    : tier === "medium"
      ? "Space Play/Pause/Resume  Enter Play Next  o Music  ? Help  : Commands"
      : "Space Play/Pause/Resume  Enter Play Next  x Remove  o Music  ? Help  : Commands  q Quit";
  return truncateCell(text, columns);
}

function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const rounded = Math.floor(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function overlayView(overlay: PickerOverlay) {
  return h(Box, { flexDirection: "column", borderStyle: "single", paddingX: 1 }, () => [
    h(Text, { bold: true }, () => `Picker Overlay · ${overlay.kind}`),
    h(Text, () => `Focus: ${overlay.focus}`),
    h(Text, () => "Exclusive input · q/Esc dismisses"),
  ]);
}

function pickerOverlay(searchFocused: boolean): Omit<PickerOverlay, "returnTo"> {
  return {
    kind: "music-picker",
    focus: searchFocused ? "search" : "results",
    query: "",
    selectedIdentity: null,
    scroll: 0,
  };
}

function simpleOverlay(kind: "shortcut-help" | "command-palette"): Omit<PickerOverlay, "returnTo"> {
  return { kind, focus: "search", query: "", selectedIdentity: null, scroll: 0 };
}

function terminalKey(input: string, key: {
  ctrl: boolean; escape: boolean; return: boolean; upArrow: boolean; downArrow: boolean;
  home: boolean; end: boolean; pageUp: boolean; pageDown: boolean;
}): string {
  if (key.ctrl && input === "c") return "\u0003";
  if (key.ctrl && input === "d") return "\x04";
  if (key.ctrl && input === "u") return "\x15";
  if (key.escape) return "\x1b";
  if (key.return) return "\r";
  if (key.upArrow) return "\x1b[A";
  if (key.downArrow) return "\x1b[B";
  if (key.home) return "\x1b[H";
  if (key.end) return "\x1b[F";
  if (key.pageUp) return "\x1b[5~";
  if (key.pageDown) return "\x1b[6~";
  return input;
}

function publicationCause(reason: AppStateChangeReason): PublicationCause {
  return reason === "playback" ? "playback" : "state";
}
