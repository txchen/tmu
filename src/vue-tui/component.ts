import { Box, Text, useApp, useInput, useWindowSize } from "@vue-tui/runtime";
import { defineComponent, h, onScopeDispose, shallowRef, watch } from "vue";
import type { AppCoordinator, AppStateChangeReason } from "../coordinator";
import type { QueueEntry, UiState } from "../domain";
import {
  StatePublicationGate,
  type PublicationCause,
  type PublicationSnapshot,
} from "../state-publication";
import { dispatchTerminalResize } from "./resize";
import { isYouTubeCacheProvider } from "../youtube-cache";

export type TmuRootOptions = {
  coordinator: AppCoordinator;
  measureCellWidth?: (value: string) => number;
  noColor?: boolean;
};

export function createTmuRoot(options: TmuRootOptions) {
  return defineComponent({
    name: "TmuRoot",
    setup() {
      const { coordinator } = options;
      coordinator.dispatchUi({
        type: "syncQueue",
        identities: coordinator.queueTrackIdentities(),
        preferredIdentity: coordinator.appState.playback.currentTrackIdentity,
      });
      const cadence = coordinator.appState.config.lowPower;
      const publication = new StatePublicationGate({
        readState: () => ({ appState: coordinator.appState, uiState: coordinator.uiState }),
        cadence: {
          playbackCadenceMs: cadence.playbackProgressMs,
          downloadProgressMs: cadence.downloadProgressThrottleMs,
          providerProgressMs: cadence.libraryProgressThrottleMs,
        },
      });
      const snapshot = shallowRef(publication.publishInitial());
      const unsubscribePublication = publication.subscribe((next) => { snapshot.value = next; });
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
        if (coordinator.appState.downloads.quitConfirmationRequired) {
          if (input === "y" || key.return) {
            await coordinator.dispatch({ type: "downloadOperation", operation: "confirm-quit" });
            app.exit();
          } else if (input === "n" || key.escape) {
            await coordinator.dispatch({ type: "downloadOperation", operation: "cancel-quit" });
          }
          publication.notify("input");
          return;
        }
        if (coordinator.appState.downloads.confirmation) {
          if (input === "y" || key.return) {
            await coordinator.dispatch({ type: "downloadOperation", operation: "confirm-playlist" });
          } else if (input === "n" || key.escape) {
            await coordinator.dispatch({ type: "downloadOperation", operation: "cancel-playlist" });
          }
          publication.notify("input");
          return;
        }
        if (coordinator.appState.cacheConfirmation) {
          if (input === "y" || key.return) {
            await coordinator.dispatch({ type: "cacheOperation", operation: "confirm" });
          } else if (input === "n" || key.escape) {
            await coordinator.dispatch({ type: "cacheOperation", operation: "cancel" });
          }
          publication.notify("input");
          return;
        }
        if (ui.pendingConfirmation) {
          if (input === "y" || key.return) {
            if (ui.pendingConfirmation.kind === "clear-queue") await coordinator.dispatch({ type: "clearQueue" });
            coordinator.dispatchUi({ type: "cancelConfirmation" });
          } else if (input === "n" || key.escape) {
            coordinator.dispatchUi({ type: "cancelConfirmation" });
          }
          publication.notify("input");
          return;
        }
        if (ui.overlays.length > 0) {
          if (key.escape || input === "q") coordinator.dispatchUi({ type: "dismissOverlay" });
          publication.notify("input");
          return;
        }
        const textInputFocused = ui.activeTab === "library"
          ? ui.library.inputFocused
          : ui.activeTab === "downloader" && ui.downloader.inputFocused;
        if (!textInputFocused && input === "?") {
          coordinator.dispatchUi({ type: "openOverlay", kind: "shortcut-help" });
          publication.notify("input");
          return;
        }
        if (!textInputFocused && input === ":") {
          coordinator.dispatchUi({ type: "openOverlay", kind: "command-palette" });
          publication.notify("input");
          return;
        }
        if ((key.ctrl && input === "c") || (input === "q" && !textInputFocused)) {
          await coordinator.dispatch({ type: "playerOperation", operation: "quit" });
          if (!coordinator.appState.downloads.quitConfirmationRequired) app.exit();
          return;
        }
        if ((!textInputFocused || key.ctrl) && input === "1") coordinator.dispatchUi({ type: "switchTab", tab: "playback" });
        else if ((!textInputFocused || key.ctrl) && input === "2") coordinator.dispatchUi({ type: "switchTab", tab: "library" });
        else if ((!textInputFocused || key.ctrl) && input === "3") coordinator.dispatchUi({ type: "switchTab", tab: "downloader" });
        else if (!textInputFocused && key.tab) coordinator.dispatchUi({ type: "switchTab", tab: nextTab(ui.activeTab) });
        else if (input === " " && !textInputFocused) {
          const selected = coordinator.appState.queue.entries[ui.selectedQueueIndex];
          if (coordinator.appState.queue.currentIndex < 0 && selected) {
            await coordinator.dispatch({ type: "playNow", target: selected.track });
          } else {
            await coordinator.dispatch({ type: "playerOperation", operation: "toggle-play-pause" });
          }
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
        unsubscribeCoordinator();
        unsubscribePublication();
        publication.stop();
      });

      return () => render(snapshot.value, coordinator);
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
  else if (input === "z") await coordinator.dispatch({ type: "playerOperation", operation: "toggle-shuffle" });
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
  if (input === "j" || key.downArrow) {
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
  const tracks = provider.searchTracks(coordinator.uiState.library.query);
  if (key.escape) {
    coordinator.dispatchUi({ type: "setLibraryInputFocus", focused: false });
  } else if (!coordinator.uiState.library.inputFocused && input === "/") {
    coordinator.dispatchUi({ type: "setLibraryInputFocus", focused: true });
  } else if (!coordinator.uiState.library.inputFocused && (input === "j" || key.downArrow)) {
    coordinator.dispatchUi({
      type: "setLibrarySelection",
      index: coordinator.uiState.library.selectedIndex + 1,
      resultCount: tracks.length,
    });
  } else if (!coordinator.uiState.library.inputFocused && (input === "k" || key.upArrow)) {
    coordinator.dispatchUi({
      type: "setLibrarySelection",
      index: coordinator.uiState.library.selectedIndex - 1,
      resultCount: tracks.length,
    });
  } else if (!coordinator.uiState.library.inputFocused && (input === "N" || input === "a")) {
    const track = tracks[coordinator.uiState.library.selectedIndex];
    if (track) await coordinator.dispatch({
      type: input === "N" ? "playNext" : "addToQueue",
      target: track,
    });
  } else if (!coordinator.uiState.library.inputFocused && input === "d") {
    const track = tracks[coordinator.uiState.library.selectedIndex];
    if (track) await coordinator.dispatch({ type: "cacheOperation", operation: "request-delete", identity: track.identity });
  } else if (!coordinator.uiState.library.inputFocused && (input === "J" || input === "K") && isYouTubeCacheProvider(provider)) {
    const entries = provider.listIncompleteEntries();
    coordinator.dispatchUi({
      type: "setCacheHealthSelection",
      index: coordinator.uiState.library.healthSelectedIndex + (input === "J" ? 1 : -1),
      resultCount: entries.length,
    });
  } else if (!coordinator.uiState.library.inputFocused && input === "X" && isYouTubeCacheProvider(provider)) {
    const incomplete = provider.listIncompleteEntries()[coordinator.uiState.library.healthSelectedIndex];
    if (incomplete) await coordinator.dispatch({ type: "cacheOperation", operation: "request-cleanup", stem: incomplete.stem });
  } else if (key.return) {
    const track = tracks[coordinator.uiState.library.selectedIndex];
    if (track) await coordinator.dispatch({ type: "playNow", target: track });
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
  if (key.escape) {
    coordinator.dispatchUi({ type: "setDownloaderInputFocus", focused: false });
  } else if (!coordinator.uiState.downloader.inputFocused && input === "u") {
    coordinator.dispatchUi({ type: "setDownloaderInputFocus", focused: true });
  } else if (!coordinator.uiState.downloader.inputFocused && (input === "j" || input === "k")) {
    coordinator.dispatchUi({
      type: "setDownloaderBatchSelection",
      index: coordinator.uiState.downloader.selectedBatchIndex + (input === "j" ? 1 : -1),
      resultCount: coordinator.appState.downloads.pendingBatches.length,
    });
  } else if (!coordinator.uiState.downloader.inputFocused && input === "x") {
    const pending = coordinator.appState.downloads.pendingBatches[coordinator.uiState.downloader.selectedBatchIndex];
    if (pending) {
      await coordinator.dispatch({ type: "downloadOperation", operation: "remove-pending", batchId: pending.id });
      coordinator.dispatchUi({
        type: "setDownloaderBatchSelection",
        index: coordinator.uiState.downloader.selectedBatchIndex,
        resultCount: coordinator.appState.downloads.pendingBatches.length,
      });
    }
  } else if (!coordinator.uiState.downloader.inputFocused && input === "c") {
    await coordinator.dispatch({ type: "downloadOperation", operation: "cancel-active" });
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

function render(snapshot: PublicationSnapshot, coordinator: AppCoordinator) {
  const { appState, uiState } = snapshot;
  if (uiState.terminal.tier === "terminal-too-small") {
    return h(Box, { flexDirection: "column" }, () => [
      h(Text, { bold: true }, () => "Terminal too small"),
      h(Text, () => "Need 60×16 · state preserved · resize to continue"),
    ]);
  }

  return h(Box, {
    flexDirection: "column",
    width: uiState.terminal.columns,
    height: uiState.terminal.rows,
  }, () => [
    h(Text, { bold: true }, () => tabHeader(uiState.activeTab)),
    uiState.activeTab === "playback"
      ? playbackView(appState.queue.entries, appState.queue.currentIndex, uiState)
      : uiState.activeTab === "library"
        ? libraryView(snapshot, coordinator)
        : downloaderView(snapshot),
    appState.appErrors.at(-1)
      ? h(Text, { color: "yellow", wrap: "truncate-end" }, () => `! ${appState.appErrors.at(-1)}`)
      : null,
    uiState.overlays.at(-1) ? h(Text, { bold: true }, () =>
      uiState.overlays.at(-1)?.kind === "shortcut-help"
        ? `${tabLabel(uiState.activeTab)} Help · ${contextualHelp(uiState.activeTab)} · Global: Space Play/Pause · n/p Next/Previous · s Stop · h/l Seek · +/- Volume · z Shuffle · r Repeat · 1/2/3 Tabs · Esc Close`
        : "Command Palette · Playback · Library · YouTube Downloader · Esc Close") : null,
    appState.cacheConfirmation ? h(Text, { bold: true }, () =>
      `${appState.cacheConfirmation!.kind === "delete-track" ? "Permanently delete" : "Clean incomplete"} ${appState.cacheConfirmation!.title ?? appState.cacheConfirmation!.stem}?${appState.cacheConfirmation!.stopsPlayback ? " This will stop playback." : ""} y Confirm · n Cancel`) : null,
    uiState.pendingConfirmation ? h(Text, { bold: true }, () => "Clear Queue permanently? y Confirm · n Cancel") : null,
    h(Text, { dimColor: true }, () => footer(uiState.activeTab)),
  ]);
}

function tabHeader(active: UiState["activeTab"]): string {
  const tab = (id: UiState["activeTab"], label: string) => active === id ? `[${label}]` : label;
  return `${tab("playback", "1 Playback")}  ${tab("library", "2 Library")}  ${tab("downloader", "3 YouTube Downloader")}`;
}

function playbackView(
  entries: readonly QueueEntry[],
  currentIndex: number,
  uiState: PublicationSnapshot["uiState"],
) {
  const lines = entries.length === 0
    ? ["Queue is empty"]
    : entries.map((entry, index) => {
      const selected = index === uiState.selectedQueueIndex ? ">" : " ";
      const current = index === currentIndex ? "*" : " ";
      const unavailable = entry.availability.status === "unavailable" ? "!" : " ";
      const reason = entry.availability.status === "unavailable" ? ` · unavailable: ${entry.availability.reason}` : "";
      return `${selected}${current}${unavailable} ${entry.track.title} · ${entry.track.providerLabel}${reason}`;
    });
  return h(Box, { flexDirection: "column", flexGrow: 1 }, () =>
    lines.map((line) => h(Text, { wrap: "truncate-end" }, () => line)));
}

function libraryView(snapshot: PublicationSnapshot, coordinator: AppCoordinator) {
  const provider = coordinator.appState.providers["youtube-cache"];
  const tracks = provider.searchTracks(snapshot.uiState.library.query);
  const incomplete = isYouTubeCacheProvider(provider) ? provider.listIncompleteEntries() : [];
  return h(Box, { flexDirection: "column", flexGrow: 1 }, () => [
    h(Text, () => `Cache Search: ${snapshot.uiState.library.query || "(type to search)"}${snapshot.uiState.library.inputFocused ? " [focused]" : ""}`),
    ...tracks.map((track, index) =>
      h(Text, { wrap: "truncate-end" }, () =>
        `${index === snapshot.uiState.library.selectedIndex ? ">" : " "} ${track.title}${track.artist ? ` · ${track.artist}` : ""}`
      )),
    tracks.length === 0 ? h(Text, { dimColor: true }, () => "No cached Tracks") : null,
    ...incomplete.map((entry, index) => h(Text, { color: "yellow", wrap: "truncate-end" }, () =>
      `${index === snapshot.uiState.library.healthSelectedIndex ? ">" : " "} Cache Health: ${entry.stem}${entry.title ? ` · ${entry.title}` : ""}${entry.uploader ? ` · ${entry.uploader}` : ""} · ${entry.reason}`)),
  ]);
}

function downloaderView(snapshot: PublicationSnapshot) {
  const downloads = snapshot.appState.downloads;
  return h(Box, { flexDirection: "column", flexGrow: 1 }, () => [
    h(Text, () => `YouTube URL: ${snapshot.uiState.downloader.urlInput || "(paste one URL)"}${snapshot.uiState.downloader.inputFocused ? " [focused]" : ""}`),
    downloads.confirmation ? h(Text, { bold: true }, () =>
      `Confirm playlist ${downloads.confirmation!.title} (${downloads.confirmation!.itemCount} source items)? y All · n Cancel`) : null,
    downloads.quitConfirmationRequired ? h(Text, { bold: true }, () =>
      "Quit will cancel active and pending Download Batches. y Quit · n Stay") : null,
    h(Text, { dimColor: !downloads.activeBatch }, () => downloads.activeBatch
      ? `Active #${downloads.activeBatch.id}${downloads.activeBatch.activeTrack === undefined ? "" : ` Track ${downloads.activeBatch.activeTrack.index + 1}${downloads.activeBatch.activeTrack.title ? ` · ${downloads.activeBatch.activeTrack.title}` : ""}`}: ${downloads.activeBatch.sourceUrl}`
      : downloads.preparingSubmissions > 0 ? `Preparing ${downloads.preparingSubmissions} submission(s)` : "No active downloads"),
    ...downloads.lines.map((line) => h(Text, { wrap: "truncate-end" }, () => line)),
    ...downloads.pendingBatches.map((batch, index) => h(Text, { wrap: "truncate-end" }, () =>
      `${index === snapshot.uiState.downloader.selectedBatchIndex ? ">" : " "} Pending #${batch.id}: ${batch.sourceUrl}`)),
    ...downloads.summaries.map((summary) => h(Text, { wrap: "truncate-end" }, () =>
      `Summary #${summary.id}: ${summary.downloaded} downloaded · ${summary.alreadyCached} cached · ${summary.failed} failed · ${summary.cancelled} cancelled`)),
    h(Text, { dimColor: true, wrap: "truncate-end" }, () => snapshot.appState.lastEvent),
  ]);
}

function footer(active: UiState["activeTab"]): string {
  if (active === "playback") return "j/k Move  Space Play  Enter Play Next  x Remove  ? Help  1/2/3 Tabs  q Quit";
  if (active === "library") return "j/k Tracks · J/K Health · Enter Play Now · N Next · a Add · d Delete · X Clean · ? Help";
  return "Type URL · Enter Submit · Esc Actions · j/k Pending · x Remove · c Cancel active · 1/2/3 Tabs";
}

function nextTab(active: UiState["activeTab"]): UiState["activeTab"] {
  return active === "playback" ? "library" : active === "library" ? "downloader" : "playback";
}

function tabLabel(active: UiState["activeTab"]): string {
  return active === "playback" ? "Playback" : active === "library" ? "Library" : "YouTube Downloader";
}

function contextualHelp(active: UiState["activeTab"]): string {
  if (active === "playback") return "j/k Move · x Remove · J/K Reorder · C Clear";
  if (active === "library") return "/ Focus Cache Search · j/k Move · Enter Play Now · N Play Next · a Add to Queue";
  return "u Focus URL · Enter Submit";
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
};
