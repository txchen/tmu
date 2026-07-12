import { Box, Spacer, Text, useApp, useInput, useWindowSize } from "@vue-tui/runtime";
import { defineComponent, h, onScopeDispose, shallowRef, watch } from "vue";
import type { AppCoordinator, AppStateChangeReason } from "../coordinator";
import type { UiState } from "../domain";
import {
  StatePublicationGate,
  type PublicationCause,
  type PublicationSnapshot,
  type PublicationTimers,
} from "../state-publication";
import { dispatchTerminalResize } from "./resize";
import { isYouTubeCacheProvider, type IncompleteYouTubeCacheEntry, type YouTubeCacheEntry } from "../youtube-cache";
import {
  activateConfirmation,
  activeConfirmation,
  matchingConfirmationChoice,
  type ConfirmationDescriptor,
} from "./confirmation";

export type TmuRootOptions = {
  coordinator: AppCoordinator;
  measureCellWidth?: (value: string) => number;
  noColor?: boolean;
  publicationTimers?: Partial<PublicationTimers>;
};

export function createTmuRoot(options: TmuRootOptions) {
  return defineComponent({
    name: "TmuRoot",
    setup() {
      const { coordinator } = options;
      coordinator.dispatchUi({
        type: "syncQueue",
        identities: coordinator.queueTrackIdentities(),
      });
      const existingError = coordinator.appState.appErrors.at(-1);
      if (existingError && !coordinator.uiState.notification) {
        coordinator.dispatchUi({
          type: "setNotification",
          notification: { level: "error", message: existingError },
        });
      }
      const cadence = coordinator.appState.config.lowPower;
      const publication = new StatePublicationGate({
        readState: () => ({ appState: coordinator.appState, uiState: coordinator.uiState }),
        cadence: {
          playbackCadenceMs: cadence.playbackProgressMs,
          downloadProgressMs: cadence.downloadProgressThrottleMs,
          providerProgressMs: cadence.libraryProgressThrottleMs,
        },
        timers: options.publicationTimers,
      });
      const snapshot = shallowRef(publication.publishInitial());
      const unsubscribePublication = publication.subscribe((next) => { snapshot.value = next; });
      let notificationTimer: ReturnType<typeof setTimeout> | undefined;
      let observedFeedbackRevision = coordinator.appState.operationFeedback?.revision ?? 0;
      let observedErrorCount = coordinator.appState.appErrors.length;
      let handledAcceptedSubmissionId: number | undefined;
      const unsubscribeCoordinator = coordinator.onStateChange((reason) => {
        const accepted = coordinator.appState.downloads.acceptedSubmission;
        if (accepted && accepted.id !== handledAcceptedSubmissionId) {
          handledAcceptedSubmissionId = accepted.id;
          if (coordinator.uiState.downloader.urlInput.trim() === accepted.input.trim()) {
            coordinator.dispatchUi({ type: "setDownloaderInput", value: "" });
          }
          void coordinator.dispatch({
            type: "downloadOperation",
            operation: "acknowledge-accepted",
            submissionId: accepted.id,
          });
        }
        const feedback = coordinator.appState.operationFeedback;
        const newError = coordinator.appState.appErrors.length > observedErrorCount
          ? coordinator.appState.appErrors.at(-1)
          : undefined;
        observedErrorCount = coordinator.appState.appErrors.length;
        if ((feedback && feedback.revision !== observedFeedbackRevision) || newError) {
          if (feedback) observedFeedbackRevision = feedback.revision;
          const source = newError ? { level: "error" as const, message: newError } : feedback!;
          const notification = {
            level: source.level,
            message: source.message,
            ...(source.level === "success" ? { expiresAtMs: Date.now() + 2_500 } : {}),
          };
          if (notificationTimer) clearTimeout(notificationTimer);
          coordinator.dispatchUi({ type: "setNotification", notification });
          if (notification.expiresAtMs) notificationTimer = setTimeout(() => {
            if (coordinator.uiState.notification?.message === notification.message) {
              coordinator.dispatchUi({ type: "dismissNotification" });
            }
          }, Math.max(0, notification.expiresAtMs - Date.now()));
        }
        publication.notify(publicationCause(reason));
      });
      const app = useApp();
      const { columns, rows } = useWindowSize();
      watch([columns, rows], ([nextColumns, nextRows]) => {
        dispatchTerminalResize(coordinator, nextColumns, nextRows);
        publication.notify("resize");
      }, { immediate: true });

      useInput((input, key) => {
        void routeInput(input, key);
      });

      async function routeInput(input: string, key: InputKey): Promise<void> {
        const ui = coordinator.uiState;
        if (ui.terminal.tier === "terminal-too-small" && !(key.ctrl && input === "c")) return;
        const confirmation = activeConfirmation(coordinator);
        if (confirmation) {
          const selected = matchingConfirmationChoice(ui, confirmation);
          if (key.leftArrow || key.rightArrow || key.tab) {
            coordinator.dispatchUi({
              type: "requestConfirmation", kind: confirmation.kind,
              ...(confirmation.batchId === undefined ? {} : { batchId: confirmation.batchId }),
              ...(confirmation.target === undefined ? {} : { target: confirmation.target }),
            });
            coordinator.dispatchUi({ type: "setConfirmationChoice", choice: selected === "cancel" ? "confirm" : "cancel" });
          } else if (input === "y" || (key.return && selected === "confirm")) {
            await activateConfirmation(confirmation, true, coordinator);
            coordinator.dispatchUi({ type: "cancelConfirmation" });
            if (confirmation.kind === "quit-downloads") app.exit();
          } else if (input === "n" || key.escape || (key.return && selected === "cancel")) {
            await activateConfirmation(confirmation, false, coordinator);
            coordinator.dispatchUi({ type: "cancelConfirmation" });
          }
          publication.notify("input");
          return;
        }
        if (ui.overlays.length > 0) {
          if (key.escape || input === "?") coordinator.dispatchUi({ type: "dismissOverlay" });
          publication.notify("input");
          return;
        }
        if (key.escape && ui.notification) {
          coordinator.dispatchUi({ type: "dismissNotification" });
          publication.notify("input");
          return;
        }
        const textInputFocused = ui.activeTab === "library"
          ? ui.library.inputFocused
          : ui.activeTab === "downloader" && ui.downloader.inputFocused;
        if (input === "]" || input === "[") {
          coordinator.dispatchUi({ type: "switchTab", tab: adjacentTab(ui.activeTab, input === "]" ? 1 : -1) });
          publication.notify("input");
          return;
        }
        if (!textInputFocused && input === "?") {
          coordinator.dispatchUi({ type: "openOverlay", kind: "shortcut-help" });
          publication.notify("input");
          return;
        }
        if ((key.ctrl && input === "c") || (input === "q" && !textInputFocused)) {
          await coordinator.dispatch({ type: "playerOperation", operation: "quit" });
          if (!coordinator.appState.downloads.quitConfirmationRequired) app.exit();
          return;
        }
        if (key.tab) {
          if (ui.activeTab === "library") coordinator.dispatchUi({ type: "setLibraryInputFocus", focused: !ui.library.inputFocused });
          else if (ui.activeTab === "downloader") coordinator.dispatchUi({ type: "setDownloaderInputFocus", focused: !ui.downloader.inputFocused });
        }
        else if (input === " " && !textInputFocused) {
          await coordinator.dispatch({ type: "playerOperation", operation: "toggle-play-pause" });
        } else if (!textInputFocused && await routeGlobalPlayback(input, key, coordinator)) {
          // Global playback action handled before tab-local routing.
        } else if (ui.activeTab === "playback") {
          await routePlayback(input, key, coordinator);
        } else if (ui.activeTab === "library") {
          await routeLibrary(input, key, coordinator);
        } else {
          await routeDownloader(input, key, coordinator);
        }
        publication.notify("input");
      }

      onScopeDispose(() => {
        if (notificationTimer) clearTimeout(notificationTimer);
        unsubscribeCoordinator();
        unsubscribePublication();
        publication.stop();
      });

      return () => render(snapshot.value, coordinator, options.noColor ?? process.env.NO_COLOR !== undefined);
    },
  });
}

async function routeGlobalPlayback(
  input: string,
  key: InputKey,
  coordinator: AppCoordinator,
): Promise<boolean> {
  if (input === "n") await coordinator.dispatch({ type: "playerOperation", operation: "next-track" });
  else if (input === "p") await coordinator.dispatch({ type: "playerOperation", operation: "previous-track" });
  else if (input === "s") await coordinator.dispatch({ type: "playerOperation", operation: "stop" });
  else if (input === "h" || key.leftArrow) await coordinator.dispatch({ type: "playerOperation", operation: "seek", seconds: -5 });
  else if (input === "l" || key.rightArrow) await coordinator.dispatch({ type: "playerOperation", operation: "seek", seconds: 5 });
  else if (input === "+") await coordinator.dispatch({ type: "playerOperation", operation: "adjust-volume", delta: 5 });
  else if (input === "-") await coordinator.dispatch({ type: "playerOperation", operation: "adjust-volume", delta: -5 });
  else if (input === "Z") await coordinator.dispatch({ type: "playerOperation", operation: "randomize-queue" });
  else if (input === "r") await coordinator.dispatch({ type: "playerOperation", operation: "toggle-repeat-all" });
  else return false;
  return true;
}

async function routePlayback(
  input: string,
  key: InputKey,
  coordinator: AppCoordinator,
): Promise<void> {
  const identities = coordinator.queueTrackIdentities();
  const jump = listJump(input, key, chordPending(coordinator.uiState), identities.length, coordinator.uiState.selectedQueueIndex);
  if (jump.pending !== undefined) coordinator.dispatchUi({ type: "setPendingVimChord", pending: jump.pending });
  if (jump.index !== undefined) {
    coordinator.dispatchUi({ type: "selectQueue", index: jump.index, identities });
  } else if (input === "j" || key.downArrow) {
    coordinator.dispatchUi({
      type: "selectQueue",
      index: coordinator.uiState.selectedQueueIndex + 1,
      identities,
    });
  } else if (input === "k" || key.upArrow) {
    coordinator.dispatchUi({
      type: "selectQueue",
      index: coordinator.uiState.selectedQueueIndex - 1,
      identities,
    });
  } else if (key.return) {
    const selected = coordinator.appState.queue.entries[coordinator.uiState.selectedQueueIndex];
    if (selected) await coordinator.dispatch({ type: "playSelected", identity: selected.track.identity });
  } else if (input === "N") {
    const selected = coordinator.appState.queue.entries[coordinator.uiState.selectedQueueIndex];
    if (selected) await coordinator.dispatch({ type: "playNext", target: selected.track });
  } else if (input === "x") {
    const selected = coordinator.appState.queue.entries[coordinator.uiState.selectedQueueIndex];
    if (selected) await coordinator.dispatch({ type: "removeQueueTrack", identity: selected.track.identity });
  } else if (input === "J" || input === "K") {
    const selected = coordinator.appState.queue.entries[coordinator.uiState.selectedQueueIndex];
    if (selected) await coordinator.dispatch({
      type: "moveQueueTrack",
      identity: selected.track.identity,
      delta: input === "J" ? 1 : -1,
    });
  } else if (input === "C") coordinator.dispatchUi({ type: "requestConfirmation", kind: "clear-queue" });
}

async function routeLibrary(
  input: string,
  key: InputKey,
  coordinator: AppCoordinator,
): Promise<void> {
  const provider = coordinator.appState.providers["youtube-cache"];
  const results = libraryResults(provider, coordinator.uiState.library.query);
  const jump = listJump(input, key, chordPending(coordinator.uiState), results.length, coordinator.uiState.library.selectedIndex);
  if (!coordinator.uiState.library.inputFocused && jump.pending !== undefined) coordinator.dispatchUi({ type: "setPendingVimChord", pending: jump.pending });
  if (!coordinator.uiState.library.inputFocused && jump.index !== undefined) {
    coordinator.dispatchUi({ type: "setLibrarySelection", index: jump.index, resultCount: results.length });
  } else if (key.escape) {
    coordinator.dispatchUi({ type: "setLibraryInputFocus", focused: false });
  } else if (!coordinator.uiState.library.inputFocused && input === "/") {
    coordinator.dispatchUi({ type: "setLibraryInputFocus", focused: true });
  } else if (!coordinator.uiState.library.inputFocused && (input === "j" || key.downArrow)) {
    coordinator.dispatchUi({
      type: "setLibrarySelection",
      index: coordinator.uiState.library.selectedIndex + 1,
      resultCount: results.length,
    });
  } else if (!coordinator.uiState.library.inputFocused && (input === "k" || key.upArrow)) {
    coordinator.dispatchUi({
      type: "setLibrarySelection",
      index: coordinator.uiState.library.selectedIndex - 1,
      resultCount: results.length,
    });
  } else if (!coordinator.uiState.library.inputFocused && (input === "N" || input === "a")) {
    const result = results[coordinator.uiState.library.selectedIndex];
    if (result?.kind === "track") await coordinator.dispatch({
      type: input === "N" ? "playNext" : "addToQueue",
      target: result.track,
    });
  } else if (!coordinator.uiState.library.inputFocused && input === "d") {
    const result = results[coordinator.uiState.library.selectedIndex];
    if (result?.kind === "track") await coordinator.dispatch({ type: "cacheOperation", operation: "request-delete", identity: result.track.identity });
    else if (result) await coordinator.dispatch({ type: "cacheOperation", operation: "request-cleanup", stem: result.entry.stem });
  } else if (key.return && coordinator.uiState.library.inputFocused) {
    coordinator.dispatchUi({ type: "setLibraryInputFocus", focused: false });
    coordinator.dispatchUi({ type: "setLibrarySelection", index: 0, resultCount: results.length });
  } else if (key.return) {
    const result = results[coordinator.uiState.library.selectedIndex];
    if (result?.kind === "track") await coordinator.dispatch({ type: "playNow", target: result.track });
  } else if (coordinator.uiState.library.inputFocused && (key.backspace || key.delete)) {
    coordinator.dispatchUi({
      type: "setLibraryQuery",
      query: coordinator.uiState.library.query.slice(0, -1),
    });
  } else if (coordinator.uiState.library.inputFocused && input.length > 0 && !key.ctrl && !key.meta) {
    coordinator.dispatchUi({
      type: "setLibraryQuery",
      query: coordinator.uiState.library.query + input,
    });
  }
}

async function routeDownloader(
  input: string,
  key: InputKey,
  coordinator: AppCoordinator,
): Promise<void> {
  const downloads = coordinator.appState.downloads;
  const pipelineCount = downloads.pendingBatches.length + downloads.summaries.length + (downloads.activeBatch ? 1 : 0);
  const jump = listJump(input, key, chordPending(coordinator.uiState), pipelineCount, coordinator.uiState.downloader.selectedBatchIndex);
  if (!coordinator.uiState.downloader.inputFocused && jump.pending !== undefined) coordinator.dispatchUi({ type: "setPendingVimChord", pending: jump.pending });
  if (!coordinator.uiState.downloader.inputFocused && jump.index !== undefined) {
    coordinator.dispatchUi({ type: "setDownloaderBatchSelection", index: jump.index, resultCount: pipelineCount });
  } else if (key.escape) {
    coordinator.dispatchUi({ type: "setDownloaderInputFocus", focused: false });
  } else if (!coordinator.uiState.downloader.inputFocused && input === "u") {
    coordinator.dispatchUi({ type: "setDownloaderInputFocus", focused: true });
  } else if (!coordinator.uiState.downloader.inputFocused && (input === "j" || input === "k" || key.downArrow || key.upArrow)) {
    coordinator.dispatchUi({
      type: "setDownloaderBatchSelection",
      index: coordinator.uiState.downloader.selectedBatchIndex + (input === "j" || key.downArrow ? 1 : -1),
      resultCount: pipelineCount,
    });
  } else if (!coordinator.uiState.downloader.inputFocused && input === "x") {
    const selectedIndex = coordinator.uiState.downloader.selectedBatchIndex;
    if (downloads.activeBatch && selectedIndex === 0) {
      coordinator.dispatchUi({
        type: "requestConfirmation", kind: "cancel-download", batchId: downloads.activeBatch.id,
        target: `Download Batch #${downloads.activeBatch.id} (${downloads.activeBatch.sourceUrl})`,
      });
      return;
    }
    const pending = downloads.pendingBatches[selectedIndex - (downloads.activeBatch ? 1 : 0)];
    if (pending) {
      coordinator.dispatchUi({
        type: "requestConfirmation", kind: "remove-pending-download", batchId: pending.id,
        target: `pending Download Batch #${pending.id} (${pending.sourceUrl})`,
      });
    }
  } else if (key.return) {
    const url = coordinator.uiState.downloader.urlInput.trim();
    if (url) await coordinator.dispatch({ type: "downloadOperation", operation: "start", url });
  } else if (coordinator.uiState.downloader.inputFocused && (key.backspace || key.delete)) {
    coordinator.dispatchUi({
      type: "setDownloaderInput",
      value: coordinator.uiState.downloader.urlInput.slice(0, -1),
    });
  } else if (coordinator.uiState.downloader.inputFocused && input.length > 0 && !key.ctrl && !key.meta) {
    coordinator.dispatchUi({
      type: "setDownloaderInput",
      value: coordinator.uiState.downloader.urlInput + input,
    });
  }
}

function render(snapshot: PublicationSnapshot, coordinator: AppCoordinator, noColor: boolean) {
  const { appState, uiState } = snapshot;
  if (uiState.terminal.tier === "terminal-too-small") {
    return h(Box, { flexDirection: "column" }, () => [
      h(Text, { bold: true }, () => "Terminal too small"),
      h(Text, () => "Need 60×16 · state preserved · resize to continue"),
    ]);
  }

  const confirmation = activeConfirmation(coordinator);
  if (confirmation) {
    return h(Box, {
      flexDirection: "column", width: uiState.terminal.columns, height: uiState.terminal.rows,
    }, () => [
      tabHeader(uiState.activeTab, noColor),
      h(Box, { flexGrow: 1, justifyContent: "center", alignItems: "center" }, () =>
        confirmationModal(confirmation, uiState, noColor)),
      h(Text, { dimColor: true }, () => "Modal open · unrelated actions suspended"),
    ]);
  }

  const renderedLibraryResults = uiState.activeTab === "library"
    ? libraryResults(coordinator.appState.providers["youtube-cache"], uiState.library.query)
    : [];
  const incompleteLibrarySelection = renderedLibraryResults[uiState.library.selectedIndex]?.kind === "incomplete";

  return h(Box, {
    flexDirection: "column",
    width: uiState.terminal.columns,
    height: uiState.terminal.rows,
  }, () => [
    tabHeader(uiState.activeTab, noColor),
    uiState.notification ? statusBanner(uiState.notification, noColor) : null,
    uiState.activeTab === "playback"
        ? playbackView(snapshot, coordinator, noColor)
      : uiState.activeTab === "library"
        ? libraryView(snapshot, noColor, renderedLibraryResults)
        : downloaderView(snapshot, noColor),
    uiState.overlays.at(-1) ? h(Box, { borderStyle: "round", paddingX: 1 }, () =>
      h(Text, { bold: true }, () => `${tabLabel(uiState.activeTab)} Shortcuts · ${contextualHelp(uiState.activeTab, incompleteLibrarySelection)} · Global: Space Play/Pause · n/p Next/Previous · s Stop · h/l Seek · +/- Volume · r Repeat · [/] Tabs · Esc Close`)) : null,
    nowPlayingBar(snapshot, noColor),
    h(Text, { dimColor: true }, () => footer(uiState, incompleteLibrarySelection)),
  ]);
}

function nowPlayingBar(snapshot: PublicationSnapshot, noColor: boolean) {
  const { playback, queue, volume } = snapshot.appState;
  if (!playback.currentTrackIdentity) return null;
  const current = queue.entries.find((entry) =>
    entry.track.identity.providerId === playback.currentTrackIdentity?.providerId
    && entry.track.identity.stableId === playback.currentTrackIdentity.stableId);
  if (!current) return null;
  const unavailable = current.availability.status === "unavailable" || playback.status === "error";
  const resumable = playback.status === "paused" && playback.restored === true;
  const semantics = unavailable
    ? { cue: "! ERROR", color: "red" }
    : resumable
      ? { cue: "↻ RESUME", color: "yellow" }
      : playback.status === "playing"
        ? { cue: "▶ PLAYING", color: "green" }
        : playback.status === "paused"
          ? { cue: "Ⅱ PAUSED", color: "yellow" }
          : { cue: "■ STOPPED", color: "yellow" };
  const elapsed = formatDuration(playback.positionSeconds ?? 0);
  const duration = playback.durationSeconds ?? current.track.durationSeconds;
  const progress = duration !== undefined && Number.isFinite(duration) && duration > 0
    ? ` ${progressBar(playback.positionSeconds ?? 0, duration)} ${elapsed}/${formatDuration(duration)}`
    : ` ${elapsed}`;
  const volumeLabel = volume.ready ? `Vol ${volume.percent}%` : "Vol —";
  const repeat = queue.repeatAll ? " · ↻ ALL" : "";
  return h(Box, { width: "100%", flexDirection: "row" }, () => [
    h(Text, {
      bold: true, color: noColor ? undefined : semantics.color,
    }, () => `──────── NOW PLAYING · ${semantics.cue} · `),
    h(Text, { bold: true, wrap: "truncate-end", flexGrow: 1 }, () => current.track.title),
    h(Text, { bold: true }, () => ` ·${progress} · ${volumeLabel}${repeat}`),
  ]);
}

function progressBar(positionSeconds: number, durationSeconds: number): string {
  const width = 10;
  const filled = Math.max(0, Math.min(width, Math.floor((positionSeconds / durationSeconds) * width)));
  return `[${"=".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function tabHeader(active: UiState["activeTab"], noColor: boolean) {
  const tab = (id: UiState["activeTab"], label: string) => h(Text, {
    bold: active === id, inverse: active === id, dimColor: active !== id,
    color: active === id && !noColor ? "cyan" : undefined,
  }, () => active === id ? `▸ ${label} ◂` : label);
  return h(Box, { borderStyle: "round", width: "100%", paddingX: 1 }, () => [
    tab("playback", "Player"), h(Text, () => "  "), tab("library", "Library"), h(Text, () => "  "),
    tab("downloader", "Downloads"), h(Spacer), h(Text, { dimColor: true }, () => "[ prev · next ]"),
  ]);
}

function playbackView(
  snapshot: PublicationSnapshot,
  coordinator: AppCoordinator,
  noColor: boolean,
) {
  const { uiState } = snapshot;
  const entries = snapshot.appState.queue.entries;
  const currentIndex = snapshot.appState.queue.currentIndex;
  const lines = entries.length === 0
    ? ["Queue is empty — open Library to add Tracks."]
    : entries.map((entry, index) => {
      const selected = index === uiState.selectedQueueIndex ? "›" : " ";
      const status = entry.availability.status === "unavailable"
        ? "!"
        : index === currentIndex
          ? snapshot.appState.playback.status === "playing" ? "▶" : snapshot.appState.playback.status === "paused" ? "Ⅱ" : "■"
          : "·";
      return `${selected} ${status} ${entry.track.title} · ${formatDuration(entry.track.durationSeconds)}${index === currentIndex ? " · CURRENT" : ""}`;
    });
  const position = entries.length ? uiState.selectedQueueIndex + 1 : 0;
  const queue = h(Box, {
    flexDirection: "column", flexGrow: 2, width: uiState.terminal.tier === "narrow" ? "100%" : "66%",
    borderStyle: "round", borderColor: noColor ? undefined : "cyan", paddingX: 1,
  }, () => [
    h(Text, { bold: true, color: noColor ? undefined : "cyan" }, () => `Queue · ${entries.length} Track${entries.length === 1 ? "" : "s"} · ${position}/${entries.length}`),
    ...lines.slice(uiState.queueScroll, uiState.queueScroll + 10).map((line, index) => h(Text, { wrap: "truncate-end", inverse: entries.length > 0 && index + uiState.queueScroll === uiState.selectedQueueIndex }, () => line)),
  ]);
  const selected = entries[uiState.selectedQueueIndex];
  if (!selected) return queue;
  const provider = coordinator.appState.providers[selected.track.identity.providerId];
  const cacheEntry = isYouTubeCacheProvider(provider) ? provider.findByIdentity(selected.track.identity) : undefined;
  const metadata = cacheEntry?.metadata;
  const unavailableReason = selected.availability.status === "unavailable"
    ? selected.availability.reason
    : undefined;
  const preview = h(Box, {
    flexDirection: "column", flexGrow: 1, width: uiState.terminal.tier === "narrow" ? "100%" : "34%",
    borderStyle: "round", borderDimColor: true, paddingX: 1,
  }, () => [
    h(Text, { bold: true }, () => "Selected Track"),
    h(Text, () => `Title: ${selected.track.title}`),
    ...(selected.track.artist ? [h(Text, () => `Channel: ${selected.track.artist}`)] : []),
    h(Text, () => `Duration: ${formatDuration(selected.track.durationSeconds)}`),
    ...(metadata ? [
      h(Text, () => `Cached: ${metadata.cachedAt.slice(0, 10)}`),
      h(Text, () => `Format: ${metadata.container}`),
      h(Text, () => `Size: ${formatFileSize(cacheEntry.mediaSizeBytes)}`),
      h(Text, () => `Video ID: ${metadata.videoId}`),
    ] : [h(Text, () => `Video ID: ${selected.track.identity.stableId}`)]),
    ...(unavailableReason
      ? [h(Text, { color: noColor ? undefined : "red" }, () => `Unavailable: ${unavailableReason}`)]
      : []),
  ]);
  return h(Box, { flexDirection: uiState.terminal.tier === "narrow" ? "column" : "row", gap: 1, flexGrow: 1 }, () => [queue, preview]);
}

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "—:—";
  const rounded = Math.max(0, Math.round(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value.toFixed(1)} ${unit}`;
}

function libraryView(snapshot: PublicationSnapshot, noColor: boolean, resultsList: readonly LibraryResult[]) {
  const search = h(Box, { borderStyle: "round", borderColor: snapshot.uiState.library.inputFocused && !noColor ? "cyan" : undefined, borderDimColor: !snapshot.uiState.library.inputFocused, paddingX: 1 }, () =>
    h(Text, { bold: snapshot.uiState.library.inputFocused }, () => `Search ${snapshot.uiState.library.inputFocused ? "│" : ""} ${snapshot.uiState.library.query || "(type to search)"}`));
  const results = h(Box, { flexDirection: "column", flexGrow: 1, borderStyle: "round", borderColor: !snapshot.uiState.library.inputFocused && !noColor ? "cyan" : undefined, paddingX: 1 }, () => [
    h(Text, { bold: !snapshot.uiState.library.inputFocused }, () => `Library · ${resultsList.length} results · ${resultsList.length ? snapshot.uiState.library.selectedIndex + 1 : 0}/${resultsList.length}`),
    ...resultsList.slice(snapshot.uiState.library.scroll, snapshot.uiState.library.scroll + 10).map((result, visibleIndex) => { const index = visibleIndex + snapshot.uiState.library.scroll; const selected = index === snapshot.uiState.library.selectedIndex; return h(Text, {
      wrap: "truncate-end", inverse: !snapshot.uiState.library.inputFocused && selected,
      dimColor: snapshot.uiState.library.inputFocused && selected,
      color: !noColor && result.kind === "incomplete" ? "red" : undefined,
    }, () => `${selected ? "›" : " "} ${libraryRow(result, snapshot.uiState.terminal.columns)}`); }),
    resultsList.length === 0 ? h(Text, { dimColor: true }, () => snapshot.uiState.library.query ? "No Cache Entries match your search." : "YouTube Cache is empty — use Downloads to add Tracks.") : null,
  ]);
  const selected = resultsList[snapshot.uiState.library.selectedIndex];
  const inspector = selected ? libraryInspector(selected, noColor) : null;
  const body = snapshot.uiState.terminal.tier === "wide" && inspector
    ? h(Box, { flexDirection: "row", gap: 1, flexGrow: 1 }, () => [results, inspector])
    : h(Box, { flexDirection: "column", gap: 1, flexGrow: 1 }, () => [results, inspector]);
  return h(Box, { flexDirection: "column", flexGrow: 1, gap: 1 }, () => [search, body]);
}

type LibraryResult =
  | { kind: "track"; track: import("../domain").Track; cacheEntry?: YouTubeCacheEntry }
  | { kind: "incomplete"; entry: IncompleteYouTubeCacheEntry };

function libraryResults(provider: import("../domain").Provider, query: string): LibraryResult[] {
  if (!isYouTubeCacheProvider(provider)) return provider.searchTracks(query).map((track) => ({ kind: "track", track }));
  const normalized = query.trim().toLocaleLowerCase();
  const results: LibraryResult[] = [
    ...provider.listCacheEntries().map((cacheEntry): LibraryResult => ({ kind: "track", track: cacheEntry.track, cacheEntry })),
    ...provider.listIncompleteEntries().map((entry): LibraryResult => ({ kind: "incomplete", entry })),
  ];
  return results
    .filter((result) => {
      if (!normalized) return true;
      const values = result.kind === "track"
        ? [result.track.title, result.track.artist, result.track.identity.stableId, result.cacheEntry?.metadata.mediaFileName.replace(/\.[^.]+$/, "")]
        : [result.entry.title, result.entry.uploader, result.entry.videoId, result.entry.stem];
      return values.some((value) => value?.toLocaleLowerCase().includes(normalized));
    })
    .sort((left, right) => libraryTimestamp(right).localeCompare(libraryTimestamp(left)) || libraryStableId(left).localeCompare(libraryStableId(right)));
}

function libraryTimestamp(result: LibraryResult): string {
  return result.kind === "track" ? result.cacheEntry?.metadata.cachedAt ?? "" : result.entry.cachedAt ?? "";
}

function libraryStableId(result: LibraryResult): string {
  return result.kind === "track" ? result.track.identity.stableId : result.entry.videoId ?? result.entry.stem;
}

function libraryRow(result: LibraryResult, columns: number): string {
  const title = result.kind === "track" ? result.track.title : result.entry.title ?? result.entry.stem;
  const duration = result.kind === "track" ? result.track.durationSeconds ?? result.cacheEntry?.metadata.durationSeconds : result.entry.durationSeconds;
  const size = formatFileSize(result.kind === "track" ? result.cacheEntry?.mediaSizeBytes : result.entry.mediaSizeBytes);
  const details = columns < 75 ? "" : columns < 100 ? ` · ${formatDuration(duration)}` : ` · ${formatDuration(duration)} · ${size}`;
  return `${result.kind === "track" ? "✓" : "!"} ${title}${details}`;
}

function libraryInspector(result: LibraryResult, noColor: boolean) {
  const track = result.kind === "track" ? result.track : undefined;
  const metadata = result.kind === "track" ? result.cacheEntry?.metadata : undefined;
  const title = track?.title ?? (result.kind === "incomplete" ? result.entry.title : undefined) ?? libraryStableId(result);
  const channel = track?.artist ?? (result.kind === "incomplete" ? result.entry.uploader : undefined);
  const duration = track?.durationSeconds ?? metadata?.durationSeconds ?? (result.kind === "incomplete" ? result.entry.durationSeconds : undefined);
  const cachedAt = metadata?.cachedAt ?? (result.kind === "incomplete" ? result.entry.cachedAt : undefined);
  const container = metadata?.container ?? (result.kind === "incomplete" ? result.entry.container : undefined);
  return h(Box, { flexDirection: "column", borderStyle: "round", borderDimColor: true, paddingX: 1, flexGrow: 1 }, () => [
    h(Text, { bold: true }, () => result.kind === "track" ? "Selected Track" : "Incomplete Cache Entry"),
    h(Text, () => `Title: ${title}`),
    ...(channel ? [h(Text, () => `Channel: ${channel}`)] : []),
    h(Text, () => `Duration: ${formatDuration(duration)}`),
    h(Text, () => `Cached: ${cachedAt ? cachedAt.slice(0, 10) : "Unknown"}`),
    h(Text, () => `Format: ${container ?? "Unknown"}`),
    h(Text, () => `Size: ${formatFileSize(result.kind === "track" ? result.cacheEntry?.mediaSizeBytes : result.entry.mediaSizeBytes)}`),
    h(Text, () => `Video ID: ${libraryStableId(result)}`),
    ...(result.kind === "incomplete" ? [h(Text, { color: noColor ? undefined : "red" }, () => `Health: ${result.entry.reason}`)] : []),
  ]);
}

function downloaderView(snapshot: PublicationSnapshot, noColor: boolean) {
  const downloads = snapshot.appState.downloads;
  const batchCount = downloads.pendingBatches.length + downloads.summaries.length + (downloads.activeBatch ? 1 : 0);
  const selectedIndex = snapshot.uiState.downloader.selectedBatchIndex;
  const rows = [
    ...(downloads.activeBatch ? [h(Text, { wrap: "truncate-end", dimColor: snapshot.uiState.downloader.inputFocused && selectedIndex === 0, inverse: !snapshot.uiState.downloader.inputFocused && selectedIndex === 0 }, () => {
      const batch = downloads.activeBatch!;
      const position = batch.activeTrack ? `${batch.activeTrack.index + 1}/${batch.itemCount}` : `0/${batch.itemCount}`;
      const progress = progressIndicator(batch.progressPercent);
      const source = truncateMiddle(batch.sourceUrl, 28);
      return `${selectedIndex === 0 ? "› " : "  "}ACTIVE #${batch.id} · ${position} · ${progress} · ${batch.activeTrack?.title ?? source}${batch.activeTrack?.title ? ` · ${source}` : ""}`;
    })] : []),
    ...downloads.pendingBatches.map((batch, index) => { const row = index + (downloads.activeBatch ? 1 : 0); return h(Text, { wrap: "truncate-end", inverse: !snapshot.uiState.downloader.inputFocused && row === snapshot.uiState.downloader.selectedBatchIndex, dimColor: snapshot.uiState.downloader.inputFocused && row === snapshot.uiState.downloader.selectedBatchIndex }, () =>
      `${row === selectedIndex ? "› " : "  "}PENDING #${batch.id} · ${batch.itemCount} ${batch.itemCount === 1 ? "item" : "items"} · ${truncateMiddle(batch.sourceUrl, 36)}`); }),
    ...downloads.summaries.map((summary, index) => { const row = index + downloads.pendingBatches.length + (downloads.activeBatch ? 1 : 0); return h(Text, { wrap: "truncate-end", inverse: !snapshot.uiState.downloader.inputFocused && row === snapshot.uiState.downloader.selectedBatchIndex, dimColor: snapshot.uiState.downloader.inputFocused && row === snapshot.uiState.downloader.selectedBatchIndex }, () =>
      `${row === selectedIndex ? "› " : "  "}COMPLETED #${summary.id} · ${summary.downloaded} downloaded · ${summary.alreadyCached} cached · ${summary.failed} failed · ${summary.cancelled} cancelled · ${summary.sourceUrl}`); }),
  ];
  const selectedSummaryIndex = selectedIndex - downloads.pendingBatches.length - (downloads.activeBatch ? 1 : 0);
  const selectedFailure = !snapshot.uiState.downloader.inputFocused
    ? downloads.summaries[selectedSummaryIndex]?.failures[0]
    : undefined;
  return h(Box, { flexDirection: "column", flexGrow: 1, gap: 1 }, () => [
    h(Box, { borderStyle: "round", borderColor: snapshot.uiState.downloader.inputFocused && !noColor ? "cyan" : undefined, borderDimColor: !snapshot.uiState.downloader.inputFocused, paddingX: 1 }, () => h(Text, { bold: snapshot.uiState.downloader.inputFocused }, () => `URL Input ${snapshot.uiState.downloader.inputFocused ? "│" : ""} ${snapshot.uiState.downloader.urlInput || "(paste one URL)"}`)),
    h(Box, { flexDirection: "column", flexGrow: 1, borderStyle: "round", borderColor: !snapshot.uiState.downloader.inputFocused && !noColor ? "cyan" : undefined, paddingX: 1 }, () => [
    h(Text, { bold: !snapshot.uiState.downloader.inputFocused }, () => `Pipeline · ${batchCount} ${batchCount === 1 ? "batch" : "batches"} · ${batchCount ? selectedIndex + 1 : 0}/${batchCount}`),
    rows.length === 0 ? h(Text, { dimColor: true }, () => downloads.preparingSubmissions > 0 ? `Preparing ${downloads.preparingSubmissions} submission(s)` : "Paste a YouTube URL above to begin.") : null,
    ...rows.slice(snapshot.uiState.downloader.scroll, snapshot.uiState.downloader.scroll + 10),
    ...(selectedFailure ? [h(Text, { color: noColor ? undefined : "red", wrap: "truncate-end" }, () => `Failure: ${selectedFailure.title ?? `Item ${selectedFailure.index + 1}`} — ${selectedFailure.message}`)] : []),
    ]),
  ]);
}

function progressIndicator(percent: number | undefined): string {
  const rounded = Math.round(percent ?? 0);
  const filled = Math.round(rounded / 10);
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${rounded}%`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const leftLength = Math.ceil((maxLength - 1) / 2);
  return `${value.slice(0, leftLength)}…${value.slice(-(maxLength - leftLength - 1))}`;
}

function confirmationModal(confirmation: ConfirmationDescriptor, ui: UiState, noColor: boolean) {
  const choice = matchingConfirmationChoice(ui, confirmation);
  const button = (id: "cancel" | "confirm", label: string) => h(Text, {
    inverse: choice === id, bold: choice === id,
    color: !noColor && id === "confirm" ? "red" : undefined,
  }, () => choice === id ? `› ${label} ‹` : `  ${label}  `);
  return h(Box, {
    flexDirection: "column", borderStyle: "round", borderColor: noColor ? undefined : "red",
    paddingX: 2, alignSelf: "center", width: "70%",
  }, () => [
    h(Text, { bold: true }, () => confirmation.title),
    h(Text, { wrap: "wrap" }, () => confirmation.consequence),
    h(Box, { justifyContent: "center", gap: 2 }, () => [
      button("cancel", "Cancel"), button("confirm", confirmation.confirmLabel),
    ]),
    h(Text, { dimColor: true }, () => "←/→ or Tab Choose · Enter Select · y Confirm · n/Esc Cancel"),
  ]);
}

function statusBanner(notification: NonNullable<UiState["notification"]>, noColor: boolean) {
  const semantics = notification.level === "success"
    ? { symbol: "✓", label: "SUCCESS", color: "green" }
    : notification.level === "warning"
      ? { symbol: "!", label: "WARNING", color: "yellow" }
      : { symbol: "×", label: "ERROR", color: "red" };
  return h(Text, {
    bold: true, color: noColor ? undefined : semantics.color, wrap: "truncate-end",
  }, () => `${semantics.symbol} ${semantics.label} · ${notification.message}`);
}

function footer(ui: UiState, incompleteSelected = false): string {
  if (ui.activeTab === "playback") return "────────  j/k Move · Space Play · Enter Play · x Remove · ? Help";
  if (ui.activeTab === "library" && ui.library.inputFocused) return "────────  Type Search · Enter Results · Esc Results · Tab Focus · ? Help";
  if (ui.activeTab === "library" && incompleteSelected) return "────────  j/k Move · d Clean · / Search · ? Help";
  if (ui.activeTab === "library") return "────────  j/k Move · / Search · Enter Play · a Add · ? Help";
  if (ui.downloader.inputFocused) return "────────  Type URL · Enter Submit · Esc Pipeline · Tab Focus · ? Help";
  return "────────  j/k Move · x Cancel/Remove · gg/G Ends · Tab Focus · ? Help";
}

function adjacentTab(active: UiState["activeTab"], delta: 1 | -1): UiState["activeTab"] {
  const tabs: UiState["activeTab"][] = ["playback", "library", "downloader"];
  return tabs[(tabs.indexOf(active) + delta + tabs.length) % tabs.length]!;
}

function listJump(input: string, key: InputKey, pendingG: boolean, count: number, index: number) {
  if (input === "g") return pendingG ? { index: 0, pending: false } : { pending: true };
  if (input === "G") return { index: count - 1, pending: false };
  if (key.pageDown || (key.ctrl && input === "d")) return { index: index + 10, pending: false };
  if (key.pageUp || (key.ctrl && input === "u")) return { index: index - 10, pending: false };
  return {};
}

function chordPending(ui: UiState): boolean {
  return ui.pendingVimChord !== null && ui.pendingVimChord.expiresAtMs >= Date.now();
}

function tabLabel(active: UiState["activeTab"]): string {
  return active === "playback" ? "Playback" : active === "library" ? "Library" : "YouTube Downloader";
}

function contextualHelp(active: UiState["activeTab"], incompleteSelected = false): string {
  if (active === "playback") return "j/k, arrows, Ctrl+d/u, PgUp/PgDn, gg/G Move · Enter Play Selected · Space Play/Pause · N Play Next · J/K Reorder · x Remove · C Clear · Z Randomize";
  if (active === "library") return incompleteSelected
    ? "/ Search · Tab/Shift+Tab Focus · j/k, arrows, Ctrl+d/u, PgUp/PgDn, gg/G Move · d Clean"
    : "/ Search · Tab/Shift+Tab Focus · Enter Results/Play Now · j/k, arrows, Ctrl+d/u, PgUp/PgDn, gg/G Move · N Play Next · a Add · d Delete";
  return "Tab/Shift+Tab Focus · Enter Submit · j/k, arrows, Ctrl+d/u, PgUp/PgDn, gg/G Move · x Cancel/Remove";
}


function publicationCause(reason: AppStateChangeReason): PublicationCause {
  return reason === "playback" ? "playback" : "state";
}

type InputKey = {
  ctrl?: boolean;
  meta?: boolean;
  tab?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  escape?: boolean;
  shift?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
};
