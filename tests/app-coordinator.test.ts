import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  AppCoordinator,
  MemoryQueue,
  NoopPlayer,
  NAVIGATION_TARGETS,
  createInitialAppState,
  createInitialUiState,
  createSkeletonProviders,
  type Player,
  type PlaybackLocator,
  type Provider,
  type Track,
  type TrackIdentity,
} from "../src/index";

function track(providerId: string, stableId: string, title: string): Track {
  return {
    identity: { providerId, stableId },
    title,
    providerLabel: providerId,
  };
}

function fakeProvider(id: string, tracks: Track[] = []): Provider {
  return {
    id,
    label: id,
    hint: "fake provider",
    listVisibleTracks() {
      return tracks;
    },
    async resolvePlaybackLocator(identity: TrackIdentity): Promise<PlaybackLocator> {
      return { kind: "file", path: `/resolved/${identity.providerId}/${identity.stableId}` };
    },
  };
}

class RecordingPlayer extends NoopPlayer implements Player {
  readonly loaded: PlaybackLocator[] = [];

  async load(locator: PlaybackLocator): Promise<void> {
    this.loaded.push(locator);
    await super.load(locator);
  }
}

describe("AppCoordinator", () => {
  test("starts empty on the target switcher with separate app and UI state", () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createSkeletonProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });

    coordinator.start([]);

    expect(coordinator.appState.queue.entries).toEqual([]);
    expect(coordinator.appState.startupMode).toBe("empty");
    expect(coordinator.uiState.focusedPane).toBe("targets");
    expect(coordinator.uiState.activeTargetId).toBe("local");
    expect(coordinator.appState).not.toBe(coordinator.uiState);
  });

  test("starts with CLI file args as canonical local Tracks without playback locators", () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createSkeletonProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });

    coordinator.start(["./music/amber.flac", "/tmp/cinder.mp3"]);

    expect(coordinator.appState.startupMode).toBe("cli-seeded");
    expect(coordinator.uiState.activeTargetId).toBe("queue");
    expect(coordinator.uiState.focusedPane).toBe("queue");
    expect(coordinator.appState.queue.entries).toHaveLength(2);
    expect(coordinator.appState.queue.entries[0]?.track).toMatchObject({
      identity: { providerId: "local", stableId: resolve("./music/amber.flac") },
      title: "amber.flac",
      providerLabel: "Local",
    });
    expect(coordinator.appState.queue.entries[0]?.track).not.toHaveProperty("playbackLocator");
  });

  test("routes navigation intents through the coordinator into UI State", () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createSkeletonProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });

    coordinator.start([]);
    coordinator.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });
    coordinator.dispatch({ type: "moveSelection", delta: 1 });

    expect(coordinator.uiState.activeTargetId).toBe("navidrome");
    expect(coordinator.uiState.focusedPane).toBe("content");
    expect(coordinator.uiState.selectedContentIndexByTarget.navidrome).toBe(1);
    expect(coordinator.appState.queue.entries).toEqual([]);
  });

  test("uses Provider, Queue, and Player boundaries to start the selected queue entry", async () => {
    const localTrack = track("local", "/music/amber.flac", "Amber Path");
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [localTrack]),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    coordinator.start([]);
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity)).toEqual([
      { providerId: "local", stableId: "/music/amber.flac" },
    ]);
    expect(player.loaded).toEqual([{ kind: "file", path: "/resolved/local//music/amber.flac" }]);
    expect(coordinator.appState.playback.status).toBe("playing");
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(localTrack.identity);
  });

  test("keeps all issue-15 navigation targets as siblings", () => {
    expect(NAVIGATION_TARGETS.map((target) => target.id)).toEqual([
      "local",
      "navidrome",
      "offline-youtube-cache",
      "youtube-url-download",
      "queue",
    ]);
  });
});
