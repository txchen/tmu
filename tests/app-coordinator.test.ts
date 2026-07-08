import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppCoordinator,
  InMemoryLastQueueSnapshotPersistence,
  MemoryQueue,
  NoopPlayer,
  NAVIGATION_TARGETS,
  createTmuApp,
  createDefaultDependencyHealth,
  createInitialAppState,
  createInitialUiState,
  createDefaultProviders,
  renderShellText,
  type DependencyCommandRunner,
  type LocalOpenOptions,
  type LocalOpenResult,
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

function cancellableLocalProvider(): Provider & {
  observedSignal: AbortSignal | null;
  createTrackFromCliArg(path: string): Promise<Track | undefined>;
  createTracksFromOpenPath(path: string, options?: LocalOpenOptions): Promise<LocalOpenResult>;
  onTrackMetadataChange(listener: (track: Track) => void): () => void;
} {
  return {
    id: "local",
    label: "Local",
    hint: "files and folders",
    observedSignal: null,
    listVisibleTracks() {
      return [];
    },
    async resolvePlaybackLocator(identity: TrackIdentity): Promise<PlaybackLocator> {
      return { kind: "file", path: identity.stableId };
    },
    async createTrackFromCliArg(_path: string): Promise<Track | undefined> {
      return undefined;
    },
    async createTracksFromOpenPath(_path: string, options: LocalOpenOptions = {}): Promise<LocalOpenResult> {
      this.observedSignal = options.signal ?? null;
      if (!options.signal) return { tracks: [], capped: false, cancelled: false };
      return await new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => {
          resolve({ tracks: [], capped: false, cancelled: true });
        }, { once: true });
      });
    },
    onTrackMetadataChange(_listener: (track: Track) => void): () => void {
      return () => undefined;
    },
  };
}

function restoringLocalProvider(
  options: {
    tracks?: Track[];
    unavailableStableIds?: readonly string[];
  } = {},
): Provider & {
  resolveCalls: TrackIdentity[];
  cliArgCalls: string[];
  openPathCalls: string[];
  createTrackFromCliArg(path: string): Promise<Track | undefined>;
  createTracksFromOpenPath(path: string, options?: LocalOpenOptions): Promise<LocalOpenResult>;
  onTrackMetadataChange(listener: (track: Track) => void): () => void;
} {
  const unavailable = new Set(options.unavailableStableIds ?? []);

  return {
    id: "local",
    label: "Local",
    hint: "files and folders",
    resolveCalls: [],
    cliArgCalls: [],
    openPathCalls: [],
    listVisibleTracks() {
      return options.tracks ?? [];
    },
    async resolvePlaybackLocator(identity: TrackIdentity): Promise<PlaybackLocator> {
      this.resolveCalls.push(identity);
      if (unavailable.has(identity.stableId)) {
        throw new Error(`Local file no longer exists: ${identity.stableId}`);
      }
      return { kind: "file", path: identity.stableId };
    },
    async createTrackFromCliArg(path: string): Promise<Track | undefined> {
      this.cliArgCalls.push(path);
      return undefined;
    },
    async createTracksFromOpenPath(path: string): Promise<LocalOpenResult> {
      this.openPathCalls.push(path);
      return { tracks: [], capped: false, cancelled: false };
    },
    onTrackMetadataChange(_listener: (track: Track) => void): () => void {
      return () => undefined;
    },
  };
}

async function waitFor(assertion: () => void, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(5);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
      appState: createInitialAppState(createDefaultProviders()),
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

  test("starts with CLI file args as canonical local Tracks without playback locators", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-cli-seed-"));
    const amber = join(dir, "amber.flac");
    const cinder = join(dir, "cinder.mp3");

    try {
      await writeFile(amber, "not real audio");
      await writeFile(cinder, "not real audio");
      const coordinator = new AppCoordinator({
        appState: createInitialAppState(createDefaultProviders()),
        uiState: createInitialUiState(),
        queue: new MemoryQueue(),
        player: new NoopPlayer(),
      });

      await coordinator.start([amber, cinder]);

      expect(coordinator.appState.startupMode).toBe("cli-seeded");
      expect(coordinator.uiState.activeTargetId).toBe("queue");
      expect(coordinator.uiState.focusedPane).toBe("queue");
      await waitFor(() => {
        expect(coordinator.appState.queue.entries).toHaveLength(2);
      });
      expect(coordinator.appState.queue.entries[0]?.track).toMatchObject({
        identity: { providerId: "local", stableId: await realpath(amber) },
        title: "amber.flac",
        providerLabel: "Local",
      });
      expect(coordinator.appState.queue.entries[0]?.track).not.toHaveProperty("playbackLocator");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lazy local metadata updates App State and notifies TUI subscribers without blocking enqueue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-cli-metadata-"));
    const file = join(dir, "plain-name.flac");
    let resolveMetadata!: () => void;
    const metadataReady = new Promise<void>((resolve) => {
      resolveMetadata = resolve;
    });
    const runner: DependencyCommandRunner = async () => {
      await metadataReady;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          format: {
            duration: "193.5",
            tags: {
              title: "Tagged Title",
              artist: "Tagged Artist",
              album: "Tagged Album",
            },
          },
        }),
        stderr: "",
      };
    };

    try {
      await writeFile(file, "not real audio");
      const { coordinator } = createTmuApp({
        dependencyRunner: runner,
        dependencyHealth: createDefaultDependencyHealth(),
      });
      let stateChanges = 0;
      coordinator.onStateChange(() => {
        stateChanges += 1;
      });

      await coordinator.start([file]);
      const canonicalFile = await realpath(file);

      await waitFor(() => {
        expect(coordinator.appState.queue.entries[0]?.track).toMatchObject({
          title: "plain-name.flac",
          identity: { providerId: "local", stableId: canonicalFile },
        });
      });
      const stateChangesBeforeMetadata = stateChanges;

      resolveMetadata();

      await waitFor(() => {
        expect(coordinator.appState.queue.entries[0]?.track).toMatchObject({
          title: "Tagged Title",
          artist: "Tagged Artist",
          album: "Tagged Album",
          durationSeconds: 193.5,
        });
      });
      expect(stateChanges).toBeGreaterThan(stateChangesBeforeMetadata);
      expect(renderShellText(coordinator.appState, coordinator.uiState)).toContain("Tagged Title [queued]");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads CLI-seeded Local Tracks through the App Coordinator into the Player", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-cli-playback-"));
    const file = join(dir, "play-me.mp3");
    const player = new RecordingPlayer();

    try {
      await writeFile(file, "not real audio");
      const { coordinator } = createTmuApp({
        player,
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            ffprobe: { name: "ffprobe", command: "/missing/ffprobe", status: "missing" },
          },
          metadata: {
            degraded: true,
            message: "Metadata degraded: ffprobe missing at /missing/ffprobe",
          },
        }),
      });

      await coordinator.start([file]);
      await waitFor(() => {
        expect(coordinator.appState.queue.entries).toHaveLength(1);
      });
      await coordinator.dispatch({ type: "startSelectedQueueEntry" });

      expect(player.loaded).toEqual([{ kind: "file", path: await realpath(file) }]);
      expect(coordinator.appState.playback.status).toBe("playing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("opens a local directory from the Provider Browsing Surface and enqueues into the shared Queue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-open-"));
    const album = join(dir, "album");
    const first = join(album, "01-first.flac");
    const second = join(album, "02-second.mp3");

    try {
      await mkdir(album, { recursive: true });
      await writeFile(first, "not real audio");
      await writeFile(second, "not real audio");
      const { coordinator } = createTmuApp({
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            ffprobe: { name: "ffprobe", command: "ffprobe", status: "missing" },
          },
          metadata: {
            degraded: true,
            message: "Metadata degraded: ffprobe missing at ffprobe",
          },
        }),
      });

      await coordinator.start([]);
      await coordinator.dispatch({ type: "openLocalPath", path: album });

      expect(coordinator.uiState.activeTargetId).toBe("local");
      expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity.stableId)).toEqual([
        await realpath(first),
        await realpath(second),
      ]);
      expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual([
        "01-first.flac",
        "02-second.mp3",
      ]);
      expect(coordinator.appState.lastEvent).toBe("added 2 Local Tracks to shared Queue");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("reports cancelled local open without enqueueing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-open-"));
    const controller = new AbortController();
    controller.abort();

    try {
      await writeFile(join(dir, "song.mp3"), "not real audio");
      const { coordinator } = createTmuApp();

      await coordinator.start([]);
      await coordinator.dispatch({ type: "openLocalPath", path: dir, signal: controller.signal });

      expect(coordinator.appState.queue.entries).toEqual([]);
      expect(coordinator.appState.lastEvent).toBe("cancelled Local open after 0 Tracks");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("opens the Local path prompt from the TUI intent surface", async () => {
    const { coordinator } = createTmuApp();

    await coordinator.start([]);
    await coordinator.dispatch({ type: "openLocalPathPrompt" });
    await coordinator.dispatch({ type: "setPromptInput", value: "/music/album" });

    expect(coordinator.uiState.activeTargetId).toBe("local");
    expect(coordinator.uiState.focusedPane).toBe("content");
    expect(coordinator.uiState.activePrompt).toBe("local-open-path");
    expect(coordinator.uiState.promptInput).toBe("/music/album");
  });

  test("cancels an active Local open submitted from the prompt", async () => {
    const local = cancellableLocalProvider();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ local }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });

    await coordinator.start([]);
    await coordinator.dispatch({ type: "openLocalPathPrompt" });
    await coordinator.dispatch({ type: "setPromptInput", value: "/music/huge" });
    await coordinator.dispatch({ type: "submitPrompt" });

    await waitFor(() => {
      expect(local.observedSignal).not.toBeNull();
    });
    await coordinator.dispatch({ type: "cancelLocalOpen" });

    await waitFor(() => {
      expect(coordinator.appState.lastEvent).toBe("cancelled Local open after 0 Tracks");
    });
    expect(coordinator.appState.queue.entries).toEqual([]);
  });

  test("routes navigation intents through the coordinator into UI State", () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
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
      appState: createInitialAppState(createDefaultProviders()),
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
      appState: createInitialAppState(createDefaultProviders()),
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
      appState: createInitialAppState(createDefaultProviders()),
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

  test("marks missing restored Local Tracks unavailable without rescanning local paths", async () => {
    const missing = track("local", "/music/missing.flac", "Missing File");
    const present = track("local", "/music/present.flac", "Present File");
    const local = restoringLocalProvider({
      tracks: [missing, present],
      unavailableStableIds: [missing.identity.stableId],
    });
    const snapshotPersistence = new InMemoryLastQueueSnapshotPersistence();
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ local }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
      snapshotPersistence,
    });

    await snapshotPersistence.save({
      version: 1,
      entries: [
        { track: missing, availability: { status: "unknown" } },
        { track: present, availability: { status: "unknown" } },
      ],
      currentIndex: 0,
      shuffle: false,
      repeatAll: false,
      volume: { percent: 87, ready: true },
    });

    await coordinator.start([]);
    await coordinator.dispatch({ type: "restoreLastQueueSnapshot" });

    expect(local.resolveCalls.map((identity) => identity.stableId)).toEqual([
      "/music/missing.flac",
      "/music/present.flac",
    ]);
    expect(local.cliArgCalls).toEqual([]);
    expect(local.openPathCalls).toEqual([]);
    expect(coordinator.appState.queue.entries).toHaveLength(2);
    expect(coordinator.appState.queue.entries[0]?.availability).toEqual({
      status: "unavailable",
      reason: "Local file no longer exists: /music/missing.flac",
    });
    expect(coordinator.appState.queue.entries[1]?.availability).toEqual({ status: "available" });
    expect(renderShellText(coordinator.appState, coordinator.uiState)).toContain(
      "Missing File [unavailable: Local file no longer exists: /music/missing.flac]",
    );

    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    expect(player.loaded).toEqual([]);
    expect(coordinator.appState.queue.entries).toHaveLength(2);
    expect(coordinator.appState.playback).toEqual({
      status: "error",
      currentTrackIdentity: missing.identity,
      message: "Local file no longer exists: /music/missing.flac",
    });
  });

  test("skips unavailable Local Tracks during next-track auto-advance", async () => {
    const first = track("local", "/music/first.flac", "First File");
    const missing = track("local", "/music/missing.flac", "Missing File");
    const next = track("local", "/music/next.flac", "Next File");
    const local = restoringLocalProvider({
      tracks: [first, missing, next],
      unavailableStableIds: [missing.identity.stableId],
    });
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ local }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    await coordinator.start([]);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "moveSelection", delta: -2 });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });
    await coordinator.dispatch({ type: "nextTrack" });

    expect(player.loaded).toEqual([
      { kind: "file", path: "/music/first.flac" },
      { kind: "file", path: "/music/next.flac" },
    ]);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(next.identity);
    expect(coordinator.appState.queue.currentIndex).toBe(2);
    expect(coordinator.appState.queue.entries[1]?.availability).toEqual({
      status: "unavailable",
      reason: "Local file no longer exists: /music/missing.flac",
    });
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
      appState: createInitialAppState(createDefaultProviders()),
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
      appState: createInitialAppState(createDefaultProviders()),
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
