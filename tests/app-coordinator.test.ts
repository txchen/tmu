import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  AppCoordinator,
  InMemoryLastQueueSnapshotPersistence,
  MemoryQueue,
  NoopPlayer,
  NAVIGATION_TARGETS,
  createDefaultDependencyHealth,
  createInitialAppState,
  createInitialUiState,
  createSkeletonProviders,
  type Player,
  type PlayerPlaybackState,
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
  readonly seeks: number[] = [];
  readonly volumes: number[] = [];
  toggles = 0;
  stops = 0;
  teardowns = 0;

  async load(locator: PlaybackLocator): Promise<void> {
    this.loaded.push(locator);
    await super.load(locator);
  }

  async togglePause() {
    this.toggles += 1;
    return super.togglePause();
  }

  async stop() {
    this.stops += 1;
    return super.stop();
  }

  async seekBy(seconds: number) {
    this.seeks.push(seconds);
    return super.seekBy(seconds);
  }

  async setVolume(percent: number) {
    this.volumes.push(percent);
    return super.setVolume(percent);
  }

  async teardown() {
    this.teardowns += 1;
    await super.teardown();
  }
}

class FailingThenRecoveringPlayer extends RecordingPlayer {
  failNextSeek = true;

  async seekBy(seconds: number) {
    if (this.failNextSeek) {
      this.failNextSeek = false;
      await super.seekBy(seconds);
      throw new Error("mpv error: seek failed");
    }
    return super.seekBy(seconds);
  }
}

class LoadFailingPlayer extends RecordingPlayer {
  async load(locator: PlaybackLocator): Promise<void> {
    this.loaded.push(locator);
    throw new Error("mpv error: load failed");
  }
}

class StopFailingPlayer extends RecordingPlayer {
  async stop(): Promise<PlayerPlaybackState> {
    this.stops += 1;
    throw new Error("mpv error: stop failed");
  }
}

class VolumeFailingPlayer extends RecordingPlayer {
  async setVolume(percent: number): Promise<PlayerPlaybackState> {
    this.volumes.push(percent);
    throw new Error("mpv error: volume failed");
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
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
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

  test("routes playback controls through the Player after a Track is resolved", async () => {
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
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });
    await coordinator.dispatch({ type: "togglePlayPause" });
    await coordinator.dispatch({ type: "togglePlayPause" });
    await coordinator.dispatch({ type: "seekBy", seconds: 15 });
    await coordinator.dispatch({ type: "setVolume", percent: 73, ready: true });
    await coordinator.dispatch({ type: "adjustVolume", delta: 40 });
    await coordinator.dispatch({ type: "stop" });

    expect(player.loaded).toEqual([{ kind: "file", path: "/resolved/local//music/amber.flac" }]);
    expect(player.toggles).toBe(2);
    expect(player.seeks).toEqual([15]);
    expect(player.volumes).toEqual([73, 100]);
    expect(player.stops).toBe(1);
    expect(coordinator.appState.volume).toEqual({ percent: 100, ready: true });
    expect(coordinator.appState.playback.status).toBe("stopped");
  });

  test("keeps recoverable Player command errors in App State and allows later controls", async () => {
    const localTrack = track("local", "/music/amber.flac", "Amber Path");
    const player = new FailingThenRecoveringPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [localTrack]),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    coordinator.start([]);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });
    await coordinator.dispatch({ type: "seekBy", seconds: 5 });

    expect(coordinator.appState.lastEvent).toBe("mpv error: seek failed");
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(localTrack.identity);

    await coordinator.dispatch({ type: "stop" });

    expect(player.stops).toBe(1);
    expect(coordinator.appState.playback.status).toBe("stopped");
  });

  test("does not overwrite failed Player control errors with success events", async () => {
    const localTrack = track("local", "/music/amber.flac", "Amber Path");
    const stopPlayer = new StopFailingPlayer();
    const stopCoordinator = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [localTrack]),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: stopPlayer,
    });

    stopCoordinator.start([]);
    await stopCoordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
    await stopCoordinator.dispatch({ type: "enqueueSelectedTrack" });
    await stopCoordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await stopCoordinator.dispatch({ type: "startSelectedQueueEntry" });
    await stopCoordinator.dispatch({ type: "stop" });

    expect(stopCoordinator.appState.lastEvent).toBe("mpv error: stop failed");

    const volumePlayer = new VolumeFailingPlayer();
    const volumeCoordinator = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [localTrack]),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: volumePlayer,
    });

    volumeCoordinator.start([]);
    await volumeCoordinator.dispatch({ type: "setVolume", percent: 71, ready: true });

    expect(volumeCoordinator.appState.lastEvent).toBe("mpv error: volume failed");
    expect(volumeCoordinator.appState.volume).toEqual({ percent: 100, ready: false });
  });

  test("keeps Player load failures local to playback state without marking Track unavailable", async () => {
    const localTrack = track("local", "/music/amber.flac", "Amber Path");
    const player = new LoadFailingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [localTrack]),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    coordinator.start([]);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    expect(player.loaded).toEqual([{ kind: "file", path: "/resolved/local//music/amber.flac" }]);
    expect(coordinator.appState.lastEvent).toBe("mpv error: load failed");
    expect(coordinator.appState.queue.entries[0]?.availability).toEqual({ status: "unknown" });
  });

  test("tears down the Player boundary when the coordinator exits", async () => {
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createSkeletonProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    await coordinator.teardown();

    expect(player.teardowns).toBe(1);
  });

  test("quit intent tears down the Player through the App Coordinator", async () => {
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createSkeletonProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    await coordinator.dispatch({ type: "quit" });
    await coordinator.teardown();

    expect(player.teardowns).toBe(1);
    expect(coordinator.appState.lastEvent).toBe("quit requested");
  });

  test("notifies subscribers when Player state changes outside input dispatch", async () => {
    const player = new NoopPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createSkeletonProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });
    const states: string[] = [];

    const unsubscribe = coordinator.onStateChange(() => {
      states.push(coordinator.appState.playback.status);
    });

    await player.load({ kind: "file", path: "/music/amber.flac" });
    unsubscribe();
    await player.stop();

    expect(states).toEqual(["playing"]);
  });

  test("drives queue remove, move, clear, next, previous, and modes through intents", async () => {
    const amber = track("local", "/music/amber.flac", "Amber Path");
    const cinder = track("local", "/music/cinder.mp3", "Cinder Room");
    const drift = track("local", "/music/drift.ogg", "Drift Signal");
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [amber, cinder, drift]),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue({ random: () => 0.99 }),
      player,
    });

    coordinator.start([]);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });

    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });
    await coordinator.dispatch({ type: "moveSelectedQueueEntry", delta: -2 });
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual([
      "Drift Signal",
      "Amber Path",
      "Cinder Room",
    ]);
    expect(coordinator.appState.queue.currentIndex).toBe(0);

    await coordinator.dispatch({ type: "nextTrack" });
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(amber.identity);

    await coordinator.dispatch({ type: "toggleRepeatAll" });
    await coordinator.dispatch({ type: "nextTrack" });
    await coordinator.dispatch({ type: "nextTrack" });
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(drift.identity);

    await coordinator.dispatch({ type: "toggleShuffle" });
    await coordinator.dispatch({ type: "nextTrack" });
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(cinder.identity);

    await coordinator.dispatch({ type: "previousTrack" });
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(drift.identity);

    await coordinator.dispatch({ type: "removeSelectedQueueEntry" });
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual([
      "Amber Path",
      "Cinder Room",
    ]);

    await coordinator.dispatch({ type: "clearQueue" });
    expect(coordinator.appState.queue.entries).toEqual([]);
    expect(coordinator.appState.queue.currentIndex).toBe(-1);
    expect(coordinator.appState.queue.shuffle).toBe(true);
    expect(coordinator.appState.queue.repeatAll).toBe(true);
  });

  test("saves and restores Last Queue Snapshot through a persistence adapter", async () => {
    const amber = track("local", "/music/amber.flac", "Amber Path");
    const snapshotPersistence = new InMemoryLastQueueSnapshotPersistence();
    const first = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [amber]),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
      snapshotPersistence,
    });

    first.start([]);
    await first.dispatch({ type: "enqueueSelectedTrack" });
    await first.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await first.dispatch({ type: "startSelectedQueueEntry" });
    await first.dispatch({ type: "toggleShuffle" });
    await first.dispatch({ type: "toggleRepeatAll" });
    await first.dispatch({ type: "setVolume", percent: 64, ready: true });
    await first.dispatch({ type: "saveLastQueueSnapshot" });

    const second = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [amber]),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
      snapshotPersistence,
    });

    second.start([]);
    await second.dispatch({ type: "restoreLastQueueSnapshot" });

    expect(second.appState.queue).toEqual({
      entries: [
        {
          track: amber,
          availability: { status: "available" },
        },
      ],
      currentIndex: 0,
      shuffle: true,
      repeatAll: true,
    });
    expect(second.appState.volume).toEqual({ percent: 64, ready: true });
    expect(second.appState.queue.entries[0]?.track).not.toHaveProperty("playbackLocator");
  });

  test("blocks playback actions when mpv dependency health is missing", async () => {
    const localTrack = track("local", "/music/amber.flac", "Amber Path");
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [localTrack]),
      }, {
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            mpv: { name: "mpv", command: "/missing/mpv", status: "missing" },
          },
          playback: {
            enabled: false,
            message: "Playback disabled: mpv missing at /missing/mpv",
          },
        }),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    coordinator.start([]);
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });
    await coordinator.dispatch({ type: "togglePlayPause" });
    await coordinator.dispatch({ type: "seekBy", seconds: 10 });
    await coordinator.dispatch({ type: "setVolume", percent: 41, ready: true });
    await coordinator.dispatch({ type: "stop" });

    expect(player.loaded).toEqual([]);
    expect(player.toggles).toBe(0);
    expect(player.seeks).toEqual([]);
    expect(player.volumes).toEqual([]);
    expect(player.stops).toBe(0);
    expect(coordinator.appState.playback).toEqual({
      status: "error",
      currentTrackIdentity: null,
      message: "Playback disabled: mpv missing at /missing/mpv",
    });
    expect(coordinator.appState.queue.entries[0]?.availability).toEqual({ status: "unknown" });
    expect(coordinator.appState.lastEvent).toBe("Playback disabled: mpv missing at /missing/mpv");
  });

  test("allows playback when only ffprobe dependency health is missing", async () => {
    const localTrack = track("local", "/music/amber.flac", "Amber Path");
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [localTrack]),
      }, {
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            ffprobe: { name: "ffprobe", command: "/missing/ffprobe", status: "missing" },
          },
          metadata: {
            degraded: true,
            message: "Metadata degraded: ffprobe missing at /missing/ffprobe",
          },
        }),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    coordinator.start([]);
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    expect(player.loaded).toEqual([{ kind: "file", path: "/resolved/local//music/amber.flac" }]);
    expect(coordinator.appState.playback.status).toBe("playing");
    expect(coordinator.appState.dependencyHealth.metadata.degraded).toBe(true);
  });

  test("rechecks yt-dlp when entering YouTube URL Download and before its action", async () => {
    const refreshedHealth = createDefaultDependencyHealth({
      helpers: {
        "yt-dlp": { name: "yt-dlp", command: "/missing/yt-dlp", status: "missing" },
      },
      youtubeUrlDownload: {
        enabled: false,
        message: "YouTube URL Download disabled: yt-dlp missing at /missing/yt-dlp",
      },
    });
    const refreshes: string[] = [];
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createSkeletonProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
      refreshDependencyHealth: async (helper) => {
        refreshes.push(helper);
        return refreshedHealth;
      },
    });

    coordinator.start([]);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "youtube-url-download" });
    expect(refreshes).toEqual(["yt-dlp"]);
    expect(coordinator.uiState.activePrompt).toBeNull();

    await coordinator.dispatch({ type: "enqueueSelectedTrack" });

    expect(refreshes).toEqual(["yt-dlp", "yt-dlp"]);
    expect(coordinator.uiState.activeTargetId).toBe("youtube-url-download");
    expect(coordinator.uiState.activePrompt).toBeNull();
    expect(coordinator.appState.lastEvent).toBe("YouTube URL Download disabled: yt-dlp missing at /missing/yt-dlp");
    expect(coordinator.appState.queue.entries).toEqual([]);
  });

  test("rechecks yt-dlp when target-rail movement enters YouTube URL Download", async () => {
    const refreshedHealth = createDefaultDependencyHealth();
    const refreshes: string[] = [];
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createSkeletonProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
      refreshDependencyHealth: async (helper) => {
        refreshes.push(helper);
        return refreshedHealth;
      },
    });

    coordinator.start([]);
    await coordinator.dispatch({ type: "moveSelection", delta: 3 });

    expect(coordinator.uiState.activeTargetId).toBe("youtube-url-download");
    expect(refreshes).toEqual(["yt-dlp"]);
  });

  test("keeps Local, Navidrome, and Offline YouTube Cache usable when only yt-dlp is missing", async () => {
    const localTrack = track("local", "/music/amber.flac", "Amber Path");
    const navidromeTrack = track("navidrome", "song-1", "Remote Track");
    const cachedTrack = track("offline-youtube-cache", "youtube:abc123", "Cached Track");
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [localTrack]),
        navidrome: fakeProvider("navidrome", [navidromeTrack]),
        "offline-youtube-cache": fakeProvider("offline-youtube-cache", [cachedTrack]),
      }, {
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            "yt-dlp": { name: "yt-dlp", command: "/missing/yt-dlp", status: "missing" },
          },
          youtubeUrlDownload: {
            enabled: false,
            message: "YouTube URL Download disabled: yt-dlp missing at /missing/yt-dlp",
          },
        }),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    coordinator.start([]);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "offline-youtube-cache" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity.providerId)).toEqual([
      "local",
      "navidrome",
      "offline-youtube-cache",
    ]);

    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    expect(player.loaded).toEqual([{ kind: "file", path: "/resolved/offline-youtube-cache/youtube:abc123" }]);
    expect(coordinator.appState.playback.status).toBe("playing");
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
