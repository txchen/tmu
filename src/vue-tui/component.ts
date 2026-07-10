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
      const unsubscribeCoordinator = coordinator.onStateChange((reason) => {
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
        if (key.ctrl && input === "c" || input === "q" && ui.activeTab === "playback") {
          app.exit();
          return;
        }
        if (input === "1") coordinator.dispatchUi({ type: "switchTab", tab: "playback" });
        else if (input === "2") coordinator.dispatchUi({ type: "switchTab", tab: "library" });
        else if (input === "3") coordinator.dispatchUi({ type: "switchTab", tab: "downloader" });
        else if (key.tab) coordinator.dispatchUi({ type: "switchTab", tab: nextTab(ui.activeTab) });
        else if (input === " " && ui.activeTab !== "downloader") {
          const selected = coordinator.appState.queue.entries[ui.selectedQueueIndex];
          if (coordinator.appState.queue.currentIndex < 0 && selected) {
            await coordinator.dispatch({ type: "playNow", target: selected.track });
          } else {
            await coordinator.dispatch({ type: "playerOperation", operation: "toggle-play-pause" });
          }
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

      return () => render(snapshot.value);
    },
  });
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
  else if (input === "z") await coordinator.dispatch({ type: "playerOperation", operation: "toggle-shuffle" });
  else if (input === "r") await coordinator.dispatch({ type: "playerOperation", operation: "toggle-repeat-all" });
  else if (input === "h" || key.leftArrow) await coordinator.dispatch({ type: "playerOperation", operation: "seek", seconds: -5 });
  else if (input === "l" || key.rightArrow) await coordinator.dispatch({ type: "playerOperation", operation: "seek", seconds: 5 });
  else if (input === "+") await coordinator.dispatch({ type: "playerOperation", operation: "adjust-volume", delta: 5 });
  else if (input === "-") await coordinator.dispatch({ type: "playerOperation", operation: "adjust-volume", delta: -5 });
  else if (input === "?") coordinator.dispatchUi({ type: "openOverlay", kind: "shortcut-help" });
  else if (input === ":") coordinator.dispatchUi({ type: "openOverlay", kind: "command-palette" });
  else if (input === "n") await coordinator.dispatch({ type: "playerOperation", operation: "next-track" });
  else if (input === "p") await coordinator.dispatch({ type: "playerOperation", operation: "previous-track" });
  else if (input === "s") await coordinator.dispatch({ type: "playerOperation", operation: "stop" });
}

async function routeLibrary(
  input: string,
  key: InputKey,
  coordinator: AppCoordinator,
): Promise<void> {
  const provider = coordinator.appState.providers["youtube-cache"];
  const tracks = provider.searchTracks(coordinator.uiState.library.query);
  if (key.return) {
    const track = tracks[coordinator.uiState.library.selectedIndex];
    if (track) await coordinator.dispatch({ type: "playNow", target: track });
  } else if (key.backspace || key.delete) {
    coordinator.dispatchUi({
      type: "setLibraryQuery",
      query: coordinator.uiState.library.query.slice(0, -1),
    });
  } else if (input.length > 0 && !key.ctrl && !key.meta) {
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
  if (key.return) {
    const url = coordinator.uiState.downloader.urlInput.trim();
    if (url) await coordinator.dispatch({ type: "downloadOperation", operation: "start", url });
  } else if (key.backspace || key.delete) {
    coordinator.dispatchUi({
      type: "setDownloaderInput",
      value: coordinator.uiState.downloader.urlInput.slice(0, -1),
    });
  } else if (input.length > 0 && !key.ctrl && !key.meta) {
    coordinator.dispatchUi({
      type: "setDownloaderInput",
      value: coordinator.uiState.downloader.urlInput + input,
    });
  }
}

function render(snapshot: PublicationSnapshot) {
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
        ? libraryView(snapshot)
        : downloaderView(snapshot),
    appState.appErrors.at(-1)
      ? h(Text, { color: "yellow", wrap: "truncate-end" }, () => `! ${appState.appErrors.at(-1)}`)
      : null,
    uiState.overlays.at(-1) ? h(Text, { bold: true }, () =>
      uiState.overlays.at(-1)?.kind === "shortcut-help"
        ? "Playback Help · j/k Move · Space Play · x Remove · J/K Reorder · C Clear · Esc Close"
        : "Command Palette · Playback · Library · YouTube Downloader · Esc Close") : null,
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
      return `${selected}${current}${unavailable} ${entry.track.title} · ${entry.track.providerLabel}`;
    });
  return h(Box, { flexDirection: "column", flexGrow: 1 }, () =>
    lines.map((line) => h(Text, { wrap: "truncate-end" }, () => line)));
}

function libraryView(snapshot: PublicationSnapshot) {
  const provider = snapshot.appState.providers["youtube-cache"];
  const query = snapshot.uiState.library.query.toLocaleLowerCase();
  const tracks = (provider?.tracks ?? []).filter((track) =>
    !query || [track.title, track.artist, track.identity.stableId]
      .some((value) => value?.toLocaleLowerCase().includes(query))
  );
  return h(Box, { flexDirection: "column", flexGrow: 1 }, () => [
    h(Text, () => `Cache Search: ${snapshot.uiState.library.query || "(type to search)"}`),
    ...tracks.map((track, index) =>
      h(Text, { wrap: "truncate-end" }, () =>
        `${index === snapshot.uiState.library.selectedIndex ? ">" : " "} ${track.title}${track.artist ? ` · ${track.artist}` : ""}`
      )),
    tracks.length === 0 ? h(Text, { dimColor: true }, () => "No cached Tracks") : null,
  ]);
}

function downloaderView(snapshot: PublicationSnapshot) {
  const downloads = snapshot.appState.downloads;
  return h(Box, { flexDirection: "column", flexGrow: 1 }, () => [
    h(Text, () => `YouTube URL: ${snapshot.uiState.downloader.urlInput || "(paste one URL)"}`),
    h(Text, { dimColor: !downloads.active }, () =>
      downloads.active ? "Download active" : "No active downloads"),
    ...downloads.lines.map((line) => h(Text, { wrap: "truncate-end" }, () => line)),
  ]);
}

function footer(active: UiState["activeTab"]): string {
  if (active === "playback") return "j/k Move  Space Play  Enter Play Next  x Remove  ? Help  1/2/3 Tabs  q Quit";
  if (active === "library") return "Type Cache Search  Enter Play Now  Space Play/Pause  1/2/3 Tabs  q Quit";
  return "Type URL  Enter Download  1/2/3 Tabs  q Quit";
}

function nextTab(active: UiState["activeTab"]): UiState["activeTab"] {
  return active === "playback" ? "library" : active === "library" ? "downloader" : "playback";
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
