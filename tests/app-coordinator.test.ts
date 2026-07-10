import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { AppCoordinator } from "../src/coordinator";
import { PlaybackFailure, type PlaybackLocator, type Provider, type Track } from "../src/domain";
import { NoopPlayer } from "../src/player";
import { MemoryQueue } from "../src/queue";
import { createInitialAppState, createInitialUiState } from "../src/state";
import type { YouTubeCacheProvider } from "../src/youtube-cache";

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

class SelectivelyFailingPlayer extends RecordingPlayer {
  override async load(locator: PlaybackLocator): Promise<void> {
    if (locator.kind === "file" && locator.path.includes("bad")) throw new PlaybackFailure("mpv could not play cached file");
    await super.load(locator);
  }
}

class PlaybackFailingPlayer extends RecordingPlayer {
  failPlayback(message: string): void {
    this.updateState({ status: "error", failureKind: "playback", message });
  }
}

class CommandFailingPlayer extends RecordingPlayer {
  override async load(): Promise<void> {
    throw new Error("mpv IPC socket disconnected");
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

    coordinator.dispatchUi({ type: "setDownloaderInput", value: "https://youtube.com/watch?v=One00000001" });
    await coordinator.dispatch({
      type: "downloadOperation",
      operation: "start",
      url: "https://youtube.com/watch?v=One00000001",
    });
    await waitFor(() => executed.length === 1);
    expect(coordinator.uiState.downloader.urlInput).toBe("https://youtube.com/watch?v=One00000001");
    expect(coordinator.appState.downloads.acceptedSubmission).toEqual({
      id: 1, input: "https://youtube.com/watch?v=One00000001",
    });
    expect(coordinator.appState.queue).toEqual(queueBefore);
    expect(coordinator.appState.playback).toEqual(playbackBefore);

    coordinator.dispatchUi({ type: "setDownloaderInput", value: "https://youtube.com/playlist?list=PL1" });
    await coordinator.dispatch({
      type: "downloadOperation",
      operation: "start",
      url: "https://youtube.com/playlist?list=PL1",
    });
    await waitFor(() => coordinator.appState.downloads.confirmation !== undefined);
    expect(executed).toEqual(["https://youtube.com/watch?v=One00000001"]);
    expect(coordinator.appState.downloads.confirmation).toEqual({ title: "Road Trip", itemCount: 12 });
    expect(coordinator.uiState.downloader.urlInput).toBe("https://youtube.com/playlist?list=PL1");

    await coordinator.dispatch({ type: "downloadOperation", operation: "confirm-playlist" });
    await waitFor(() => coordinator.appState.downloads.summary !== undefined);
    expect(executed).toEqual(["https://youtube.com/watch?v=One00000001", batch.sourceUrl]);
    expect(coordinator.appState.downloads.acceptedSubmission).toEqual({
      id: 2, input: "https://youtube.com/playlist?list=PL1",
    });
    expect(coordinator.appState.downloads.summary).toEqual({
      downloaded: 2, alreadyCached: 1, failed: 1, cancelled: 0,
    });
    expect(coordinator.appState.queue).toEqual(queueBefore);
    expect(coordinator.appState.playback).toEqual(playbackBefore);
    expect(player.loaded).toHaveLength(loadsBefore);
  });

  test("Downloader keeps editable URL input after validation failure or cancelled playlist confirmation", async () => {
    const { coordinator } = harness();
    const playlistUrl = "https://youtube.com/playlist?list=PL1";
    const rejectedUrl = "https://example.com/not-youtube";
    const prepared = {
      kind: "confirmation-required" as const,
      confirmation: { title: "Road Trip", itemCount: 12 },
      confirm: () => ({ sourceUrl: playlistUrl, kind: "playlist" as const, entries: [] }),
      cancel: () => ({ kind: "cancelled" as const }),
    };
    const appState = createInitialAppState(coordinator.appState.providers);
    const next = new AppCoordinator({
      appState, uiState: createInitialUiState(), queue: new MemoryQueue(), player: new RecordingPlayer(),
      prepareDownloadBatch: async (url) => url === rejectedUrl
        ? { kind: "rejected", message: "YouTube Downloader rejects non-YouTube URLs" }
        : prepared,
    });

    next.dispatchUi({ type: "setDownloaderInput", value: rejectedUrl });
    await next.dispatch({ type: "downloadOperation", operation: "start", url: rejectedUrl });
    await waitFor(() => next.appState.lastEvent.includes("rejects"));
    expect(next.uiState.downloader.urlInput).toBe(rejectedUrl);

    next.dispatchUi({ type: "setDownloaderInput", value: playlistUrl });
    await next.dispatch({ type: "downloadOperation", operation: "start", url: playlistUrl });
    await waitFor(() => next.appState.downloads.confirmation !== undefined);
    await next.dispatch({ type: "downloadOperation", operation: "cancel-playlist" });
    expect(next.uiState.downloader.urlInput).toBe(playlistUrl);
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

  test("confirmed Cache Deletion recomputes playback state and retains the Current Queue entry unavailable", async () => {
    let deleted = false;
    const provider: YouTubeCacheProvider = {
      id: "youtube-cache", label: "YouTube Cache",
      listTracks: () => deleted ? [] : [cachedTrack],
      searchTracks: () => deleted ? [] : [cachedTrack],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/cached-track.opus" }),
      refresh: () => undefined,
      listCacheEntries: () => deleted ? [] : [{
        track: cachedTrack,
        availability: { status: "available" },
        metadata: {
          videoId: "cached-track", title: "Cached Track", uploader: "Cache Artist",
          cachedAt: "2026-01-01T00:00:00.000Z", mediaFileName: "cached-track.opus", container: "opus",
        },
        metadataPath: "/cache/cached-track.json", mediaPath: "/cache/cached-track.opus",
      }],
      listIncompleteEntries: () => [],
      findByIdentity: () => deleted ? undefined : ({
        track: cachedTrack, availability: { status: "available" },
        metadata: {
          videoId: "cached-track", title: "Cached Track", uploader: "Cache Artist",
          cachedAt: "2026-01-01T00:00:00.000Z", mediaFileName: "cached-track.opus", container: "opus",
        }, metadataPath: "/cache/cached-track.json", mediaPath: "/cache/cached-track.opus",
      }),
      deleteCacheEntry: async () => { deleted = true; return true; },
      cleanupIncompleteEntry: async () => false,
    };
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }),
      uiState: createInitialUiState(), queue: new MemoryQueue(), player,
    });
    await coordinator.dispatch({ type: "cacheOperation", operation: "request-delete", identity: cachedTrack.identity });
    expect(coordinator.appState.cacheConfirmation).toMatchObject({
      kind: "delete-track", stem: "cached-track", stopsPlayback: false,
    });
    expect(deleted).toBe(false);

    await coordinator.dispatch({ type: "playNow", target: cachedTrack });
    await coordinator.dispatch({ type: "cacheOperation", operation: "confirm" });
    expect(deleted).toBe(true);
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(coordinator.appState.queue.entries[0]?.availability).toMatchObject({ status: "unavailable" });
    expect(coordinator.appState.playback).toMatchObject({
      status: "stopped", positionSeconds: 0, currentTrackIdentity: cachedTrack.identity,
    });
  });

  test("direct Play Now fails on the requested unavailable Track without substituting another Queue Track", async () => {
    const bad = { ...cachedTrack, identity: { providerId: "youtube-cache", stableId: "bad-track" }, title: "Bad" };
    const good = { ...cachedTrack, identity: { providerId: "youtube-cache", stableId: "good-track" }, title: "Good" };
    const player = new SelectivelyFailingPlayer();
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [bad, good], searchTracks: () => [bad, good],
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player,
    });
    await coordinator.dispatch({ type: "addToQueue", target: good });
    await coordinator.dispatch({ type: "playNow", target: bad });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity.stableId)).toEqual(["bad-track", "good-track"]);
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(coordinator.appState.queue.entries[0]?.availability).toEqual({
      status: "unavailable", reason: "mpv could not play cached file",
    });
    expect(player.loaded).toEqual([]);
  });

  test("Next marks an mpv-failing Track unavailable and skips it without removing it", async () => {
    const first = { ...cachedTrack, identity: { providerId: "youtube-cache", stableId: "first-track" }, title: "First" };
    const bad = { ...cachedTrack, identity: { providerId: "youtube-cache", stableId: "bad-track" }, title: "Bad" };
    const good = { ...cachedTrack, identity: { providerId: "youtube-cache", stableId: "good-track" }, title: "Good" };
    const player = new SelectivelyFailingPlayer();
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [first, bad, good], searchTracks: () => [],
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player,
    });
    for (const track of [first, bad, good]) await coordinator.dispatch({ type: "addToQueue", target: track });
    await coordinator.dispatch({ type: "playNow", target: first });
    await coordinator.dispatch({ type: "playerOperation", operation: "next-track" });

    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(good.identity);
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["first-track", "bad-track", "good-track"]);
    expect(coordinator.appState.queue.entries[1]?.availability.status).toBe("unavailable");
  });

  test("asynchronous mpv failure marks Current unavailable and direct Resume does not retry or substitute", async () => {
    const player = new PlaybackFailingPlayer();
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [cachedTrack], searchTracks: () => [],
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player,
    });
    await coordinator.dispatch({ type: "playNow", target: cachedTrack });
    const loadsBeforeFailure = player.loaded.length;

    player.failPlayback("mpv playback failed: corrupt stream");
    await coordinator.dispatch({ type: "playerOperation", operation: "toggle-play-pause" });

    expect(coordinator.appState.queue.entries[0]?.availability).toEqual({
      status: "unavailable", reason: "mpv playback failed: corrupt stream",
    });
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(player.loaded).toHaveLength(loadsBeforeFailure);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(cachedTrack.identity);
  });

  test("asynchronous mpv failure automatically advances past the failed Track", async () => {
    const player = new PlaybackFailingPlayer();
    const next = { ...cachedTrack, identity: { providerId: "youtube-cache", stableId: "next-track" }, title: "Next" };
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [cachedTrack, next], searchTracks: () => [],
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player,
    });
    await coordinator.dispatch({ type: "addToQueue", target: next });
    await coordinator.dispatch({ type: "playNow", target: cachedTrack });

    player.failPlayback("mpv playback failed: corrupt stream");
    await waitFor(() => coordinator.appState.playback.currentTrackIdentity?.stableId === "next-track");

    expect(coordinator.appState.queue.entries[0]?.availability.status).toBe("unavailable");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["cached-track", "next-track"]);
  });

  test("mpv command failure stays actionable without marking the Track unavailable", async () => {
    const player = new CommandFailingPlayer();
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [cachedTrack], searchTracks: () => [],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/cached-track.opus" }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player,
    });
    await coordinator.dispatch({ type: "playNow", target: cachedTrack });

    expect(coordinator.appState.queue.entries[0]?.availability.status).not.toBe("unavailable");
    expect(coordinator.appState.playback).toMatchObject({ status: "error", message: "mpv IPC socket disconnected" });
  });

  test("restored Queue availability is rescanned from the current YouTube Cache", async () => {
    const provider: YouTubeCacheProvider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [], searchTracks: () => [],
      resolvePlaybackLocator: async () => { throw new Error("missing"); }, refresh: () => undefined,
      listCacheEntries: () => [], listIncompleteEntries: () => [], findByIdentity: () => undefined,
      deleteCacheEntry: async () => false, cleanupIncompleteEntry: async () => false,
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player: new RecordingPlayer(),
      snapshotPersistence: {
        load: async () => ({
          version: 1,
          entries: [{ track: cachedTrack }],
          currentIndex: 0,
          shuffle: false,
          repeatAll: false,
          volume: { percent: 100, ready: false },
          positionSeconds: 42,
        }),
        save: async () => undefined,
      },
    });
    await coordinator.start();

    expect(coordinator.appState.queue.entries[0]?.availability).toEqual({
      status: "unavailable", reason: "YouTube Cache entry is missing: cached-track",
    });
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(cachedTrack.identity);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await sleep(1);
  }
  throw new Error("timed out waiting for app state");
}
