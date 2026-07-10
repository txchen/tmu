import { Box, Text, useApp, useInput, useWindowSize } from "@vue-tui/runtime";
import { defineComponent, h, onScopeDispose, shallowRef, watch } from "vue";
import {
  createActionRegistry,
  footerActions,
  type ActionRegistry,
  type ResolvedAction,
} from "../action-registry";
import type { AppCoordinator, AppStateChangeReason } from "../coordinator";
import { isRestoredPlayback, sameIdentity, type PickerOverlay, type QueueEntry, type ResponsiveTier } from "../domain";
import { RootInputRouter } from "../input-router";
import { queueHomeVisibleRows, selectedUnavailableQueueEntry } from "../ui-state";
import { dispatchTerminalResize } from "./resize";
import { overlayContentRows, overlayGeometry } from "../provider-navigation";
import { globalSearchRows, type GlobalSearchRow } from "../global-search";
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
  const registry = createActionRegistry();
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
        registry,
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
        const hadBlockingLayer = coordinator.uiState.overlays.length > 0
          || coordinator.uiState.pendingConfirmation !== null;
        await router.route(key);
        publication.notify("input");
        if (key === "\u0003" || (key === "q" && !hadBlockingLayer)) app.exit();
      }

      onScopeDispose(() => {
        router.cancelPendingSequence();
        unsubscribeCoordinator();
        unsubscribePublication();
        publication.stop();
      });

      return () => renderTmu(snapshot.value, presentation, registry);
    },
  });
}

type Presentation = {
  markers: { selected: string; current: string; unavailable: string };
  useColor: boolean;
  dimmed: boolean;
};

function createPresentation(options: TmuRootOptions): Presentation {
  const measure = options.measureCellWidth ?? Bun.stringWidth;
  const unicode = ["›", "●", "!"].every((marker) => measure(marker) === 1);
  return {
    markers: unicode
      ? { selected: "›", current: "●", unavailable: "!" }
      : { selected: ">", current: "*", unavailable: "!" },
    useColor: !(options.noColor ?? process.env.NO_COLOR !== undefined),
    dimmed: false,
  };
}

function renderTmu(snapshot: PublicationSnapshot, presentation: Presentation, registry: ActionRegistry) {
  const { appState, uiState } = snapshot;
  const tier = uiState.terminal.tier;
  const current = appState.queue.entries[appState.queue.currentIndex];
  const overlay = uiState.overlays.at(-1);
  const underlyingPresentation = { ...presentation, dimmed: Boolean(overlay) };

  if (tier === "terminal-too-small") {
    return h(Box, { flexDirection: "column" }, () => [
      h(Text, { bold: true }, () => "Terminal too small"),
      h(Text, () => "Need 60×16 · state preserved · resize to continue"),
    ]);
  }

  const settings = queueSettings(appState.queue.shuffle, appState.queue.repeatAll, appState.volume);
  const queueWidth = queuePaneWidth(tier, uiState.terminal.columns);
  const selectedEntry = selectedUnavailableQueueEntry(appState.queue.entries, uiState.selectedQueueIdentity);
  const exceptionalGuidance = selectedEntry?.availability.status === "unavailable"
    ? `${selectedEntry.availability.reason} · Retry`
    : "";
  const visibleRows = queueHomeVisibleRows(tier, uiState.terminal.rows, exceptionalGuidance.length > 0);
  const start = Math.min(uiState.scrollByPane.queue, Math.max(0, appState.queue.entries.length - visibleRows));
  const entries = appState.queue.entries.slice(start, start + visibleRows);
  const currentState = playingTrackState(current, appState.playback);
  const footer = footerText(
    tier,
    uiState.pendingVimChord !== null,
    uiState.terminal.columns,
    footerActions(registry, {
      appState,
      uiState,
      selectedProviderId: overlay?.kind === "music-picker"
        ? snapshot.providerNavigationRows[overlay.selectedResultIndex ?? 0]?.providerId ?? overlay.providerLocation?.providerId
        : null,
    }),
  );

  return h(Box, {
    flexDirection: "column",
    width: uiState.terminal.columns,
    height: uiState.terminal.rows,
    position: "relative",
  }, () => [
    h(Box, { flexDirection: "row", justifyContent: "space-between", width: "100%" }, () => [
      h(Text, { bold: true, dimColor: Boolean(overlay), wrap: "truncate-end" }, () => `Queue · ${appState.queue.entries.length} Tracks`),
      tier === "narrow" ? null : h(Text, { dimColor: true, wrap: "truncate-start" }, () => settings),
    ]),
    tier === "narrow"
      ? narrowContent(entries, current, currentState, appState.queue.currentIndex, uiState, queueWidth, underlyingPresentation, settings, start, exceptionalGuidance)
      : horizontalContent(entries, current, currentState, appState.queue.currentIndex, uiState, queueWidth, underlyingPresentation, tier, start),
    h(Text, { dimColor: true, wrap: "truncate-end" }, () => footer),
    overlay ? overlayView(overlay, snapshot, tier, uiState.terminal.columns, uiState.terminal.rows) : null,
    uiState.pendingConfirmation ? confirmationView(uiState.pendingConfirmation.choice) : null,
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
      h(Text, { bold: true, dimColor: presentation.dimmed }, () => "Playing Track"),
      h(Text, { bold: state.kind === "playing", dimColor: presentation.dimmed, color: state.kind === "unavailable" && presentation.useColor ? "yellow" : undefined, wrap: "truncate-end" }, () => state.headline),
      current?.track.artist ? h(Text, { dimColor: presentation.dimmed, wrap: "truncate-end" }, () => current.track.artist) : null,
      tier === "wide" && current?.track.album ? h(Text, { dimColor: presentation.dimmed, wrap: "truncate-end" }, () => current.track.album) : null,
      tier === "wide" && current ? h(Text, { dimColor: true, wrap: "truncate-end" }, () => `${current.track.providerLabel} · ${formatDuration(current.track.durationSeconds)}`) : null,
      state.guidance ? h(Text, { dimColor: presentation.dimmed, color: state.kind === "unavailable" && presentation.useColor ? "yellow" : undefined, wrap: "truncate-end" }, () => state.guidance) : null,
      state.kind === "unavailable" ? h(Text, { dimColor: presentation.dimmed, color: presentation.useColor ? "yellow" : undefined }, () => "Retry or choose another Track") : null,
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
  exceptionalGuidance: string,
) {
  return h(Box, { flexDirection: "column", flexGrow: 1 }, () => [
    h(Text, { bold: true, dimColor: presentation.dimmed, color: state.kind === "unavailable" && presentation.useColor ? "yellow" : undefined, wrap: "truncate-end" }, () => current
      ? `Current: ${current.track.title} · ${state.shortLabel} · ${settings}`
      : `Current: No Current Track · ${settings}`),
    queuePane(entries, currentIndex, uiState, queueWidth, presentation, "narrow", start),
    exceptionalGuidance ? h(Text, { dimColor: presentation.dimmed, color: presentation.useColor ? "yellow" : undefined, wrap: "truncate-end" }, () => exceptionalGuidance) : null,
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
    h(Text, { bold: true, dimColor: presentation.dimmed }, () => "Queue"),
    entries.length === 0
      ? h(Box, { flexDirection: "column" }, () => [
          h(Text, { bold: true, dimColor: presentation.dimmed }, () => "Queue is empty"),
          h(Text, { dimColor: presentation.dimmed }, () => "/ Global Search"),
          h(Text, { dimColor: presentation.dimmed }, () => "o Local music"),
          h(Text, { dimColor: presentation.dimmed }, () => "u YouTube URL Download"),
        ])
      : entries.map((entry, visibleIndex) => {
          const index = start + visibleIndex;
          const selected = sameIdentity(entry.track.identity, uiState.selectedQueueIdentity);
          const isCurrent = index === currentIndex;
          const unavailable = entry.availability.status === "unavailable";
          return h(Text, {
            inverse: selected,
            dimColor: presentation.dimmed,
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
  if (isRestoredPlayback(playback)) {
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

function footerText(
  tier: ResponsiveTier,
  pendingG: boolean,
  columns: number,
  actions: readonly ResolvedAction[],
): string {
  if (pendingG) {
    const discovery = actions.filter((action) => action.enabled
      && (action.id === "help.open" || action.id === "palette.open"));
    return truncateCell(["g… Go to first", ...discovery.map(formatFooterAction)].join("  "), columns);
  }
  const tierIds = tier === "narrow"
    ? ["player.toggle-play-pause", "help.open", "palette.open"]
    : tier === "medium"
      ? ["player.toggle-play-pause", "queue.play-next", "picker.open-navigation", "help.open", "palette.open"]
      : ["player.toggle-play-pause", "queue.play-next", "queue.remove", "picker.open-navigation", "help.open", "palette.open"];
  const enabled = new Map(actions.filter((action) => action.enabled).map((action) => [action.id, action]));
  return truncateCell(tierIds.flatMap((id) => {
    const action = enabled.get(id);
    return action ? [formatFooterAction(action)] : [];
  }).join("  "), columns);
}

function formatFooterAction(action: ResolvedAction): string {
  const label = action.name.replaceAll(" / ", "/");
  return `${action.bindings[0] ?? ""} ${label}`.trim();
}

function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const rounded = Math.floor(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function overlayView(
  overlay: PickerOverlay,
  snapshot: PublicationSnapshot,
  tier: ResponsiveTier,
  columns: number,
  terminalRows: number,
) {
  const searchActive = overlay.kind === "music-picker" && Boolean(snapshot.appState.globalSearch.query);
  const rows = searchActive
    ? globalSearchRows(snapshot.appState.globalSearch)
    : snapshot.providerNavigationRows;
  const geometry = overlayGeometry(overlay.kind, tier, columns, terminalRows);
  const contentRows = overlayContentRows(overlay.kind, tier, columns, terminalRows);
  const visibleRows = overlay.kind === "music-picker"
    ? rows.slice(overlay.scroll, overlay.scroll + contentRows)
    : [];
  const location = overlay.providerLocation?.providerId
    ? `${overlay.providerLocation.providerId}${overlay.providerLocation.path.length ? ` · ${overlay.providerLocation.path.at(-1)}` : ""}`
    : "Providers";
  return h(Box, {
    flexDirection: "column",
    borderStyle: "single",
    paddingX: 1,
    width: geometry.width,
    height: geometry.height,
    position: "absolute",
    left: Math.max(0, Math.floor((columns - geometry.width) / 2)),
    top: Math.max(0, Math.floor((terminalRows - geometry.height) / 2)),
  }, () => [
    h(Text, { bold: true }, () => `Picker Overlay · ${overlay.kind}`),
    overlay.kind === "music-picker" ? h(Text, () => `${overlay.focus === "search" ? ">" : " "} Search: ${overlay.query}`) : null,
    overlay.kind === "music-picker" ? h(Text, { inverse: overlay.focus === "filter", dimColor: overlay.focus !== "filter" }, () =>
      `Filters: Provider ${overlay.providerFilter ?? "all"} · Type ${overlay.resultTypeFilter ?? "all"}`) : null,
    overlay.kind === "music-picker" ? h(Text, { dimColor: true }, () => location) : null,
    overlay.kind === "music-picker" && overlay.message
      ? h(Text, { wrap: "truncate-end" }, () => `! ${overlay.message}`)
      : null,
    ...visibleRows.map((row, visibleIndex) => {
      const index = overlay.scroll + visibleIndex;
      const selected = index === (overlay.selectedResultIndex ?? 0);
      if (searchActive) return globalSearchRowView(row as GlobalSearchRow, selected);
      const navigationRow = row as PublicationSnapshot["providerNavigationRows"][number];
      const suffix = navigationRow.detail ? ` · ${navigationRow.detail}` : "";
      return h(Text, { inverse: selected, wrap: "truncate-end" }, () => `${selected ? "›" : " "} ${navigationRow.label}${suffix}`);
    }),
    overlay.kind === "music-picker" && rows.length === 0
      ? h(Text, { dimColor: true }, () => "No Tracks or navigation entries")
      : null,
    h(Text, { dimColor: true }, () => overlay.focus === "results"
      ? searchActive ? "j/k move · Enter Play Next · l/→ open · r Retry · / edit · Esc dismiss" : "j/k move · l/→ open · h/← back · / search · Esc dismiss"
      : overlay.focus === "filter" ? "p Provider · t Type · Enter/Tab search" : "Enter submit · Tab filters · Esc results · Ctrl-w word · Ctrl-u clear"),
  ]);
}

function globalSearchRowView(row: GlobalSearchRow, selected: boolean) {
  if (row.kind === "type-heading") return h(Text, { bold: true }, () => row.label);
  if (row.kind === "provider-heading") return h(Text, { bold: true, inverse: selected }, () => `${selected ? "› " : "  "}${row.label}`);
  if (row.kind === "provider-status") {
    const status = row.state.status === "loading" ? "Loading"
      : row.state.status === "empty" ? "No results"
      : row.state.status === "auth" ? "Authentication failed"
      : row.state.status === "offline" ? "Offline"
      : "Failed";
    const retry = " · Retry";
    return h(Text, { inverse: selected, wrap: "truncate-end" }, () =>
      `${selected ? "› " : "  "}${row.label} · ${status}${row.state.message ? `: ${row.state.message}` : ""}${retry}`);
  }
  return h(Text, { inverse: selected, wrap: "truncate-end" }, () =>
    `${selected ? "› " : "  "}${row.result.label} · ${row.result.providerLabel}${row.result.detail ? ` · ${row.result.detail}` : ""}`);
}

function confirmationView(choice: "cancel" | "confirm") {
  return h(Box, { flexDirection: "column", borderStyle: "single", paddingX: 1 }, () => [
    h(Text, { bold: true }, () => "Clear Queue?"),
    h(Text, () => "Stop playback, clear Current Track, and remove every Track."),
    h(Text, { inverse: choice === "cancel" }, () => choice === "cancel" ? "[Cancel]  Clear" : "Cancel  [Clear]"),
    h(Text, { dimColor: true }, () => "h/l or ←/→ · Tab changes · Enter activates · y yes · n/Esc/q cancel"),
  ]);
}

function terminalKey(input: string, key: {
  ctrl: boolean; shift: boolean; escape: boolean; return: boolean; upArrow: boolean; downArrow: boolean;
  leftArrow: boolean; rightArrow: boolean; home: boolean; end: boolean; pageUp: boolean; pageDown: boolean;
  tab: boolean; delete: boolean;
}): string {
  if (key.ctrl && input === "c") return "\u0003";
  if (key.ctrl && input === "d") return "\x04";
  if (key.ctrl && input === "u") return "\x15";
  if (key.escape) return "\x1b";
  if (key.return && key.shift) return "\x1b[13;2u";
  if (key.return) return "\r";
  if (key.upArrow) return "\x1b[A";
  if (key.downArrow) return "\x1b[B";
  if (key.rightArrow) return "\x1b[C";
  if (key.leftArrow) return "\x1b[D";
  if (key.home) return "\x1b[H";
  if (key.end) return "\x1b[F";
  if (key.pageUp) return "\x1b[5~";
  if (key.pageDown) return "\x1b[6~";
  if (key.tab) return "\t";
  if (key.delete) return input === "\x7f" || input === "\b" ? input : "\x1b[3~";
  return input;
}

function publicationCause(reason: AppStateChangeReason): PublicationCause {
  return reason === "playback" ? "playback" : "state";
}
