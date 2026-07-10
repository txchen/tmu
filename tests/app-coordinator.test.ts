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
});
