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

  override async load(locator: PlaybackLocator): Promise<void> {
    this.loaded.push(locator);
    await super.load(locator);
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
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("timed out waiting for app state");
}
