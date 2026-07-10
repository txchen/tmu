import { describe, expect, test } from "bun:test";
import { AppCoordinator } from "../src/coordinator";
import type { PlaybackLocator, Provider, Track } from "../src/domain";
import { NoopPlayer } from "../src/player";
import { MemoryQueue } from "../src/queue";
import { createInitialAppState, createInitialUiState } from "../src/state";

const cachedTrack: Track = {
  identity: { providerId: "youtube-cache", stableId: "cached-track" },
  title: "Cached Track",
  providerLabel: "YouTube Cache",
  artist: "Cache Artist",
};

class RecordingPlayer extends NoopPlayer {
  readonly loaded: PlaybackLocator[] = [];
  teardownCount = 0;

  override async load(locator: PlaybackLocator): Promise<void> {
    this.loaded.push(locator);
    await super.load(locator);
  }

  override async teardown(): Promise<void> {
    this.teardownCount += 1;
  }
}

function harness() {
  const provider: Provider = {
    id: "youtube-cache",
    label: "YouTube Cache",
    listTracks: () => [cachedTrack],
    searchTracks: (query) => query.toLocaleLowerCase() === "cached" ? [cachedTrack] : [],
    resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/cached-track.opus" }),
  };
  const player = new RecordingPlayer();
  const coordinator = new AppCoordinator({
    appState: createInitialAppState({ "youtube-cache": provider }),
    uiState: createInitialUiState(),
    queue: new MemoryQueue(),
    player,
  });
  return { coordinator, player };
}

describe("AppCoordinator with the narrow Provider", () => {
  test("Play Next queues a cached Track without starting playback", async () => {
    const { coordinator, player } = harness();

    await coordinator.dispatch({ type: "playNext", target: cachedTrack });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track)).toEqual([cachedTrack]);
    expect(coordinator.appState.queue.currentIndex).toBe(-1);
    expect(player.loaded).toEqual([]);
  });

  test("Play Now resolves a local Playback Locator and starts the cached Track", async () => {
    const { coordinator, player } = harness();

    await coordinator.dispatch({ type: "playNow", target: cachedTrack });

    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(cachedTrack.identity);
    expect(player.loaded).toEqual([{ kind: "file", path: "/cache/cached-track.opus" }]);
  });

  test("Add to Queue appends once without moving Current or starting playback", async () => {
    const { coordinator, player } = harness();
    const later: Track = {
      identity: { providerId: "youtube-cache", stableId: "later-track" },
      title: "Later Track",
      providerLabel: "YouTube Cache",
    };
    await coordinator.dispatch({ type: "playNow", target: cachedTrack });
    const loadsAfterPlayNow = player.loaded.length;

    await coordinator.dispatch({ type: "addToQueue", target: later });
    await coordinator.dispatch({ type: "addToQueue", target: cachedTrack });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["cached-track", "later-track"]);
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(player.loaded).toHaveLength(loadsAfterPlayNow);
  });

  test("Library Play Next moves an existing Track literally after Current without playing it", async () => {
    const { coordinator, player } = harness();
    const later: Track = {
      identity: { providerId: "youtube-cache", stableId: "later-track" },
      title: "Later Track",
      providerLabel: "YouTube Cache",
    };
    const last: Track = {
      identity: { providerId: "youtube-cache", stableId: "last-track" },
      title: "Last Track",
      providerLabel: "YouTube Cache",
    };
    await coordinator.dispatch({ type: "addToQueue", target: later });
    await coordinator.dispatch({ type: "addToQueue", target: last });
    await coordinator.dispatch({ type: "playNow", target: cachedTrack });
    const loadsAfterPlayNow = player.loaded.length;

    await coordinator.dispatch({ type: "playNext", target: last });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["cached-track", "last-track", "later-track"]);
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(player.loaded).toHaveLength(loadsAfterPlayNow);
  });

  test("playlist submission requires confirmation and Download Batch execution never changes Queue or playback", async () => {
    const provider: Provider = {
      id: "youtube-cache",
      label: "YouTube Cache",
      listTracks: () => [cachedTrack],
      searchTracks: () => [cachedTrack],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/cached-track.opus" }),
    };
    const player = new RecordingPlayer();
    const executed: string[] = [];
    const batch = {
      sourceUrl: "https://youtube.com/playlist?list=PL1",
      kind: "playlist" as const,
      entries: [],
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
      prepareDownloadBatch: async (url) => url.includes("playlist") ? ({
          kind: "confirmation-required",
          confirmation: { title: "Road Trip", itemCount: 12 },
          confirm: () => batch,
          cancel: () => ({ kind: "cancelled" }),
        }) : ({
          kind: "ready",
          batch: { sourceUrl: url, kind: "single", entries: [] },
        }),
      executeDownloadBatch: async (confirmed) => {
        executed.push(confirmed.sourceUrl);
        return { downloaded: 2, alreadyCached: 1, failed: 1, cancelled: 0, failures: [] };
      },
    });
    await coordinator.dispatch({ type: "playNow", target: cachedTrack });
    const queueBefore = structuredClone(coordinator.appState.queue);
    const playbackBefore = structuredClone(coordinator.appState.playback);
    const loadsBefore = player.loaded.length;

    await coordinator.dispatch({
      type: "downloadOperation",
      operation: "start",
      url: "https://youtube.com/watch?v=One00000001",
    });
    await waitFor(() => executed.length === 1);
    expect(coordinator.appState.queue).toEqual(queueBefore);
    expect(coordinator.appState.playback).toEqual(playbackBefore);

    await coordinator.dispatch({
      type: "downloadOperation",
      operation: "start",
      url: "https://youtube.com/playlist?list=PL1",
    });
    await waitFor(() => coordinator.appState.downloads.confirmation !== undefined);
    expect(executed).toEqual(["https://youtube.com/watch?v=One00000001"]);
    expect(coordinator.appState.downloads.confirmation).toEqual({ title: "Road Trip", itemCount: 12 });

    await coordinator.dispatch({ type: "downloadOperation", operation: "confirm-playlist" });
    await waitFor(() => coordinator.appState.downloads.summary !== undefined);
    expect(executed).toEqual(["https://youtube.com/watch?v=One00000001", batch.sourceUrl]);
    expect(coordinator.appState.downloads.summary).toEqual({
      downloaded: 2, alreadyCached: 1, failed: 1, cancelled: 0,
    });
    expect(coordinator.appState.queue).toEqual(queueBefore);
    expect(coordinator.appState.playback).toEqual(playbackBefore);
    expect(player.loaded).toHaveLength(loadsBefore);
  });

  test("Download Pipeline is FIFO, removes pending work, and continues after active-batch cancellation", async () => {
    const player = new RecordingPlayer();
    const started: string[] = [];
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": {
        id: "youtube-cache",
        label: "YouTube Cache",
        listTracks: () => [],
        searchTracks: () => [],
        resolvePlaybackLocator: async () => ({ kind: "file", path: "/unused" }),
      } }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
      prepareDownloadBatch: async (url) => ({
        kind: "ready",
        batch: { sourceUrl: url, kind: "single", entries: [] },
      }),
      executeDownloadBatch: async (batch, options) => {
        started.push(batch.sourceUrl);
        if (batch.sourceUrl.endsWith("/one")) {
          await waitFor(() => options.signal?.aborted === true);
          return { downloaded: 0, alreadyCached: 0, failed: 0, cancelled: 1, failures: [] };
        }
        return { downloaded: 1, alreadyCached: 0, failed: 0, cancelled: 0, failures: [] };
      },
    });

    await coordinator.dispatch({ type: "downloadOperation", operation: "start", url: "https://youtu.be/one" });
    await coordinator.dispatch({ type: "downloadOperation", operation: "start", url: "https://youtu.be/two" });
    await coordinator.dispatch({ type: "downloadOperation", operation: "start", url: "https://youtu.be/three" });
    await waitFor(() => coordinator.appState.downloads.pendingBatches.length === 2);
    expect(started).toEqual(["https://youtu.be/one"]);
    const pendingTwo = coordinator.appState.downloads.pendingBatches[0]!;

    await coordinator.dispatch({ type: "downloadOperation", operation: "remove-pending", batchId: pendingTwo.id });
    await coordinator.dispatch({ type: "downloadOperation", operation: "cancel-active" });
    await waitFor(() => coordinator.appState.downloads.summaries.length === 2);

    expect(started).toEqual(["https://youtu.be/one", "https://youtu.be/three"]);
    expect(coordinator.appState.downloads.summaries.map((summary) => summary.sourceUrl)).toEqual([
      "https://youtu.be/one",
      "https://youtu.be/three",
    ]);
  });

  test("quit with Download Pipeline work requires confirmation before cancelling all work", async () => {
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": {
        id: "youtube-cache", label: "YouTube Cache", listTracks: () => [], searchTracks: () => [],
        resolvePlaybackLocator: async () => ({ kind: "file", path: "/unused" }),
      } }),
      uiState: createInitialUiState(), queue: new MemoryQueue(), player,
      prepareDownloadBatch: async (url) => ({ kind: "ready", batch: { sourceUrl: url, kind: "single", entries: [] } }),
      executeDownloadBatch: async (_batch, options) => {
        await waitFor(() => options.signal?.aborted === true);
        return { downloaded: 0, alreadyCached: 0, failed: 0, cancelled: 1, failures: [] };
      },
    });
    await coordinator.dispatch({ type: "downloadOperation", operation: "start", url: "https://youtu.be/one" });
    await coordinator.dispatch({ type: "downloadOperation", operation: "start", url: "https://youtu.be/two" });
    await waitFor(() => coordinator.appState.downloads.pendingBatches.length === 1);

    await coordinator.dispatch({ type: "playerOperation", operation: "quit" });
    expect(coordinator.appState.downloads.quitConfirmationRequired).toBe(true);
    expect(player.teardownCount).toBe(0);

    await coordinator.dispatch({ type: "downloadOperation", operation: "confirm-quit" });
    await waitFor(() => player.teardownCount === 1);
    expect(coordinator.appState.downloads.pendingBatches).toEqual([]);
  });

  test("quit confirmation includes a submission still in preflight and confirmed quit aborts it", async () => {
    const player = new RecordingPlayer();
    let preflightAborted = false;
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": {
        id: "youtube-cache", label: "YouTube Cache", listTracks: () => [], searchTracks: () => [],
        resolvePlaybackLocator: async () => ({ kind: "file", path: "/unused" }),
      } }),
      uiState: createInitialUiState(), queue: new MemoryQueue(), player,
      prepareDownloadBatch: async (_url, options) => {
        await waitFor(() => options.signal?.aborted === true);
        preflightAborted = true;
        return { kind: "rejected", message: "cancelled" };
      },
    });
    await coordinator.dispatch({ type: "downloadOperation", operation: "start", url: "https://youtu.be/one" });
    await waitFor(() => coordinator.appState.downloads.preparingSubmissions === 1);

    await coordinator.dispatch({ type: "playerOperation", operation: "quit" });
    expect(coordinator.appState.downloads.quitConfirmationRequired).toBe(true);
    expect(player.teardownCount).toBe(0);

    await coordinator.dispatch({ type: "downloadOperation", operation: "confirm-quit" });
    expect(preflightAborted).toBe(true);
    expect(player.teardownCount).toBe(1);
  });

  test("confirmed quit during dependency refresh never starts download preflight", async () => {
    const player = new RecordingPlayer();
    let finishRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { finishRefresh = resolve; });
    let refreshStarted = false;
    let preflightStarted = false;
    const appState = createInitialAppState({ "youtube-cache": {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [], searchTracks: () => [],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/unused" }),
    } });
    const coordinator = new AppCoordinator({
      appState, uiState: createInitialUiState(), queue: new MemoryQueue(), player,
      refreshDependencyHealth: async (_helper, current) => {
        refreshStarted = true;
        await refreshGate;
        return current;
      },
      prepareDownloadBatch: async () => {
        preflightStarted = true;
        return { kind: "rejected", message: "unexpected" };
      },
    });
    await coordinator.dispatch({ type: "downloadOperation", operation: "start", url: "https://youtu.be/one" });
    await waitFor(() => refreshStarted);
    await coordinator.dispatch({ type: "playerOperation", operation: "quit" });
    const confirmedQuit = coordinator.dispatch({ type: "downloadOperation", operation: "confirm-quit" });
    finishRefresh();
    await confirmedQuit;

    expect(preflightStarted).toBe(false);
    expect(player.teardownCount).toBe(1);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("timed out waiting for app state");
}
