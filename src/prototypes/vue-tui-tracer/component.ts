import { Box, Text, useApp, useInput, useWindowSize } from "@vue-tui/runtime";
import { defineComponent, h, onScopeDispose, shallowRef, watch } from "vue";
import { createActionRegistry } from "../../action-registry";
import type { AppCoordinator, AppStateChangeReason } from "../../coordinator";
import { sameIdentity, type PickerOverlay, type ResponsiveTier } from "../../domain";
import { RootInputRouter } from "../../input-router";
import {
  StatePublicationGate,
  type PublicationCause,
  type PublicationSnapshot,
} from "../../state-publication";

export type VueTuiTracerOptions = {
  coordinator: AppCoordinator;
};

/**
 * Development-only compatibility tracer. Production startup deliberately does
 * not import this module; the #49 cutover will own the real component tree.
 */
export function createVueTuiTracer(options: VueTuiTracerOptions) {
  return defineComponent({
    name: "DevelopmentVueTuiTracer",
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
        coordinator.dispatchUi({
          type: "resize",
          columns: nextColumns,
          rows: nextRows,
          queueIdentities: coordinator.queueTrackIdentities(),
          visibleQueueRows: visibleQueueRows(nextRows),
        });
        publication.notify("resize");
      }, { immediate: true });

      useInput((input, key) => {
        const routedKey = key.ctrl && input === "c"
          ? "\u0003"
          : key.escape
            ? "\x1b"
            : key.return
              ? "\r"
              : input;
        void routeInput(routedKey);
      });

      async function routeInput(key: string): Promise<void> {
        const hadOverlay = coordinator.uiState.overlays.length > 0;
        if (!hadOverlay && (key === "o" || key === "/")) {
          coordinator.dispatchUi({
            type: "openOverlay",
            overlay: pickerOverlay(key === "/"),
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
        void coordinator.teardown();
      });

      return () => renderTracer(snapshot.value);
    },
  });
}

function renderTracer(snapshot: PublicationSnapshot) {
  const { appState, uiState } = snapshot;
  const tier = uiState.terminal.tier;
  const current = appState.queue.entries[appState.queue.currentIndex];
  const overlay = uiState.overlays.at(-1);

  if (tier === "terminal-too-small") {
    return h(Box, { flexDirection: "column" }, () => [
      h(Text, { bold: true }, () => "Queue Home · terminal-too-small"),
      h(Text, () => "Terminal too small — state preserved"),
      current ? h(Text, () => `Current Track: ${current.track.title}`) : null,
      overlay ? overlayView(overlay) : null,
    ]);
  }

  return h(Box, { flexDirection: "column", width: "100%" }, () => [
    h(Text, { bold: true }, () => `Queue Home · ${tier}`),
    h(Box, { flexDirection: tier === "narrow" ? "column" : "row", gap: 2 }, () => [
      h(Box, { flexDirection: "column", flexGrow: 3 }, () => [
        h(Text, { bold: true }, () => "Queue"),
        ...appState.queue.entries.map((entry, index) => h(Text, {
          inverse: sameIdentity(entry.track.identity, uiState.selectedQueueIdentity),
        }, () => `${index === appState.queue.currentIndex ? "▶" : " "} ${entry.track.title} [${entry.track.identity.providerId}:${entry.track.identity.stableId}]`)),
      ]),
      h(Box, { flexDirection: "column", flexGrow: 2 }, () => [
        h(Text, { bold: true }, () => "Playing Track"),
        h(Text, () => current?.track.title ?? "No Current Track"),
        h(Text, () => playbackLabel(appState.playback.status, Boolean(current))),
      ]),
    ]),
    h(Text, { dimColor: true }, () => "o Picker  Space Play/Pause/Resume  q Quit"),
    overlay ? overlayView(overlay) : null,
  ]);
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

function playbackLabel(status: PublicationSnapshot["appState"]["playback"]["status"], hasCurrent: boolean): string {
  if (!hasCurrent) return "Idle";
  if (status === "playing") return "Playing";
  if (status === "paused") return "Restored — Space to Resume";
  if (status === "stopped") return "Stopped — Space to Play";
  if (status === "error") return "Unavailable";
  return "Idle";
}

function publicationCause(reason: AppStateChangeReason): PublicationCause {
  return reason === "playback" ? "playback" : "state";
}

function visibleQueueRows(rows: number): number {
  return Math.max(1, rows - 5);
}
