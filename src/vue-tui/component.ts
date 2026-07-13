import { Box, Spacer, Text as RuntimeText, useApp, useInput, useWindowSize } from "@vue-tui/runtime";
import { computed, defineComponent, h, inject, onScopeDispose, provide, shallowRef, unref, watch, type Ref } from "vue";
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
import { openExternalUrl, youtubeTrackUrl, type ExternalUrlOpener } from "../open-external-url";

export type TmuRootOptions = {
  coordinator: AppCoordinator;
  openUrl?: ExternalUrlOpener;
  measureCellWidth?: (value: string) => number;
  noColor?: boolean;
  publicationTimers?: Partial<PublicationTimers>;
};

const shortcutHelpSubdued = Symbol("shortcut-help-subdued");
const Text = defineComponent({
  name: "TmuText",
  inheritAttrs: false,
  props: { subdued: { type: Boolean, default: undefined } },
  setup(props, { attrs, slots }) {
    const inherited = inject<Ref<boolean>>(shortcutHelpSubdued, shallowRef(false));
    return () => h(RuntimeText, {
      ...attrs,
      dimColor: props.subdued ?? (unref(inherited) || attrs.dimColor === true),
    }, slots);
  },
});

export function createTmuRoot(options: TmuRootOptions) {
  return defineComponent({
    name: "TmuRoot",
    setup() {
      const { coordinator } = options;
      coordinator.dispatchUi({
        type: "syncPlaylist",
        identities: coordinator.playlistTrackIdentities(),
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
      provide(shortcutHelpSubdued, computed(() => snapshot.value.uiState.overlays.length > 0));
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
        clampShortcutHelpScroll(coordinator);
        publication.notify("resize");
      }, { immediate: true });

      useInput((input, key) => {
        void routeInput(input, key);
      });

      async function routeInput(input: string, key: InputKey): Promise<void> {
        const ui = coordinator.uiState;
        if (ui.terminal.tier === "terminal-too-small" && !isCtrlC(input, key)) return;
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
        if (ui.renameDialog) {
          if (isCtrlC(input, key)) {
            await coordinator.dispatch({ type: "playerOperation", operation: "quit" });
            if (!coordinator.appState.downloads.quitConfirmationRequired) app.exit();
          } else if (key.escape) {
            coordinator.dispatchUi({ type: "dismissRenameDialog" });
          } else if (key.return) {
            try {
              await coordinator.dispatch({
                type: "renameTrack", identity: ui.renameDialog.identity, title: ui.renameDialog.value,
              });
              coordinator.dispatchUi({ type: "dismissRenameDialog" });
            } catch (error) {
              coordinator.dispatchUi({
                type: "setRenameDialogError",
                error: error instanceof Error ? error.message : String(error),
              });
            }
          } else {
            editRenameDialog(input, key, coordinator);
          }
          publication.notify("input");
          return;
        }
        if (ui.playlistManager) {
          if (isCtrlC(input, key)) {
            await coordinator.dispatch({ type: "playerOperation", operation: "quit" });
            if (!coordinator.appState.downloads.quitConfirmationRequired) app.exit();
          } else await routePlaylistManager(input, key, coordinator);
          publication.notify("input");
          return;
        }
        if (ui.overlays.length > 0) {
          if (isCtrlC(input, key)) {
            await coordinator.dispatch({ type: "playerOperation", operation: "quit" });
            if (coordinator.appState.downloads.quitConfirmationRequired) {
              coordinator.dispatchUi({ type: "dismissOverlay" });
            } else app.exit();
          } else if (key.escape || key.return || input === "q" || input === "?") {
            coordinator.dispatchUi({ type: "dismissOverlay" });
          } else {
            routeShortcutHelp(input, key, coordinator);
          }
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
        if (!textInputFocused && input === "P") {
          const activeIndex = coordinator.appState.playlists.playlists.findIndex(
            (playlist) => playlist.id === coordinator.appState.playlists.activePlaylistId,
          );
          coordinator.dispatchUi({ type: "openPlaylistManager", activeIndex: Math.max(0, activeIndex) });
          publication.notify("input");
          return;
        }
        if (isCtrlC(input, key) || (input === "q" && !textInputFocused)) {
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
          await routeLibrary(input, key, coordinator, options.openUrl ?? openExternalUrl);
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

async function routePlaylistManager(input: string, key: InputKey, coordinator: AppCoordinator): Promise<void> {
  const manager = coordinator.uiState.playlistManager;
  if (!manager) return;
  if (manager.mode !== "browse") {
    if (key.escape) coordinator.dispatchUi({ type: "cancelPlaylistEdit" });
    else if (key.return) {
      try {
        if (manager.mode === "create") {
          await coordinator.dispatch({ type: "createPlaylist", name: manager.value });
          coordinator.dispatchUi({ type: "dismissPlaylistManager" });
        } else {
          const selected = coordinator.appState.playlists.playlists[manager.selectedIndex];
          if (selected) await coordinator.dispatch({ type: "renamePlaylist", playlistId: selected.id, name: manager.value });
          coordinator.dispatchUi({ type: "cancelPlaylistEdit" });
        }
      } catch (error) {
        coordinator.dispatchUi({ type: "setPlaylistNameError", error: error instanceof Error ? error.message : String(error) });
      }
    } else {
      const next = editTextValue(manager.value, manager.cursor, input, key);
      coordinator.dispatchUi({ type: "editPlaylistName", value: next.value, cursor: next.cursor });
    }
    return;
  }
  const playlists = coordinator.appState.playlists.playlists;
  const selected = playlists[manager.selectedIndex];
  if (key.escape) coordinator.dispatchUi({ type: "dismissPlaylistManager" });
  else if (input === "c") coordinator.dispatchUi({ type: "beginCreatePlaylist" });
  else if (input === "x") {
    if (playlists.length === 1 && selected) {
      await coordinator.dispatch({ type: "deletePlaylist", playlistId: selected.id });
      coordinator.dispatchUi({ type: "setPlaylistNameError", error: "cannot delete the sole remaining Playlist" });
    }
    else if (selected) coordinator.dispatchUi({ type: "requestConfirmation", kind: "delete-playlist", target: selected.id });
  }
  else if (input === "e") {
    if (selected) coordinator.dispatchUi({ type: "beginRenamePlaylist", name: selected.name });
  } else if (input === "J" || input === "K") {
    if (selected) {
      const delta = input === "J" ? 1 : -1;
      await coordinator.dispatch({ type: "movePlaylist", playlistId: selected.id, delta });
      const nextIndex = coordinator.appState.playlists.playlists.findIndex((playlist) => playlist.id === selected.id);
      coordinator.dispatchUi({ type: "selectPlaylist", index: nextIndex, count: playlists.length });
    }
  }
  else if (key.return) {
    if (selected) await coordinator.dispatch({ type: "switchPlaylist", playlistId: selected.id });
    coordinator.dispatchUi({ type: "dismissPlaylistManager" });
  } else {
    const jump = listJump(input, key, chordPending(coordinator.uiState), playlists.length, manager.selectedIndex);
    if (jump.pending !== undefined) coordinator.dispatchUi({ type: "setPendingVimChord", pending: jump.pending });
    else if (coordinator.uiState.pendingVimChord) coordinator.dispatchUi({ type: "setPendingVimChord", pending: false });
    const delta = input === "j" || key.downArrow ? 1 : input === "k" || key.upArrow ? -1 : 0;
    const index = jump.index ?? (key.home ? 0
      : key.end || input === "G" ? playlists.length - 1
        : key.pageDown ? manager.selectedIndex + 10
          : key.pageUp ? manager.selectedIndex - 10
            : manager.selectedIndex + delta);
    coordinator.dispatchUi({ type: "selectPlaylist", index, count: playlists.length });
  }
}

function editTextValue(value: string, cursor: number, input: string, key: InputKey): { value: string; cursor: number } {
  if (key.leftArrow) return { value, cursor: previousGraphemeBoundary(value, cursor) };
  if (key.rightArrow) return { value, cursor: nextGraphemeBoundary(value, cursor) };
  if (key.home) return { value, cursor: 0 };
  if (key.end) return { value, cursor: value.length };
  if (key.backspace && cursor > 0) {
    const previous = previousGraphemeBoundary(value, cursor);
    return { value: value.slice(0, previous) + value.slice(cursor), cursor: previous };
  }
  if (key.delete) {
    const next = nextGraphemeBoundary(value, cursor);
    return { value: value.slice(0, cursor) + value.slice(next), cursor };
  }
  if (!key.ctrl && !key.meta && input && !key.tab) return { value: value.slice(0, cursor) + input + value.slice(cursor), cursor: cursor + input.length };
  return { value, cursor };
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
  else if (input === "r") await coordinator.dispatch({ type: "playerOperation", operation: "toggle-repeat-all" });
  else return false;
  return true;
}

async function routePlayback(
  input: string,
  key: InputKey,
  coordinator: AppCoordinator,
): Promise<void> {
  const identities = coordinator.playlistTrackIdentities();
  const jump = listJump(input, key, chordPending(coordinator.uiState), identities.length, coordinator.uiState.selectedPlaylistIndex);
  if (jump.pending !== undefined) coordinator.dispatchUi({ type: "setPendingVimChord", pending: jump.pending });
  if (jump.index !== undefined) {
    coordinator.dispatchUi({ type: "selectPlaylistTrack", index: jump.index, identities });
  } else if (input === "j" || key.downArrow) {
    coordinator.dispatchUi({
      type: "selectPlaylistTrack",
      index: coordinator.uiState.selectedPlaylistIndex + 1,
      identities,
    });
  } else if (input === "k" || key.upArrow) {
    coordinator.dispatchUi({
      type: "selectPlaylistTrack",
      index: coordinator.uiState.selectedPlaylistIndex - 1,
      identities,
    });
  } else if (key.return) {
    const selected = coordinator.appState.activePlaylistContent.entries[coordinator.uiState.selectedPlaylistIndex];
    if (selected) await coordinator.dispatch({ type: "playSelected", identity: selected.track.identity });
  } else if (input === "N") {
    const selected = coordinator.appState.activePlaylistContent.entries[coordinator.uiState.selectedPlaylistIndex];
    if (selected) await coordinator.dispatch({ type: "playNext", target: selected.track });
  } else if (input === "x") {
    const selected = coordinator.appState.activePlaylistContent.entries[coordinator.uiState.selectedPlaylistIndex];
    if (selected) await coordinator.dispatch({ type: "removePlaylistTrack", identity: selected.track.identity });
  } else if (input === "J" || input === "K") {
    const selected = coordinator.appState.activePlaylistContent.entries[coordinator.uiState.selectedPlaylistIndex];
    if (selected) await coordinator.dispatch({
      type: "movePlaylistTrack",
      identity: selected.track.identity,
      delta: input === "J" ? 1 : -1,
    });
  } else if (input === "C") coordinator.dispatchUi({ type: "requestConfirmation", kind: "clear-playlist" });
  else if (input === "Z") await coordinator.dispatch({ type: "playerOperation", operation: "randomize-playlist" });
}

async function routeLibrary(
  input: string,
  key: InputKey,
  coordinator: AppCoordinator,
  openUrl: ExternalUrlOpener,
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
      type: input === "N" ? "playNext" : "addToPlaylist",
      target: result.track,
    });
  } else if (!coordinator.uiState.library.inputFocused && input === "d") {
    const result = results[coordinator.uiState.library.selectedIndex];
    if (result?.kind === "track") await coordinator.dispatch({ type: "cacheOperation", operation: "request-delete", identity: result.track.identity });
    else if (result) await coordinator.dispatch({ type: "cacheOperation", operation: "request-cleanup", stem: result.entry.stem });
  } else if (!coordinator.uiState.library.inputFocused && input === "e") {
    const result = results[coordinator.uiState.library.selectedIndex];
    if (result?.kind === "track") coordinator.dispatchUi({
      type: "openRenameDialog",
      identity: result.track.identity,
      currentTitle: result.track.title,
    });
  } else if (!coordinator.uiState.library.inputFocused && input === "O") {
    const result = results[coordinator.uiState.library.selectedIndex];
    if (result?.kind === "track") {
      try {
        await openUrl(youtubeTrackUrl(result.track.identity.stableId));
      } catch (error) {
        coordinator.dispatchUi({
          type: "setNotification",
          notification: { level: "error", message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
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
  if (confirmation) return modalScreen(snapshot, noColor, confirmationModal(confirmation, uiState, noColor));

  if (uiState.renameDialog) {
    return modalScreen(snapshot, noColor, renameTrackModal(uiState.renameDialog, noColor), "Enter Save · Esc Cancel · ");
  }

  if (uiState.playlistManager) {
    return modalScreen(snapshot, noColor, playlistManagerModal(appState.playlists, uiState.playlistManager, noColor));
  }

  const renderedLibraryResults = uiState.activeTab === "library"
    ? libraryResults(coordinator.appState.providers["youtube-cache"], uiState.library.query)
    : [];
  const incompleteLibrarySelection = renderedLibraryResults[uiState.library.selectedIndex]?.kind === "incomplete";

  return h(Box, {
    flexDirection: "column",
    width: uiState.terminal.columns,
    height: uiState.terminal.rows,
    position: "relative",
  }, () => [
    tabHeader(uiState.activeTab, noColor, activePlaylistName(appState), uiState.terminal.columns),
    uiState.notification ? statusBanner(uiState.notification, noColor) : null,
    uiState.activeTab === "playback"
        ? playbackView(snapshot, coordinator, noColor)
      : uiState.activeTab === "library"
        ? libraryView(snapshot, noColor, renderedLibraryResults)
        : downloaderView(snapshot, noColor),
    nowPlayingBar(snapshot, noColor),
    footer(uiState, incompleteLibrarySelection, noColor),
    uiState.overlays.at(-1) ? shortcutHelpModal(uiState, incompleteLibrarySelection, noColor) : null,
  ]);
}

function modalScreen(snapshot: PublicationSnapshot, noColor: boolean, content: ReturnType<typeof h>, hint = "") {
  const { appState, uiState } = snapshot;
  return h(Box, { flexDirection: "column", width: uiState.terminal.columns, height: uiState.terminal.rows }, () => [
    tabHeader(uiState.activeTab, noColor, activePlaylistName(appState), uiState.terminal.columns),
    h(Box, { flexGrow: 1, justifyContent: "center", alignItems: "center" }, () => content),
    h(Text, { dimColor: true }, () => `Modal open · ${hint}unrelated actions suspended`),
  ]);
}

function nowPlayingBar(snapshot: PublicationSnapshot, noColor: boolean) {
  const { playback, activePlaylistContent, volume } = snapshot.appState;
  if (!playback.currentTrackIdentity) return null;
  const current = activePlaylistContent.entries.find((entry) =>
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
  const repeat = activePlaylistContent.repeatAll ? " · ↻ ALL" : "";
  return h(Box, { width: "100%", flexDirection: "row" }, () => [
    h(Text, {
      bold: true, color: noColor ? undefined : semantics.color, flexShrink: 0,
    }, () => `── ${semantics.cue} · `),
    h(Text, { bold: true, wrap: "truncate-end", flexGrow: 1 }, () => current.track.title),
    h(Text, { bold: true, flexShrink: 0 }, () => ` ·${progress} · ${volumeLabel}${repeat}`),
  ]);
}

function progressBar(positionSeconds: number, durationSeconds: number): string {
  const width = 10;
  const filled = Math.max(0, Math.min(width, Math.floor((positionSeconds / durationSeconds) * width)));
  return `[${"=".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function tabHeader(active: UiState["activeTab"], noColor: boolean, playlistName = "Default", columns = 100) {
  const tab = (id: UiState["activeTab"], label: string) => h(Text, {
    bold: active === id, inverse: active === id, dimColor: active !== id,
    color: active === id && !noColor ? "cyan" : undefined,
  }, () => active === id ? `▸ ${label} ◂` : label);
  return h(Box, { borderStyle: "round", width: "100%", paddingX: 1 }, () => [
    tab("playback", "Player"), h(Text, () => "  "), tab("library", "Library"), h(Text, () => "  "),
    tab("downloader", "Downloads"), h(Spacer),
    h(Text, { bold: true, wrap: "truncate-end", width: Math.max(8, Math.min(28, columns - 55)) }, () => `Playlist: ${playlistName}`),
    h(Text, { dimColor: true }, () => "  [ prev · next ]"),
  ]);
}

function activePlaylistName(appState: PublicationSnapshot["appState"]): string {
  return appState.playlists.playlists.find((playlist) => playlist.id === appState.playlists.activePlaylistId)?.name ?? "Default";
}

function playlistManagerModal(
  collection: PublicationSnapshot["appState"]["playlists"],
  manager: NonNullable<UiState["playlistManager"]>,
  noColor: boolean,
) {
  const rows = collection.playlists.slice(manager.scroll, manager.scroll + 10).map((playlist, offset) => {
    const index = manager.scroll + offset;
    return h(Text, { inverse: index === manager.selectedIndex, wrap: "truncate-end" }, () =>
      `${index === manager.selectedIndex ? "›" : " "} ${playlist.id === collection.activePlaylistId ? "*" : " "} ${playlist.name} · ${playlist.entries.length}`);
  });
  return h(Box, { flexDirection: "column", borderStyle: "round", borderColor: noColor ? undefined : "cyan", paddingX: 2, width: "70%" }, () => [
    h(Text, { bold: true }, () => manager.mode === "create" ? "Create Playlist" : manager.mode === "rename" ? "Rename Playlist" : "Playlist Manager"),
    ...(manager.mode !== "browse"
      ? [h(Text, () => `Name: ${manager.value}│`), manager.error ? h(Text, { color: noColor ? undefined : "red" }, () => `Error: ${manager.error}`) : null]
      : [...rows, manager.error ? h(Text, { color: noColor ? undefined : "red" }, () => manager.error) : null]),
    h(Text, { dimColor: true }, () => manager.mode === "create" ? "Enter Create · Esc Cancel" : manager.mode === "rename" ? "Enter Save · Esc Cancel" : "j/k Move · Enter Switch · c Create · e Rename · x Delete · J/K Reorder · Esc Close"),
  ]);
}

function playbackView(
  snapshot: PublicationSnapshot,
  coordinator: AppCoordinator,
  noColor: boolean,
) {
  const { uiState } = snapshot;
  const entries = snapshot.appState.activePlaylistContent.entries;
  const currentIndex = snapshot.appState.activePlaylistContent.currentIndex;
  const lines = entries.length === 0
    ? ["Playlist is empty — open Library to add Tracks."]
    : entries.map((entry, index) => {
      const selected = index === uiState.selectedPlaylistIndex ? "›" : " ";
      const status = entry.availability.status === "unavailable"
        ? index === currentIndex ? "⚠" : "!"
        : index === currentIndex
          ? snapshot.appState.playback.status === "playing" ? "▶" : snapshot.appState.playback.status === "paused" ? "Ⅱ" : "■"
          : "·";
      return `${selected} ${status} ${entry.track.title} · ${formatDuration(entry.track.durationSeconds)}`;
    });
  const position = entries.length ? uiState.selectedPlaylistIndex + 1 : 0;
  const playlist = h(Box, {
    flexDirection: "column", flexGrow: 2, width: uiState.terminal.tier === "narrow" ? "100%" : "66%",
    borderStyle: "round", borderColor: noColor ? undefined : "cyan", paddingX: 1,
  }, () => [
    h(Text, { bold: true, color: noColor ? undefined : "cyan" }, () => `Playlist · ${entries.length} Track${entries.length === 1 ? "" : "s"} · ${position}/${entries.length}`),
    ...lines.slice(uiState.playlistScroll, uiState.playlistScroll + 10).map((line, index) => h(Text, { wrap: "truncate-end", inverse: entries.length > 0 && index + uiState.playlistScroll === uiState.selectedPlaylistIndex }, () => line)),
  ]);
  const selected = entries[uiState.selectedPlaylistIndex];
  if (!selected) return playlist;
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
    h(Text, { bold: true, color: noColor ? undefined : "cyan" }, () => "Selected Track"),
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
  return h(Box, { flexDirection: uiState.terminal.tier === "narrow" ? "column" : "row", gap: 1, flexGrow: 1 }, () => [playlist, preview]);
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
  const results = h(Box, {
    flexDirection: "column", flexGrow: 2, width: snapshot.uiState.terminal.tier === "wide" ? "66%" : "100%",
    borderStyle: "round", borderColor: !snapshot.uiState.library.inputFocused && !noColor ? "cyan" : undefined, paddingX: 1,
  }, () => [
    h(Text, { bold: true, color: noColor ? undefined : "cyan" }, () => `Library · ${resultsList.length} results · ${resultsList.length ? snapshot.uiState.library.selectedIndex + 1 : 0}/${resultsList.length}`),
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
  const details = columns < 75 ? "" : ` · ${formatDuration(duration)}`;
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
  return h(Box, {
    flexDirection: "column", width: "34%", borderStyle: "round", borderDimColor: true, paddingX: 1, flexGrow: 1,
  }, () => [
    h(Text, { bold: true, color: noColor ? undefined : "cyan" }, () => result.kind === "track" ? "Selected Track" : "Incomplete Cache Entry"),
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

function renameTrackModal(dialog: NonNullable<UiState["renameDialog"]>, noColor: boolean) {
  const beforeCursor = dialog.value.slice(0, dialog.cursor);
  const nextCursor = nextGraphemeBoundary(dialog.value, dialog.cursor);
  const atCursor = dialog.value.slice(dialog.cursor, nextCursor) || " ";
  const afterCursor = dialog.value.slice(nextCursor);
  return h(Box, {
    flexDirection: "column", borderStyle: "round", borderColor: noColor ? undefined : "cyan",
    paddingX: 2, alignSelf: "center", width: "70%",
  }, () => [
    h(Text, { bold: true }, () => "Rename Track"),
    h(Text, { wrap: "truncate-end" }, () => `Current name: ${dialog.currentTitle}`),
    h(Box, { flexDirection: "row" }, () => [
      h(Text, () => "New name: "),
      h(Text, () => beforeCursor),
      h(Text, { inverse: true }, () => atCursor),
      h(Text, () => afterCursor),
    ]),
    dialog.error ? h(Text, { color: noColor ? undefined : "red" }, () => `Error: ${dialog.error}`) : null,
    h(Text, { dimColor: true }, () => "←/→ Move · Home/End Jump · Enter Save · Esc Cancel"),
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

type ShortcutGroup = {
  title: string;
  rows: ReadonlyArray<readonly [keys: string, action: string]>;
};

const HELP_HINT = "j/k or ↑/↓ Scroll · PgUp/PgDn Page · Enter/q/?/Esc Close";

function shortcutHelpModal(ui: UiState, incompleteSelected: boolean, noColor: boolean) {
  const layout = shortcutHelpLayout(ui, incompleteSelected);
  const scroll = Math.min(ui.overlays.at(-1)?.scroll ?? 0, layout.maxScroll);
  return h(Box, {
    position: "absolute",
    top: layout.top,
    left: layout.left,
    width: layout.width,
    height: layout.height,
    flexDirection: "column",
    borderStyle: "round",
    borderColor: noColor ? undefined : "cyan",
    overflow: "hidden",
  }, () => [
    h(Text, { bold: true, inverse: true, subdued: false }, () => `${tabLabel(ui.activeTab)} Shortcuts`.padEnd(layout.innerWidth)),
    h(Box, { flexDirection: "column", height: layout.bodyHeight, overflow: "hidden" }, () =>
      layout.lines.slice(scroll, scroll + layout.bodyHeight).map((line) => h(Text, { subdued: false }, () => line.padEnd(layout.innerWidth)))),
    ...layout.hintLines.map((line) => h(Text, { bold: true, subdued: false }, () => line.padEnd(layout.innerWidth))),
  ]);
}

function shortcutHelpLayout(ui: UiState, incompleteSelected = false) {
  const width = Math.min(88, ui.terminal.columns - 4);
  const innerWidth = width - 2;
  const hintLines = wrapHelpText(HELP_HINT, innerWidth);
  const activeGroups = activeShortcutGroups(ui.activeTab, incompleteSelected);
  const globalGroups = globalShortcutGroups();
  const lines = ui.terminal.tier === "narrow"
    ? shortcutGroupLines([...activeGroups, ...globalGroups], innerWidth)
    : twoColumnHelpLines(activeGroups, globalGroups, innerWidth);
  const wantedHeight = lines.length + hintLines.length + 3;
  const height = Math.min(ui.terminal.rows - 4, wantedHeight);
  const bodyHeight = Math.max(1, height - hintLines.length - 3);
  return {
    width,
    innerWidth,
    height,
    left: Math.floor((ui.terminal.columns - width) / 2),
    top: Math.floor((ui.terminal.rows - height) / 2),
    bodyHeight,
    hintLines,
    lines,
    maxScroll: Math.max(0, lines.length - bodyHeight),
  };
}

function activeShortcutGroups(tab: UiState["activeTab"], incompleteSelected: boolean): ShortcutGroup[] {
  if (tab === "playback") return [{
    title: "PLAYLIST PANE",
    rows: [
      ["j/k, ↑/↓", "Move selection"], ["Ctrl+d/u, PgUp/PgDn", "Move by page"], ["gg/G", "First/last Track"],
      ["Enter", "Play Selected"], ["N", "Play Next"], ["J/K", "Move Track down/up"],
      ["x", "Remove Track"], ["C", "Clear Playlist (confirm)"],
      ["Z", "Randomize entire Playlist"],
    ],
  }];
  if (tab === "library") return [
    {
      title: "SEARCH INPUT",
      rows: [
        ["Type", "Edit Cache Search"], ["Backspace/Delete", "Delete character"],
        ["Enter", "Show Results"], ["Esc", "Leave input"], ["Tab/Shift+Tab", "Change focus"],
      ],
    },
    {
      title: "LIBRARY RESULTS",
      rows: [
        ["/", "Focus Search Input"], ["j/k, ↑/↓", "Move selection"], ["Ctrl+d/u, PgUp/PgDn", "Move by page"],
        ["gg/G", "First/last result"],
        ...(incompleteSelected
          ? [["d", "Clean incomplete Cache Entry"]] as Array<readonly [string, string]>
          : [["Enter", "Play Now"], ["N", "Play Next"], ["O", "Open on YouTube"], ["e", "Rename Track"], ["a", "Add to Playlist"], ["d", "Delete Track (confirm)"]] as Array<readonly [string, string]>),
        ["Tab/Shift+Tab", "Change focus"],
      ],
    },
  ];
  return [
    {
      title: "URL INPUT",
      rows: [
        ["Type", "Edit YouTube URL"], ["Backspace/Delete", "Delete character"],
        ["Enter", "Submit URL"], ["Esc", "Leave input"], ["Tab/Shift+Tab", "Change focus"],
      ],
    },
    {
      title: "DOWNLOAD PIPELINE",
      rows: [
        ["u", "Focus URL Input"], ["j/k, ↑/↓", "Move selection"], ["Ctrl+d/u, PgUp/PgDn", "Move by page"],
        ["gg/G", "First/last batch"], ["x (active)", "Cancel active batch"],
        ["x (pending)", "Remove pending batch"], ["Tab/Shift+Tab", "Change focus"],
      ],
    },
  ];
}

function globalShortcutGroups(): ShortcutGroup[] {
  return [
    {
      title: "GLOBAL PLAYBACK",
      rows: [
        ["Space", "Play/Pause"], ["n/p", "Next/Previous Track"], ["s", "Stop"],
        ["h/l, ←/→", "Seek −/+ 5 seconds"], ["+/−", "Volume −/+ 5%"], ["r", "Repeat All"],
      ],
    },
    {
      title: "TOP-LEVEL TABS",
      rows: [["[/]", "Previous/next tab"], ["?", "Open Help outside input"], ["Tab/Shift+Tab", "Move focus in tab"]],
    },
    {
      title: "HELP NAVIGATION",
      rows: [["j/k, ↑/↓", "Scroll one line"], ["PgUp/PgDn", "Scroll one page"], ["gg/G", "First/last line"]],
    },
    {
      title: "APPLICATION",
      rows: [["q", "Quit outside input/Help"], ["Ctrl-C", "Quit (confirm downloads)"], ["Enter/q/?/Esc", "Close Help only"]],
    },
    {
      title: "INPUT CAPTURE",
      rows: [
        ["Printable keys", "Captured by text input (including ? and command keys)"],
        ["[/], Ctrl-C", "Remain global during input"],
        ["Esc/Tab", "Leave input before Help"],
      ],
    },
  ];
}

function shortcutGroupLines(groups: readonly ShortcutGroup[], width: number): string[] {
  const keyWidth = Math.min(21, Math.max(12, Math.floor(width * 0.4)));
  const lines: string[] = [];
  groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) lines.push("");
    lines.push(group.title);
    for (const [keys, action] of group.rows) {
      const actionWidth = Math.max(8, width - keyWidth - 2);
      const wrapped = wrapHelpText(action, actionWidth);
      lines.push(`${keys.slice(0, keyWidth).padEnd(keyWidth)}  ${wrapped[0] ?? ""}`.slice(0, width));
      for (const continuation of wrapped.slice(1)) lines.push(`${"".padEnd(keyWidth)}  ${continuation}`.slice(0, width));
    }
  });
  return lines;
}

function twoColumnHelpLines(leftGroups: readonly ShortcutGroup[], rightGroups: readonly ShortcutGroup[], width: number): string[] {
  const gap = 3;
  const leftWidth = Math.floor((width - gap) / 2);
  const rightWidth = width - gap - leftWidth;
  const left = shortcutGroupLines(leftGroups, leftWidth);
  const right = shortcutGroupLines(rightGroups, rightWidth);
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) =>
    `${(left[index] ?? "").padEnd(leftWidth)}${" ".repeat(gap)}${right[index] ?? ""}`.trimEnd());
}

function wrapHelpText(value: string, width: number): string[] {
  if (value.length <= width) return [value];
  const words = value.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length > 0 && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else line = line.length > 0 ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function routeShortcutHelp(input: string, key: InputKey, coordinator: AppCoordinator): void {
  const overlay = coordinator.uiState.overlays.at(-1);
  if (!overlay) return;
  const incomplete = selectedLibraryEntryIsIncomplete(coordinator);
  const layout = shortcutHelpLayout(coordinator.uiState, incomplete);
  let scroll = Math.min(overlay.scroll, layout.maxScroll);
  if (input !== "g" && overlay.pendingG) coordinator.dispatchUi({ type: "setOverlayPendingG", pending: false });
  if (input === "j" || key.downArrow) scroll += 1;
  else if (input === "k" || key.upArrow) scroll -= 1;
  else if (key.pageDown) scroll += layout.bodyHeight;
  else if (key.pageUp) scroll -= layout.bodyHeight;
  else if (input === "G") scroll = layout.maxScroll;
  else if (input === "g") {
    if (overlay.pendingG) scroll = 0;
    coordinator.dispatchUi({ type: "setOverlayPendingG", pending: !overlay.pendingG });
  }
  coordinator.dispatchUi({ type: "setOverlayScroll", scroll: Math.max(0, Math.min(layout.maxScroll, scroll)) });
}

function clampShortcutHelpScroll(coordinator: AppCoordinator): void {
  const overlay = coordinator.uiState.overlays.at(-1);
  if (!overlay) return;
  const layout = shortcutHelpLayout(coordinator.uiState, selectedLibraryEntryIsIncomplete(coordinator));
  coordinator.dispatchUi({ type: "setOverlayScroll", scroll: Math.min(overlay.scroll, layout.maxScroll) });
}

function selectedLibraryEntryIsIncomplete(coordinator: AppCoordinator): boolean {
  if (coordinator.uiState.activeTab !== "library") return false;
  const results = libraryResults(coordinator.appState.providers["youtube-cache"], coordinator.uiState.library.query);
  return results[coordinator.uiState.library.selectedIndex]?.kind === "incomplete";
}

function footer(ui: UiState, incompleteSelected = false, noColor = false) {
  const shortcuts: Array<[key: string, action: string]> = ui.activeTab === "playback"
    ? [["j/k", "Move"], ["Space", "Play/Pause"], ["Enter", "Play Selected"], ["n/p", "Next/Prev"], ["?", "Help"]]
    : ui.activeTab === "library" && ui.library.inputFocused
      ? [["Type", "Search"], ["Enter", "Results"], ["Esc/Tab → ?", "Help"]]
      : ui.activeTab === "library" && incompleteSelected
        ? [["j/k", "Move"], ["d", "Clean"], ["/", "Search"], ["?", "Help"]]
        : ui.activeTab === "library"
          ? [["j/k", "Move"], ["/", "Search"], ["Enter", "Play"], ["e", "Rename"], ["?", "Help"]]
          : ui.downloader.inputFocused
            ? [["Type", "URL"], ["Enter", "Submit"], ["Esc/Tab → ?", "Help"]]
            : [["j/k", "Move"], ["x", "Cancel/Remove"], ["gg/G", "Ends"], ["Tab", "Focus"], ["?", "Help"]];
  return h(Box, { width: "100%", flexDirection: "row" }, () => [
    h(Text, { dimColor: true }, () => "──  "),
    ...shortcuts.flatMap(([key, action], index) => [
      ...(index === 0 ? [] : [h(Text, { dimColor: true }, () => " · ")]),
      h(Text, { bold: true, color: noColor ? undefined : "cyan" }, () => key),
      h(Text, { dimColor: true }, () => ` ${action}`),
    ]),
  ]);
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
  home?: boolean;
  end?: boolean;
};

function editRenameDialog(input: string, key: InputKey, coordinator: AppCoordinator): void {
  const dialog = coordinator.uiState.renameDialog;
  if (!dialog) return;
  const next = editTextValue(dialog.value, dialog.cursor, input, key);
  if (next.value !== dialog.value || next.cursor !== dialog.cursor) {
    coordinator.dispatchUi({ type: "editRenameDialog", ...next });
  }
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function previousGraphemeBoundary(value: string, cursor: number): number {
  let previous = 0;
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index >= cursor) break;
    previous = segment.index;
  }
  return previous;
}

function nextGraphemeBoundary(value: string, cursor: number): number {
  for (const segment of graphemeSegmenter.segment(value)) {
    if (segment.index > cursor) return segment.index;
  }
  return value.length;
}

function isCtrlC(input: string, key: InputKey): boolean {
  return input === "\x03" || (key.ctrl === true && input === "c");
}
