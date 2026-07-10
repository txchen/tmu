import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppCoordinator,
  FileAppPreferencesPersistence,
  FileLastQueueSnapshotPersistence,
  InMemoryAppPreferencesPersistence,
  InMemoryLastQueueSnapshotPersistence,
  MemoryQueue,
  NoopPlayer,
  NAVIGATION_TARGETS,
  createTmuApp,
  createDefaultDependencyHealth,
  createDefaultTmuConfig,
  createInitialAppState,
  createInitialUiState,
  createDefaultProviders,
  createNavidromeProvider,
  writeOfflineYouTubeCacheMetadata,
  navigationTargetIndex,
  type NavidromeFetcher,
  type DependencyCommandRequest,
  type DependencyCommandRunner,
  type LocalOpenOptions,
  type LocalOpenResult,
  type Player,
  type PlayerPlaybackState,
  type PlaybackLocator,
  type Provider,
  type TmuConfigInput,
  type Track,
  type TrackIdentity,
  type YouTubeDownloader,
  type YouTubeDownloadOptions,
  type YouTubeDownloadResult,
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
  createTrackFromPath(path: string): Promise<Track | undefined>;
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
    async createTrackFromPath(_path: string): Promise<Track | undefined> {
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
  pathCalls: string[];
  openPathCalls: string[];
  createTrackFromPath(path: string): Promise<Track | undefined>;
  createTracksFromOpenPath(path: string, options?: LocalOpenOptions): Promise<LocalOpenResult>;
  onTrackMetadataChange(listener: (track: Track) => void): () => void;
} {
  const unavailable = new Set(options.unavailableStableIds ?? []);

  return {
    id: "local",
    label: "Local",
    hint: "files and folders",
    resolveCalls: [],
    pathCalls: [],
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
    async createTrackFromPath(path: string): Promise<Track | undefined> {
      this.pathCalls.push(path);
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

  async setPaused(paused: boolean) {
    this.toggles += 1;
    return super.setPaused(paused);
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

class FailingStopPlayer extends RecordingPlayer {
  async stop(): Promise<never> {
    this.stops += 1;
    throw new Error("Player stop failed");
  }
}

class ManualPlaybackPlayer implements Player {
  readonly loaded: PlaybackLocator[] = [];
  private state: PlayerPlaybackState = { status: "idle" };
  private readonly listeners = new Set<(state: PlayerPlaybackState) => void>();

  get playback(): PlayerPlaybackState {
    return this.state;
  }

  async start(): Promise<PlayerPlaybackState> {
    return this.state;
  }

  async load(locator: PlaybackLocator): Promise<void> {
    this.loaded.push(locator);
    this.emitPlaybackState({ status: "playing" });
  }

  async togglePause(): Promise<PlayerPlaybackState> {
    this.emitPlaybackState({ ...this.state, status: this.state.status === "playing" ? "paused" : "playing" });
    return this.state;
  }

  async setPaused(paused: boolean): Promise<PlayerPlaybackState> {
    this.emitPlaybackState({ ...this.state, status: paused ? "paused" : "playing", paused });
    return this.state;
  }

  async stop(): Promise<PlayerPlaybackState> {
    this.emitPlaybackState({ status: "stopped" });
    return this.state;
  }

  async seekBy(_seconds: number): Promise<PlayerPlaybackState> {
    return this.state;
  }

  async setVolume(percent: number): Promise<PlayerPlaybackState> {
    this.emitPlaybackState({ ...this.state, volumePercent: Math.max(0, Math.min(100, Math.round(percent))) });
    return this.state;
  }

  async teardown(): Promise<void> {
    return undefined;
  }

  onPlaybackStateChange(listener: (state: PlayerPlaybackState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitPlaybackState(state: PlayerPlaybackState): void {
    this.state = state;
    for (const listener of this.listeners) listener(this.state);
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

class LoadFailingOncePlayer extends RecordingPlayer {
  failed = false;

  async load(locator: PlaybackLocator): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      this.loaded.push(locator);
      throw new Error("mpv error: first load failed");
    }

    await super.load(locator);
  }
}

class LoadFailingForPathPlayer extends RecordingPlayer {
  constructor(private readonly failingPath: string) {
    super();
  }

  async load(locator: PlaybackLocator): Promise<void> {
    if (locator.kind === "file" && locator.path === this.failingPath) {
      this.loaded.push(locator);
      throw new Error(`mpv error: cannot load ${this.failingPath}`);
    }

    await super.load(locator);
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
  test("Play Next moves a Track after Current Track without starting playback", async () => {
    const a = track("local", "a", "A");
    const b = track("local", "b", "B");
    const c = track("local", "c", "C");
    const queue = new MemoryQueue();
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ local: fakeProvider("local") }),
      uiState: createInitialUiState(),
      queue,
      player,
    });
    for (const value of [a, b, c]) queue.enqueue(value);
    queue.startAt(1);
    coordinator.appState.playback.currentTrackIdentity = b.identity;

    await coordinator.dispatch({ type: "playNext", target: a });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["B", "A", "C"]);
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(player.loaded).toEqual([]);
  });

  test("Play Now moves a Music Collection into one block and starts its first Track", async () => {
    const a = track("local", "a", "A");
    const b = track("local", "b", "B");
    const c = track("local", "c", "C");
    const d = track("local", "d", "D");
    const queue = new MemoryQueue();
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ local: fakeProvider("local") }),
      uiState: createInitialUiState(),
      queue,
      player,
    });
    for (const value of [a, b, c]) queue.enqueue(value);
    queue.startAt(1);
    coordinator.appState.playback.currentTrackIdentity = b.identity;

    await coordinator.dispatch({
      type: "playNow",
      target: { kind: "music-collection", id: "set", label: "Set", tracks: [c, d, c] },
    });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["A", "B", "C", "D"]);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(c.identity);
    expect(player.loaded).toEqual([{ kind: "file", path: "/resolved/local/c" }]);
  });

  test("Play Now keeps the requested Track Current when playback is unavailable", async () => {
    const former = track("local", "former", "Former");
    const requested = track("local", "requested", "Requested");
    const queue = new MemoryQueue();
    queue.enqueue(former);
    queue.startAt(0);
    const dependencyHealth = createDefaultDependencyHealth();
    dependencyHealth.playback = { enabled: false, message: "Playback disabled: mpv not found" };
    const appState = createInitialAppState({ local: fakeProvider("local") }, { dependencyHealth });
    appState.playback.currentTrackIdentity = former.identity;
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState,
      uiState: createInitialUiState(),
      queue,
      player,
    });

    await coordinator.dispatch({ type: "playNow", target: requested });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track)).toEqual([former, requested]);
    expect(coordinator.appState.queue.currentIndex).toBe(1);
    expect(coordinator.appState.playback).toMatchObject({
      status: "error",
      positionSeconds: 0,
      currentTrackIdentity: requested.identity,
      message: "Playback disabled: mpv not found",
    });
    expect(player.loaded).toEqual([]);
  });

  test("resolves a Music Collection completely before applying its Queue transformation", async () => {
    const a = track("local", "a", "A");
    const b = track("remote", "b", "B");
    const c = track("remote", "c", "C");
    let queueSizeDuringResolution = -1;
    const queue = new MemoryQueue();
    queue.enqueue(a);
    const provider: Provider = {
      ...fakeProvider("remote"),
      async resolveMusicCollection() {
        queueSizeDuringResolution = queue.entries.length;
        return { status: "resolved", tracks: [b, c] };
      },
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ remote: provider }),
      uiState: createInitialUiState(),
      queue,
      player: new NoopPlayer(),
    });

    await coordinator.dispatch({
      type: "playNext",
      target: {
        kind: "music-collection",
        id: "remote:album:set",
        label: "Set",
        resolve: { providerId: "remote", operation: "album-tracks", collectionId: "set" },
      },
    });

    expect(queueSizeDuringResolution).toBe(1);
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["B", "C", "A"]);
  });

  test("keeps Queue and requesting overlay unchanged when Music Collection resolution fails or is cancelled", async () => {
    const a = track("local", "a", "A");
    const queue = new MemoryQueue();
    queue.enqueue(a);
    let outcome: "fail" | "cancel" = "fail";
    const provider: Provider = {
      ...fakeProvider("remote"),
      async resolveMusicCollection() {
        if (outcome === "fail") throw new Error("Provider is offline");
        return { status: "cancelled" };
      },
    };
    const uiState = createInitialUiState();
    uiState.overlays = [{
      kind: "music-picker",
      focus: "results",
      query: "set",
      selectedIdentity: null,
      scroll: 2,
    }];
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ remote: provider }),
      uiState,
      queue,
      player: new NoopPlayer(),
    });
    const target = {
      kind: "music-collection" as const,
      id: "remote:playlist:set",
      label: "Set",
      resolve: { providerId: "remote", operation: "playlist-tracks" as const, collectionId: "set" },
    };

    await coordinator.dispatch({ type: "playNext", target });
    expect(coordinator.appState.queue.entries.map((entry) => entry.track)).toEqual([a]);
    expect(coordinator.uiState.overlays).toEqual(uiState.overlays);
    expect(coordinator.appState.lastEvent).toContain("Provider is offline");

    outcome = "cancel";
    await coordinator.dispatch({ type: "playNow", target });
    expect(coordinator.appState.queue.entries.map((entry) => entry.track)).toEqual([a]);
    expect(coordinator.uiState.overlays).toEqual(uiState.overlays);
    expect(coordinator.appState.lastEvent).toBe("Music Collection resolution cancelled");
  });

  test("starts empty on the target switcher with separate app and UI state", async () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });

    await coordinator.start();

    expect(coordinator.appState.queue.entries).toEqual([]);
    expect(coordinator.uiState.focusedPane).toBe("targets");
    expect(coordinator.uiState.activeTargetId).toBe("local");
    expect(coordinator.appState).not.toBe(coordinator.uiState);
  });

  test("persists last selected Provider and restores it on startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-last-selected-provider-"));
    const preferencesPath = join(dir, "preferences.json");

    try {
      const first = new AppCoordinator({
        appState: createInitialAppState({
          local: fakeProvider("local"),
          navidrome: fakeProvider("navidrome"),
        }),
        uiState: createInitialUiState(),
        queue: new MemoryQueue(),
        player: new NoopPlayer(),
        appPreferencesPersistence: new FileAppPreferencesPersistence(preferencesPath),
      });

      await first.start();
      await first.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });
      await first.dispatch({ type: "selectNavigationTarget", targetId: "youtube-url-download" });

      const second = new AppCoordinator({
        appState: createInitialAppState({
          local: fakeProvider("local"),
          navidrome: fakeProvider("navidrome"),
        }),
        uiState: createInitialUiState(),
        queue: new MemoryQueue(),
        player: new NoopPlayer(),
        appPreferencesPersistence: new FileAppPreferencesPersistence(preferencesPath),
      });

      await second.start();

      expect(second.uiState.activeTargetId).toBe("navidrome");
      expect(second.uiState.focusedPane).toBe("targets");
      expect(second.uiState.selectedTargetIndex).toBe(navigationTargetIndex("navidrome"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("startup restores shuffle repeat-all and volume from preferences without a Last Queue Snapshot", async () => {
    const appPreferencesPersistence = new InMemoryAppPreferencesPersistence();
    const first = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
      appPreferencesPersistence,
    });

    await first.start();
    await first.dispatch({ type: "toggleShuffle" });
    await first.dispatch({ type: "toggleRepeatAll" });
    await first.dispatch({ type: "setVolume", percent: 36, ready: true });

    const second = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
      appPreferencesPersistence,
    });

    await second.start();

    expect(second.appState.queue.shuffle).toBe(true);
    expect(second.appState.queue.repeatAll).toBe(true);
    expect(second.appState.volume).toEqual({ percent: 36, ready: true });
  });

  test("startup restores Offline YouTube Cache snapshot entries from cache metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-offline-startup-restore-"));
    const snapshotPersistence = new InMemoryLastQueueSnapshotPersistence();

    try {
      await writeOfflineYouTubeCacheMetadata({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      }, {
        version: 1,
        extractor: "youtube",
        id: "cached-id",
        title: "Cached Metadata Title",
        artist: "Cached Artist",
        mediaFileName: "cached.opus",
      });
      await mkdir(join(dir, "youtube", "cached-id", "media"), { recursive: true });
      await writeFile(join(dir, "youtube", "cached-id", "media", "cached.opus"), "audio bytes");
      await snapshotPersistence.save({
        version: 1,
        entries: [
          {
            track: track("offline-youtube-cache", "youtube:cached-id", "Stale Snapshot Title"),
            availability: { status: "unknown" },
          },
        ],
        currentIndex: 0,
        shuffle: false,
        repeatAll: false,
        volume: { percent: 77, ready: true },
      });

      const { coordinator } = createTmuApp({
        config: {
          offlineYouTubeCache: {
            cacheDir: dir,
            mediaDirName: "media",
            metadataFileName: "metadata.json",
          },
        },
        snapshotPersistence,
      });

      await coordinator.start();

      expect(coordinator.appState.queue.entries[0]).toMatchObject({
        track: {
          identity: { providerId: "offline-youtube-cache", stableId: "youtube:cached-id" },
          title: "Cached Metadata Title",
          artist: "Cached Artist",
        },
        availability: { status: "available" },
      });
      expect(coordinator.appState.volume).toEqual({ percent: 77, ready: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers from missing or corrupted persistence files during startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-corrupt-persistence-"));
    const snapshotPath = join(dir, "last-queue.json");
    const preferencesPath = join(dir, "preferences.json");

    try {
      await writeFile(snapshotPath, "{not-json");
      await writeFile(preferencesPath, "{not-json");
      const coordinator = new AppCoordinator({
        appState: createInitialAppState({
          local: fakeProvider("local"),
        }),
        uiState: createInitialUiState(),
        queue: new MemoryQueue(),
        player: new NoopPlayer(),
        snapshotPersistence: new FileLastQueueSnapshotPersistence(snapshotPath),
        appPreferencesPersistence: new FileAppPreferencesPersistence(preferencesPath),
      });

      await coordinator.start();

      expect(coordinator.appState.queue.entries).toEqual([]);
      expect(coordinator.uiState.activeTargetId).toBe("local");
      expect(coordinator.appState.lastEvent).toContain("opened Local");
      expect(coordinator.appState.appErrors).toEqual([
        expect.stringContaining("Ignored corrupted Last Queue Snapshot"),
        expect.stringContaining("Ignored corrupted app preferences"),
      ]);
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

      await coordinator.start();
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

      await coordinator.start();
      await coordinator.dispatch({ type: "openLocalPath", path: dir, signal: controller.signal });

      expect(coordinator.appState.queue.entries).toEqual([]);
      expect(coordinator.appState.lastEvent).toBe("cancelled Local open after 0 Tracks");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("opens the Local path prompt from the TUI intent surface", async () => {
    const { coordinator } = createTmuApp();

    await coordinator.start();
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

    await coordinator.start();
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

  test("routes navigation intents through the coordinator into UI State", async () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({
        navidrome: fakeProvider("navidrome", [
          track("navidrome", "track-1", "Remote Track 1"),
          track("navidrome", "track-2", "Remote Track 2"),
        ]),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });

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

    await coordinator.start();
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

  test("marks Provider resolution failures unavailable with a visible reason while preserving Queue contents", async () => {
    const brokenTrack = track("broken-provider", "missing-track", "Broken Track");
    const provider: Provider = {
      id: "broken-provider",
      label: "Broken Provider",
      hint: "failure seam",
      listVisibleTracks() {
        return [brokenTrack];
      },
      async resolvePlaybackLocator() {
        throw new Error("Provider could not resolve this Track");
      },
    };
    const player = new RecordingPlayer();
    const queue = new MemoryQueue();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "broken-provider": provider }),
      uiState: createInitialUiState(),
      queue,
      player,
    });

    await coordinator.start();
    queue.enqueue(brokenTrack);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    expect(player.loaded).toEqual([]);
    expect(coordinator.appState.queue.entries).toHaveLength(1);
    expect(coordinator.appState.queue.entries[0]?.availability).toEqual({
      status: "unavailable",
      reason: "Provider could not resolve this Track",
    });
    expect(coordinator.appState.playback).toEqual({
      status: "error",
      currentTrackIdentity: brokenTrack.identity,
      message: "Provider could not resolve this Track",
    });
    expect(coordinator.appState.lastEvent).toBe("Provider could not resolve this Track");
  });

  test("browses Navidrome artist albums, enqueues a canonical Track, and plays via a resolved stream URL", async () => {
    const player = new RecordingPlayer();
    const seenEndpoints: string[] = [];
    const fetcher: NavidromeFetcher = async (url) => {
      seenEndpoints.push(navidromeEndpointName(url));
      if (url.pathname.endsWith("/getArtists.view")) {
        return navidromeJson({
          status: "ok",
          artists: {
            index: [{
              name: "A",
              artist: [{ id: "artist-1", name: "Alpha", albumCount: 1, coverArt: "artist-cover" }],
            }],
          },
        });
      }
      if (url.pathname.endsWith("/getArtist.view")) {
        return navidromeJson({
          status: "ok",
          artist: {
            id: "artist-1",
            name: "Alpha",
            album: [{ id: "album-1", name: "Album One", artist: "Alpha", songCount: 1, coverArt: "album-cover" }],
          },
        });
      }
      if (url.pathname.endsWith("/getAlbum.view")) {
        return navidromeJson({
          status: "ok",
          album: {
            id: "album-1",
            name: "Album One",
            artist: "Alpha",
            song: [{
              id: "track-1",
              title: "Remote Opening",
              artist: "Alpha",
              album: "Album One",
              duration: 123,
              coverArt: "track-cover",
            }],
          },
        });
      }
      return navidromeJson({ status: "ok" });
    };
    const { coordinator } = createTmuApp({
      config: connectedNavidromeConfig(),
      player,
      navidromeFetcher: fetcher,
      navidromeSaltFactory: () => "stream-salt",
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "activateSelectedContent" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "activateSelectedContent" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });

    expect(coordinator.appState.queue.entries).toHaveLength(1);
    expect(coordinator.appState.queue.entries[0]?.track).toEqual({
      identity: {
        providerId: "navidrome",
        stableId: "Navidrome:https://music.example.test:track:track-1",
      },
      title: "Remote Opening",
      providerLabel: "Navidrome",
      artist: "Alpha",
      album: "Album One",
      durationSeconds: 123,
      coverArtId: "track-cover",
    });
    expect(coordinator.appState.queue.entries[0]?.track).not.toHaveProperty("playbackLocator");

    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    expect(player.loaded).toHaveLength(1);
    expect(player.loaded[0]?.kind).toBe("url");
    const streamUrl = new URL((player.loaded[0] as { kind: "url"; url: string }).url);
    expect(streamUrl.pathname).toBe("/rest/stream.view");
    expect(streamUrl.searchParams.get("id")).toBe("track-1");
    expect(streamUrl.searchParams.get("s")).toBe("stream-salt");
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual({
      providerId: "navidrome",
      stableId: "Navidrome:https://music.example.test:track:track-1",
    });
    expect(seenEndpoints).toEqual(["ping", "getArtists", "getArtist", "getAlbum", "scrobble"]);
  });

  test("does not persist Navidrome stream URLs after a Player load failure", async () => {
    const player = new LoadFailingPlayer();
    const queue = new MemoryQueue();
    const remoteTrack = navidromeTrack("track-fail", "Remote Failure Track", 180);
    queue.enqueue(remoteTrack);
    const snapshotPersistence = new InMemoryLastQueueSnapshotPersistence();
    const provider = createNavidromeProvider({
      config: createDefaultTmuConfig(connectedNavidromeConfig()).providers.navidrome,
      fetcher: async () => navidromeJson({ status: "ok" }),
      saltFactory: () => "failure-salt",
    });
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ navidrome: provider }, { config: connectedNavidromeConfig() }),
      uiState: createInitialUiState(),
      queue,
      player,
      snapshotPersistence,
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    expect(player.loaded).toHaveLength(1);
    expect(player.loaded[0]).toMatchObject({ kind: "url" });
    expect(coordinator.appState.lastEvent).toBe("mpv error: load failed");
    expect(coordinator.appState.queue.entries[0]?.track).toEqual(remoteTrack);
    expect(coordinator.appState.queue.entries[0]?.track).not.toHaveProperty("playbackLocator");
    expect(coordinator.appState.queue.entries[0]?.track).not.toHaveProperty("url");
    expect(coordinator.appState.queue.entries[0]?.availability).toEqual({
      status: "unavailable",
      reason: "mpv error: load failed",
    });

    await coordinator.dispatch({ type: "saveLastQueueSnapshot" });
    const snapshot = await snapshotPersistence.load();

    expect(snapshot?.entries[0]).toEqual({
      track: remoteTrack,
      availability: {
        status: "unavailable",
        reason: "mpv error: load failed",
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("/rest/stream.view");
    expect(JSON.stringify(snapshot)).not.toContain("failure-salt");
  });

  test("browses Navidrome playlists and enqueues playlist Tracks through coordinator intents", async () => {
    const seenEndpoints: string[] = [];
    const { coordinator } = createTmuApp({
      config: connectedNavidromeConfig(),
      navidromeFetcher: async (url) => {
        seenEndpoints.push(navidromeEndpointName(url));
        if (url.pathname.endsWith("/getArtists.view")) {
          return navidromeJson({ status: "ok", artists: { index: [] } });
        }
        if (url.pathname.endsWith("/getPlaylists.view")) {
          expect(url.searchParams.has("username")).toBe(false);
          return navidromeJson({
            status: "ok",
            playlists: {
              playlist: [{ id: "playlist-1", name: "Favorites", songCount: 1 }],
            },
          });
        }
        if (url.pathname.endsWith("/getPlaylist.view")) {
          return navidromeJson({
            status: "ok",
            playlist: {
              id: "playlist-1",
              name: "Favorites",
              entry: [{
                id: "playlist-track-1",
                title: "Playlist Track",
                artist: "Alex",
                album: "Remote Set",
                duration: 181,
              }],
            },
          });
        }
        return navidromeJson({ status: "ok" });
      },
      navidromeSaltFactory: () => "salt",
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "activateSelectedContent" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "activateSelectedContent" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track)).toEqual([{
      identity: {
        providerId: "navidrome",
        stableId: "Navidrome:https://music.example.test:track:playlist-track-1",
      },
      title: "Playlist Track",
      providerLabel: "Navidrome",
      artist: "Alex",
      album: "Remote Set",
      durationSeconds: 181,
    }]);
    expect(seenEndpoints).toEqual(["ping", "getArtists", "getPlaylists", "getPlaylist"]);
  });

  test("searches Navidrome Tracks with simple text and enqueues search results", async () => {
    const seenSearchParams: Record<string, string>[] = [];
    const { coordinator } = createTmuApp({
      config: connectedNavidromeConfig(),
      navidromeFetcher: async (url) => {
        if (url.pathname.endsWith("/getArtists.view")) {
          return navidromeJson({ status: "ok", artists: { index: [] } });
        }
        if (url.pathname.endsWith("/search3.view")) {
          seenSearchParams.push(Object.fromEntries(url.searchParams.entries()));
          return navidromeJson({
            status: "ok",
            searchResult3: {
              song: [{
                id: "search-track-1",
                title: "Found Track",
                artist: "Search Artist",
              }],
            },
          });
        }
        return navidromeJson({ status: "ok" });
      },
      navidromeSaltFactory: () => "salt",
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });
    await coordinator.dispatch({ type: "openNavidromeSearchPrompt" });
    await coordinator.dispatch({ type: "setPromptInput", value: "found" });
    await coordinator.dispatch({ type: "submitPrompt" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });

    expect(seenSearchParams).toHaveLength(1);
    expect(seenSearchParams[0]).toMatchObject({
      query: "found",
      songOffset: "0",
    });
    expect(Number(seenSearchParams[0]?.songCount)).toBeGreaterThan(0);
    expect(coordinator.appState.queue.entries[0]?.track).toMatchObject({
      identity: {
        providerId: "navidrome",
        stableId: "Navidrome:https://music.example.test:track:search-track-1",
      },
      title: "Found Track",
      artist: "Search Artist",
    });
  });

  test("reports Navidrome now-playing scrobble when playback starts and reporting is enabled", async () => {
    const player = new ManualPlaybackPlayer();
    const seenScrobbles: Record<string, string>[] = [];
    const queue = new MemoryQueue();
    const remoteTrack = navidromeTrack("track-1", "Remote Track", 180);
    queue.enqueue(remoteTrack);
    const provider = createNavidromeProvider({
      config: createDefaultTmuConfig(connectedNavidromeConfig()).providers.navidrome,
      fetcher: async (url) => {
        if (url.pathname.endsWith("/scrobble.view")) {
          seenScrobbles.push(Object.fromEntries(url.searchParams.entries()));
        }
        return navidromeJson({ status: "ok" });
      },
      saltFactory: () => "salt",
    });
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ navidrome: provider }, { config: connectedNavidromeConfig() }),
      uiState: createInitialUiState(),
      queue,
      player,
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    await waitFor(() => {
      expect(seenScrobbles).toContainEqual(expect.objectContaining({ id: "track-1", submission: "false" }));
    });
    expect(player.loaded).toHaveLength(1);
    expect(coordinator.appState.playback.status).toBe("playing");
  });

  test("reports Navidrome completed-play scrobble after the local threshold", async () => {
    const player = new ManualPlaybackPlayer();
    const seenScrobbles: Record<string, string>[] = [];
    const queue = new MemoryQueue();
    const remoteTrack = navidromeTrack("track-2", "Long Remote Track", 300);
    queue.enqueue(remoteTrack);
    const provider = createNavidromeProvider({
      config: createDefaultTmuConfig(connectedNavidromeConfig()).providers.navidrome,
      fetcher: async (url) => {
        if (url.pathname.endsWith("/scrobble.view")) {
          seenScrobbles.push(Object.fromEntries(url.searchParams.entries()));
        }
        return navidromeJson({ status: "ok" });
      },
      saltFactory: () => "salt",
    });
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ navidrome: provider }, { config: connectedNavidromeConfig() }),
      uiState: createInitialUiState(),
      queue,
      player,
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });
    player.emitPlaybackState({ status: "playing", positionSeconds: 149, durationSeconds: 300 });
    await Bun.sleep(10);
    expect(seenScrobbles.filter((params) => params.submission === "true")).toEqual([]);

    player.emitPlaybackState({ status: "playing", positionSeconds: 150, durationSeconds: 300 });

    await waitFor(() => {
      expect(seenScrobbles).toContainEqual(expect.objectContaining({ id: "track-2", submission: "true" }));
    });
    player.emitPlaybackState({ status: "playing", positionSeconds: 180, durationSeconds: 300 });
    await Bun.sleep(10);
    expect(seenScrobbles.filter((params) => params.submission === "true")).toHaveLength(1);
  });

  test("does not report Navidrome scrobbles when reporting is disabled", async () => {
    const player = new ManualPlaybackPlayer();
    const seenEndpoints: string[] = [];
    const queue = new MemoryQueue();
    queue.enqueue(navidromeTrack("track-3", "Opt Out Track", 120));
    const config = connectedNavidromeConfig({ scrobble: false });
    const provider = createNavidromeProvider({
      config: createDefaultTmuConfig(config).providers.navidrome,
      fetcher: async (url) => {
        seenEndpoints.push(navidromeEndpointName(url));
        return navidromeJson({ status: "ok" });
      },
      saltFactory: () => "salt",
    });
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ navidrome: provider }, { config }),
      uiState: createInitialUiState(),
      queue,
      player,
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });
    player.emitPlaybackState({ status: "playing", positionSeconds: 90, durationSeconds: 120 });
    await Bun.sleep(10);

    expect(seenEndpoints).toEqual([]);
    expect(coordinator.appState.playback.status).toBe("playing");
  });

  test("keeps Navidrome reporting failures non-blocking and visible in diagnostics", async () => {
    const player = new ManualPlaybackPlayer();
    const queue = new MemoryQueue();
    queue.enqueue(navidromeTrack("track-4", "Failure Track", 120));
    const provider = createNavidromeProvider({
      config: createDefaultTmuConfig(connectedNavidromeConfig()).providers.navidrome,
      fetcher: async () => {
        throw new Error("scrobble network failed");
      },
      saltFactory: () => "salt",
    });
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ navidrome: provider }, { config: connectedNavidromeConfig() }),
      uiState: createInitialUiState(),
      queue,
      player,
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    await waitFor(() => {
      expect(coordinator.appState.appErrors).toContain("Navidrome reporting failed: request failed for scrobble: scrobble network failed");
    });
    expect(player.loaded).toHaveLength(1);
    expect(coordinator.appState.playback.status).toBe("playing");
    expect(coordinator.appState.queue.entries[0]?.availability).toEqual({ status: "available" });
  });

  test("loads Navidrome artists once through navigation and reloads them on explicit refresh", async () => {
    let artistCall = 0;
    const seenEndpoints: string[] = [];
    const { coordinator } = createTmuApp({
      config: connectedNavidromeConfig(),
      navidromeFetcher: async (url) => {
        seenEndpoints.push(navidromeEndpointName(url));
        if (url.pathname.endsWith("/getArtists.view")) {
          artistCall += 1;
          return navidromeJson({
            status: "ok",
            artists: {
              index: [{
                name: "A",
                artist: [{ id: `artist-${artistCall}`, name: `Artist ${artistCall}` }],
              }],
            },
          });
        }
        return navidromeJson({ status: "ok" });
      },
      navidromeSaltFactory: () => "salt",
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });

    await coordinator.dispatch({ type: "refreshNavidromeLibrary" });
    coordinator.dispatchUi({
      type: "updateView",
      patch: {
        selectedContentIndexByTarget: { ...coordinator.uiState.selectedContentIndexByTarget, navidrome: 7 },
      },
    });
    const uiBeforeSemanticRefresh = structuredClone(coordinator.uiState);
    await coordinator.dispatch({ type: "providerOperation", providerId: "navidrome", operation: "refresh" });
    expect(coordinator.uiState).toEqual(uiBeforeSemanticRefresh);
    expect(seenEndpoints).toEqual(["ping", "getArtists", "ping", "ping", "getArtists", "ping", "getArtists"]);
  });

  test("ignores Navidrome refresh intent outside the Navidrome Library Browser", async () => {
    const seenEndpoints: string[] = [];
    const { coordinator } = createTmuApp({
      config: connectedNavidromeConfig(),
      navidromeFetcher: async (url) => {
        seenEndpoints.push(navidromeEndpointName(url));
        return navidromeJson({ status: "ok" });
      },
      navidromeSaltFactory: () => "salt",
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "refreshNavidromeLibrary" });

    expect(coordinator.uiState.activeTargetId).toBe("local");
    expect(seenEndpoints).toEqual([]);
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

    await coordinator.start();
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

    await coordinator.start();
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

    await stopCoordinator.start();
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

    await volumeCoordinator.start();
    await volumeCoordinator.dispatch({ type: "setVolume", percent: 71, ready: true });

    expect(volumeCoordinator.appState.lastEvent).toBe("mpv error: volume failed");
    expect(volumeCoordinator.appState.volume).toEqual({ percent: 100, ready: false });
  });

  test("marks Player load failures visible without removing the Track from the Queue", async () => {
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

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    expect(player.loaded).toEqual([{ kind: "file", path: "/resolved/local//music/amber.flac" }]);
    expect(coordinator.appState.lastEvent).toBe("mpv error: load failed");
    expect(coordinator.appState.queue.entries).toHaveLength(1);
    expect(coordinator.appState.queue.entries[0]?.availability).toEqual({
      status: "unavailable",
      reason: "mpv error: load failed",
    });
    expect(coordinator.appState.playback).toEqual({
      status: "error",
      currentTrackIdentity: localTrack.identity,
      message: "mpv error: load failed",
    });
  });

  test("auto-advance continues past a Track with a Player load failure without corrupting Queue state", async () => {
    const first = track("local", "/music/first.flac", "First File");
    const second = track("local", "/music/second.flac", "Second File");
    const player = new LoadFailingOncePlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [first, second]),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    await coordinator.dispatch({ type: "moveSelection", delta: -1 });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    expect(coordinator.appState.lastEvent).toBe("mpv error: first load failed");
    expect(coordinator.appState.queue.entries.map((entry) => entry.availability)).toEqual([
      { status: "unavailable", reason: "mpv error: first load failed" },
      { status: "unknown" },
    ]);

    await coordinator.dispatch({ type: "nextTrack" });

    expect(player.loaded).toEqual([
      { kind: "file", path: "/resolved/local//music/first.flac" },
      { kind: "file", path: "/resolved/local//music/second.flac" },
    ]);
    expect(coordinator.appState.playback.status).toBe("playing");
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(second.identity);
    expect(coordinator.appState.queue.currentIndex).toBe(1);
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual([
      "First File",
      "Second File",
    ]);
  });

  test("auto-advance skips a failed Player load candidate in the middle of the Queue", async () => {
    const first = track("local", "/music/first.flac", "First File");
    const broken = track("local", "/music/broken.flac", "Broken File");
    const third = track("local", "/music/third.flac", "Third File");
    const player = new LoadFailingForPathPlayer("/resolved/local//music/broken.flac");
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({
        local: fakeProvider("local", [first, broken, third]),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    await coordinator.start();
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
      { kind: "file", path: "/resolved/local//music/first.flac" },
      { kind: "file", path: "/resolved/local//music/broken.flac" },
      { kind: "file", path: "/resolved/local//music/third.flac" },
    ]);
    expect(coordinator.appState.queue.entries[1]?.availability).toEqual({
      status: "unavailable",
      reason: "mpv error: cannot load /resolved/local//music/broken.flac",
    });
    expect(coordinator.appState.playback.status).toBe("playing");
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(third.identity);
    expect(coordinator.appState.queue.currentIndex).toBe(2);
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

  test("drives Queue-focused remove, move, clear, next, previous, and modes through intents", async () => {
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

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });

    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
    expect(coordinator.uiState.activeTargetId).toBe("queue");
    expect(coordinator.uiState.focusedPane).toBe("queue");

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
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(amber.identity);

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

  test("repairs Queue selection to the next survivor after removing a non-current Track", async () => {
    const amber = track("local", "amber", "Amber");
    const cinder = track("local", "cinder", "Cinder");
    const drift = track("local", "drift", "Drift");
    const queue = new MemoryQueue();
    for (const candidate of [amber, cinder, drift]) queue.enqueue(candidate);
    queue.startAt(0);
    const uiState = createInitialUiState();
    uiState.activeTargetId = "queue";
    uiState.focusedPane = "queue";
    uiState.selectedQueueIndex = 1;
    uiState.selectedQueueIdentity = cinder.identity;
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({}),
      uiState,
      queue,
      player: new RecordingPlayer(),
    });

    await coordinator.dispatch({ type: "removeQueueTrack", identity: cinder.identity });

    expect(coordinator.uiState.selectedQueueIdentity).toEqual(drift.identity);
    expect(coordinator.uiState.selectedQueueIndex).toBe(1);
    expect(coordinator.appState.queue.currentIndex).toBe(0);
  });

  test("repairs Queue selection to the previous row after removing the Queue end", async () => {
    const amber = track("local", "amber", "Amber");
    const cinder = track("local", "cinder", "Cinder");
    const queue = new MemoryQueue();
    queue.enqueue(amber);
    queue.enqueue(cinder);
    queue.startAt(0);
    const uiState = createInitialUiState();
    uiState.selectedQueueIndex = 1;
    uiState.selectedQueueIdentity = cinder.identity;
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({}),
      uiState,
      queue,
      player: new RecordingPlayer(),
    });

    await coordinator.dispatch({ type: "removeQueueTrack", identity: cinder.identity });

    expect(coordinator.uiState.selectedQueueIdentity).toEqual(amber.identity);
    expect(coordinator.uiState.selectedQueueIndex).toBe(0);
  });

  test("removing the Current Track stops playback, clears Current Track, and never advances", async () => {
    const amber = track("local", "amber", "Amber");
    const cinder = track("local", "cinder", "Cinder");
    const queue = new MemoryQueue();
    queue.enqueue(amber);
    queue.enqueue(cinder);
    queue.startAt(0);
    const appState = createInitialAppState({});
    appState.playback = { status: "playing", currentTrackIdentity: amber.identity };
    const uiState = createInitialUiState();
    uiState.selectedQueueIdentity = amber.identity;
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({ appState, uiState, queue, player });

    await coordinator.dispatch({ type: "removeQueueTrack", identity: amber.identity });

    expect(player.stops).toBe(1);
    expect(coordinator.appState.playback).toEqual({ status: "idle", currentTrackIdentity: null });
    expect(coordinator.appState.queue.currentIndex).toBe(-1);
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(cinder.identity);
    expect(player.loaded).toEqual([]);
  });

  test("keeps Current Track and Queue unchanged when playback cannot stop for removal", async () => {
    const amber = track("local", "amber", "Amber");
    const cinder = track("local", "cinder", "Cinder");
    const queue = new MemoryQueue();
    queue.enqueue(amber);
    queue.enqueue(cinder);
    queue.startAt(0);
    const appState = createInitialAppState({});
    appState.playback = { status: "playing", currentTrackIdentity: amber.identity };
    const coordinator = new AppCoordinator({
      appState,
      uiState: createInitialUiState(),
      queue,
      player: new FailingStopPlayer(),
    });

    await coordinator.dispatch({ type: "removeQueueTrack", identity: amber.identity });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["Amber", "Cinder"]);
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(amber.identity);
    expect(coordinator.appState.lastEvent).toBe("Player stop failed");
  });

  test("reordering follows selected Track Identity without interrupting Current Track", async () => {
    const amber = track("local", "amber", "Amber");
    const cinder = track("local", "cinder", "Cinder");
    const drift = track("local", "drift", "Drift");
    const queue = new MemoryQueue();
    for (const candidate of [amber, cinder, drift]) queue.enqueue(candidate);
    queue.startAt(0);
    const appState = createInitialAppState({});
    appState.playback = { status: "playing", currentTrackIdentity: amber.identity };
    const uiState = createInitialUiState();
    uiState.selectedQueueIndex = 1;
    uiState.selectedQueueIdentity = cinder.identity;
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({ appState, uiState, queue, player });

    await coordinator.dispatch({ type: "moveQueueTrack", identity: cinder.identity, delta: 1 });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["Amber", "Drift", "Cinder"]);
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(cinder.identity);
    expect(coordinator.uiState.selectedQueueIndex).toBe(2);
    expect(coordinator.appState.playback).toEqual({ status: "playing", currentTrackIdentity: amber.identity });
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(player.stops).toBe(0);
    expect(player.loaded).toEqual([]);
  });

  test("clears Queue only after stopping playback and clears Current Track and selection together", async () => {
    const amber = track("local", "amber", "Amber");
    const cinder = track("local", "cinder", "Cinder");
    const queue = new MemoryQueue();
    queue.enqueue(amber);
    queue.enqueue(cinder);
    queue.startAt(0);
    const appState = createInitialAppState({});
    appState.playback = { status: "playing", currentTrackIdentity: amber.identity };
    const uiState = createInitialUiState();
    uiState.selectedQueueIdentity = cinder.identity;
    uiState.selectedQueueIndex = 1;
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({ appState, uiState, queue, player });

    await coordinator.dispatch({ type: "clearQueue" });

    expect(player.stops).toBe(1);
    expect(coordinator.appState.queue.entries).toEqual([]);
    expect(coordinator.appState.queue.currentIndex).toBe(-1);
    expect(coordinator.appState.playback).toEqual({ status: "idle", currentTrackIdentity: null });
    expect(coordinator.uiState.selectedQueueIdentity).toBeNull();
    expect(coordinator.uiState.selectedQueueIndex).toBe(0);
  });

  test("keeps Queue, Current Track, and selection unchanged when Clear Queue cannot stop playback", async () => {
    const amber = track("local", "amber", "Amber");
    const queue = new MemoryQueue();
    queue.enqueue(amber);
    queue.startAt(0);
    const appState = createInitialAppState({});
    appState.playback = { status: "playing", currentTrackIdentity: amber.identity };
    const uiState = createInitialUiState();
    uiState.selectedQueueIdentity = amber.identity;
    const coordinator = new AppCoordinator({
      appState,
      uiState,
      queue,
      player: new FailingStopPlayer(),
    });

    await coordinator.dispatch({ type: "clearQueue" });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["Amber"]);
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(amber.identity);
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(amber.identity);
    expect(coordinator.appState.lastEvent).toBe("Player stop failed");
  });

  test("drives Queue-focused playback controls through App Coordinator intents", async () => {
    const playable = track("local", "/music/playable.flac", "Playable File");
    const missing = track("local", "/music/missing.flac", "Missing File");
    const local = restoringLocalProvider({
      tracks: [playable, missing],
      unavailableStableIds: [missing.identity.stableId],
    });
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ local }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "local" });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "enqueueSelectedTrack" });
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });

    expect(coordinator.uiState.activeTargetId).toBe("queue");
    expect(coordinator.uiState.focusedPane).toBe("queue");

    await coordinator.dispatch({ type: "moveSelection", delta: -1 });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });
    await coordinator.dispatch({ type: "togglePlayPause" });
    await coordinator.dispatch({ type: "seekBy", seconds: 15 });
    await coordinator.dispatch({ type: "setVolume", percent: 55, ready: true });
    await coordinator.dispatch({ type: "toggleShuffle" });
    await coordinator.dispatch({ type: "toggleRepeatAll" });
    await coordinator.dispatch({ type: "stop" });

    expect(player.loaded).toEqual([{ kind: "file", path: "/music/playable.flac" }]);
    expect(player.toggles).toBe(1);
    expect(player.seeks).toEqual([15]);
    expect(player.volumes).toEqual([55]);
    expect(player.stops).toBe(1);
    expect(coordinator.appState.volume).toEqual({ percent: 55, ready: true });
    expect(coordinator.appState.queue.shuffle).toBe(true);
    expect(coordinator.appState.queue.repeatAll).toBe(true);
    expect(coordinator.appState.playback).toEqual({
      status: "stopped",
      positionSeconds: 0,
      currentTrackIdentity: playable.identity,
    });

    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    await coordinator.dispatch({ type: "startSelectedQueueEntry" });

    expect(player.loaded).toEqual([{ kind: "file", path: "/music/playable.flac" }]);
    expect(coordinator.appState.queue.entries[1]?.availability).toEqual({
      status: "unavailable",
      reason: "Local file no longer exists: /music/missing.flac",
    });
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

    await first.start();
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

    await second.start();
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

    await coordinator.start();

    expect(local.resolveCalls.map((identity) => identity.stableId)).toEqual([
      "/music/missing.flac",
      "/music/present.flac",
    ]);
    expect(local.pathCalls).toEqual([]);
    expect(local.openPathCalls).toEqual([]);
    expect(coordinator.appState.queue.entries).toHaveLength(2);
    expect(coordinator.appState.queue.entries[0]?.availability).toEqual({
      status: "unavailable",
      reason: "Local file no longer exists: /music/missing.flac",
    });
    expect(coordinator.appState.queue.entries[1]?.availability).toEqual({ status: "available" });

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

    await coordinator.start();
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

  test("automatically follows visible Queue order at natural completion and stops at the end", async () => {
    const first = track("local", "/music/first.flac", "First File");
    const missing = track("local", "/music/missing.flac", "Missing File");
    const last = track("local", "/music/last.flac", "Last File");
    const queue = new MemoryQueue();
    const player = new ManualPlaybackPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ local: fakeProvider("local", [first, missing, last]) }),
      uiState: createInitialUiState(),
      queue,
      player,
    });

    for (const queued of [first, missing, last]) queue.enqueue(queued);
    queue.markAvailability(missing.identity, { status: "unavailable", reason: "file missing" });
    await coordinator.dispatch({ type: "playNow", target: first });

    player.emitPlaybackState({ status: "idle", idle: true, eof: true });
    await waitFor(() => expect(coordinator.appState.playback.currentTrackIdentity).toEqual(last.identity));
    expect(coordinator.appState.queue.entries[1]?.availability).toEqual({
      status: "unavailable",
      reason: "file missing",
    });

    player.emitPlaybackState({ status: "idle", idle: true, eof: true });
    await waitFor(() => expect(coordinator.appState.playback).toMatchObject({
      status: "stopped",
      positionSeconds: 0,
      currentTrackIdentity: last.identity,
    }));
  });

  test("keeps Offline YouTube Cache missing-media failures visible in the Queue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-offline-cache-missing-visible-"));

    try {
      await writeOfflineYouTubeCacheMetadata({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      }, {
        version: 1,
        extractor: "YouTube",
        id: "MissingMedia",
        title: "Missing Cached Track",
        mediaFileName: "missing.opus",
      });
      const { coordinator } = createTmuApp({
        config: {
          offlineYouTubeCache: {
            cacheDir: dir,
            mediaDirName: "media",
            metadataFileName: "metadata.json",
          },
        },
      });

      await coordinator.start();
      await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "offline-youtube-cache" });
      await coordinator.dispatch({ type: "enqueueSelectedTrack" });

      expect(coordinator.appState.queue.entries[0]).toMatchObject({
        track: {
          identity: { providerId: "offline-youtube-cache", stableId: "youtube:MissingMedia" },
          title: "Missing Cached Track",
        },
        availability: { status: "unavailable", reason: "Cached media file is missing" },
      });

      await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
      await coordinator.dispatch({ type: "startSelectedQueueEntry" });

      expect(coordinator.appState.queue.entries).toHaveLength(1);
      expect(coordinator.appState.queue.entries[0]?.availability).toEqual({
        status: "unavailable",
        reason: "Cached media file is missing",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

    await coordinator.start();
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

    await coordinator.start();
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

    await coordinator.start();
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

    await coordinator.start();
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

    await coordinator.start();
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

  test("submits a direct YouTube URL, identifies it, and enqueues a complete Offline YouTube Cache hit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-url-cache-hit-"));
    const requests: DependencyCommandRequest[] = [];
    const runner: DependencyCommandRunner = async (request) => {
      requests.push(request);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          extractor_key: "YouTube",
          id: "AbC123",
          title: "Cached Prompt Track",
          uploader: "Prompt Artist",
          duration: 188,
        }),
        stderr: "",
      };
    };

    try {
      await writeOfflineYouTubeCacheMetadata({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      }, {
        version: 1,
        extractor: "YouTube",
        id: "AbC123",
        title: "Cached Prompt Track",
        artist: "Prompt Artist",
        durationSeconds: 188,
        mediaFileName: "cached.opus",
      });
      await mkdir(join(dir, "youtube", "AbC123", "media"), { recursive: true });
      await writeFile(join(dir, "youtube", "AbC123", "media", "cached.opus"), "audio bytes");
      const { coordinator } = createTmuApp({
        config: {
          helpers: {
            ytDlp: "/opt/bin/yt-dlp",
          },
          dependencyPolicy: {
            checkTimeoutMs: 4321,
          },
          offlineYouTubeCache: {
            cacheDir: dir,
            mediaDirName: "media",
            metadataFileName: "metadata.json",
          },
        },
        dependencyRunner: runner,
      });

      await coordinator.start();
      await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "youtube-url-download" });
      await coordinator.dispatch({ type: "setPromptInput", value: "https://music.youtube.com/watch?v=AbC123" });
      await coordinator.dispatch({ type: "submitPrompt" });

      await waitFor(() => {
        expect(coordinator.appState.queue.entries).toHaveLength(1);
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        helper: "yt-dlp",
        command: "/opt/bin/yt-dlp",
        timeoutMs: 4321,
      });
      expect(requests[0]?.args).toEqual([
        "--dump-single-json",
        "--skip-download",
        "--no-playlist",
        "--",
        "https://music.youtube.com/watch?v=AbC123",
      ]);
      expect(coordinator.appState.queue.entries[0]).toMatchObject({
        availability: { status: "available" },
        track: {
          identity: {
            providerId: "offline-youtube-cache",
            stableId: "youtube:AbC123",
          },
          title: "Cached Prompt Track",
          artist: "Prompt Artist",
        },
      });
      expect(coordinator.appState.downloads).toEqual({ active: false, lines: [] });
      expect(coordinator.appState.lastEvent).toBe("added Cached Prompt Track to shared Queue");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("downloads an identified cache miss, refreshes the Offline YouTube Cache, and enqueues the cached Track", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-url-cache-miss-"));
    const requests: DependencyCommandRequest[] = [];
    const runner: DependencyCommandRunner = async (request) => {
      requests.push(request);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          extractor_key: "YouTube",
          id: "Missing123",
          title: "Downloaded Prompt Track",
          uploader: "Prompt Artist",
          duration: 205,
        }),
        stderr: "",
      };
    };
    const downloaderCalls: YouTubeDownloadOptions[] = [];
    const downloader: YouTubeDownloader = async (options) => {
      downloaderCalls.push(options);
      options.onProgress?.("download 50.0% at 1.00MiB/s ETA 00:01");
      await mkdir(join(dir, "youtube", "Missing123", "media"), { recursive: true });
      await writeFile(join(dir, "youtube", "Missing123", "media", "youtube-Missing123.webm"), "audio bytes");
      await writeOfflineYouTubeCacheMetadata(options.cache, {
        version: 1,
        extractor: options.metadata.extractor,
        id: options.metadata.id,
        title: options.metadata.title,
        artist: options.metadata.artist,
        durationSeconds: options.metadata.durationSeconds,
        mediaFileName: "youtube-Missing123.webm",
      });
      return {
        ok: true,
        mediaPath: join(dir, "youtube", "Missing123", "media", "youtube-Missing123.webm"),
        metadataPath: join(dir, "youtube", "Missing123", "metadata.json"),
        sourceMetadataPath: join(dir, "youtube", "Missing123", "source.json"),
      };
    };

    try {
      await writeOfflineYouTubeCacheMetadata({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      }, {
        version: 1,
        extractor: "youtube",
        id: "Missing123",
        title: "Old Missing Cached Media",
        mediaFileName: "missing.opus",
      });
      const { coordinator } = createTmuApp({
        config: {
          offlineYouTubeCache: {
            cacheDir: dir,
            mediaDirName: "media",
            metadataFileName: "metadata.json",
          },
        },
        dependencyRunner: runner,
        youtubeDownloader: downloader,
      });

      await coordinator.start();
      await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "youtube-url-download" });
      await coordinator.dispatch({ type: "setPromptInput", value: "https://www.youtube.com/watch?v=Missing123" });
      await coordinator.dispatch({ type: "submitPrompt" });

      await waitFor(() => {
        expect(coordinator.appState.queue.entries).toHaveLength(1);
      });
      expect(requests).toHaveLength(1);
      expect(downloaderCalls).toHaveLength(1);
      expect(downloaderCalls[0]).toMatchObject({
        url: "https://www.youtube.com/watch?v=Missing123",
        command: "yt-dlp",
        cache: {
          cacheDir: dir,
          mediaDirName: "media",
          metadataFileName: "metadata.json",
        },
        metadata: {
          extractor: "youtube",
          id: "Missing123",
          title: "Downloaded Prompt Track",
          artist: "Prompt Artist",
          durationSeconds: 205,
        },
        progressThrottleMs: 1000,
      });
      expect(coordinator.appState.queue.entries[0]).toMatchObject({
        availability: { status: "available" },
        track: {
          identity: { providerId: "offline-youtube-cache", stableId: "youtube:Missing123" },
          title: "Downloaded Prompt Track",
          artist: "Prompt Artist",
          durationSeconds: 205,
        },
      });
      expect(coordinator.appState.downloads.active).toBe(false);
      expect(coordinator.appState.lastEvent).toBe("added Downloaded Prompt Track to shared Queue");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs one YouTube download at a time by default and keeps progress in App State", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-one-at-a-time-"));
    const runner: DependencyCommandRunner = async (request) => ({
      exitCode: 0,
      stdout: JSON.stringify({
        extractor_key: "YouTube",
        id: request.args.at(-1)?.toString().includes("Second") ? "Second" : "First",
        title: request.args.at(-1)?.toString().includes("Second") ? "Second Track" : "First Track",
      }),
      stderr: "",
    });
    let finishFirst: ((result: YouTubeDownloadResult) => void) | undefined;
    const downloaderCalls: YouTubeDownloadOptions[] = [];
    const downloader: YouTubeDownloader = async (options) => {
      downloaderCalls.push(options);
      options.onProgress?.("download 10.0% at 1.00MiB/s ETA 00:09");
      return await new Promise<YouTubeDownloadResult>((resolve) => {
        finishFirst = resolve;
      });
    };

    try {
      const { coordinator } = createTmuApp({
        config: {
          offlineYouTubeCache: {
            cacheDir: dir,
            mediaDirName: "media",
            metadataFileName: "metadata.json",
          },
        },
        dependencyRunner: runner,
        youtubeDownloader: downloader,
      });

      await coordinator.start();
      await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "youtube-url-download" });
      await coordinator.dispatch({ type: "setPromptInput", value: "https://www.youtube.com/watch?v=First" });
      await coordinator.dispatch({ type: "submitPrompt" });
      await waitFor(() => {
        expect(coordinator.appState.downloads).toEqual({
          active: true,
          lines: ["download 10.0% at 1.00MiB/s ETA 00:09"],
        });
      });

      await coordinator.dispatch({ type: "enqueueSelectedTrack" });
      await coordinator.dispatch({ type: "setPromptInput", value: "https://www.youtube.com/watch?v=Second" });
      await coordinator.dispatch({ type: "submitPrompt" });

      expect(downloaderCalls).toHaveLength(1);
      expect(coordinator.appState.lastEvent).toBe("YouTube download already in progress");

      await mkdir(join(dir, "youtube", "First", "media"), { recursive: true });
      await writeFile(join(dir, "youtube", "First", "media", "youtube-First.webm"), "audio bytes");
      await writeOfflineYouTubeCacheMetadata({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      }, {
        version: 1,
        extractor: "youtube",
        id: "First",
        title: "First Track",
        mediaFileName: "youtube-First.webm",
      });
      finishFirst?.({
        ok: true,
        mediaPath: join(dir, "youtube", "First", "media", "youtube-First.webm"),
        metadataPath: join(dir, "youtube", "First", "metadata.json"),
        sourceMetadataPath: join(dir, "youtube", "First", "source.json"),
      });

      await waitFor(() => {
        expect(coordinator.appState.lastEvent).toBe("added First Track to shared Queue");
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cancels an active YouTube download through a narrow App intent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-cancel-"));
    const runner: DependencyCommandRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        extractor_key: "YouTube",
        id: "CancelMe",
        title: "Cancel Track",
      }),
      stderr: "",
    });
    let observedSignal: AbortSignal | undefined;
    const downloader: YouTubeDownloader = async (options) => {
      observedSignal = options.signal;
      options.onProgress?.("download 1.0% at 10.00KiB/s ETA 10:00");
      return await new Promise<YouTubeDownloadResult>((resolve) => {
        options.signal?.addEventListener("abort", () => {
          resolve({ ok: false, message: "YouTube download cancelled", cancelled: true });
        }, { once: true });
      });
    };

    try {
      const { coordinator } = createTmuApp({
        config: {
          offlineYouTubeCache: {
            cacheDir: dir,
            mediaDirName: "media",
            metadataFileName: "metadata.json",
          },
        },
        dependencyRunner: runner,
        youtubeDownloader: downloader,
      });

      await coordinator.start();
      await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "youtube-url-download" });
      await coordinator.dispatch({ type: "setPromptInput", value: "https://www.youtube.com/watch?v=CancelMe" });
      await coordinator.dispatch({ type: "submitPrompt" });
      await waitFor(() => {
        expect(observedSignal).not.toBeUndefined();
      });

      await coordinator.dispatch({ type: "cancelYouTubeDownload" });

      await waitFor(() => {
        expect(observedSignal?.aborted).toBe(true);
        expect(coordinator.appState.downloads.active).toBe(false);
        expect(coordinator.appState.lastEvent).toBe("YouTube download cancelled");
      });
      expect(coordinator.appState.queue.entries).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not enqueue when a YouTube downloader resolves success after cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-cancel-success-"));
    const runner: DependencyCommandRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        extractor_key: "YouTube",
        id: "CancelSuccess",
        title: "Cancel Success Track",
      }),
      stderr: "",
    });
    let observedSignal: AbortSignal | undefined;
    const downloader: YouTubeDownloader = async (options) => {
      observedSignal = options.signal;
      return await new Promise<YouTubeDownloadResult>((resolve) => {
        options.signal?.addEventListener("abort", () => {
          void (async () => {
            await mkdir(join(dir, "youtube", "CancelSuccess", "media"), { recursive: true });
            await writeFile(join(dir, "youtube", "CancelSuccess", "media", "youtube-CancelSuccess.webm"), "audio bytes");
            const metadataPath = await writeOfflineYouTubeCacheMetadata(options.cache, {
              version: 1,
              extractor: options.metadata.extractor,
              id: options.metadata.id,
              title: options.metadata.title,
              mediaFileName: "youtube-CancelSuccess.webm",
            });
            resolve({
              ok: true,
              mediaPath: join(dir, "youtube", "CancelSuccess", "media", "youtube-CancelSuccess.webm"),
              metadataPath,
              sourceMetadataPath: join(dir, "youtube", "CancelSuccess", "source.json"),
            });
          })();
        }, { once: true });
      });
    };

    try {
      const { coordinator } = createTmuApp({
        config: {
          offlineYouTubeCache: {
            cacheDir: dir,
            mediaDirName: "media",
            metadataFileName: "metadata.json",
          },
        },
        dependencyRunner: runner,
        youtubeDownloader: downloader,
      });

      await coordinator.start();
      await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "youtube-url-download" });
      await coordinator.dispatch({ type: "setPromptInput", value: "https://www.youtube.com/watch?v=CancelSuccess" });
      await coordinator.dispatch({ type: "submitPrompt" });
      await waitFor(() => {
        expect(observedSignal).not.toBeUndefined();
      });

      await coordinator.dispatch({ type: "cancelYouTubeDownload" });

      await waitFor(() => {
        expect(coordinator.appState.downloads.active).toBe(false);
        expect(coordinator.appState.lastEvent).toBe("YouTube download cancelled");
      });
      expect(observedSignal?.aborted).toBe(true);
      expect(coordinator.appState.queue.entries).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cancels active YouTube identify before a download starts", async () => {
    let observedSignal: AbortSignal | undefined;
    const runner: DependencyCommandRunner = async (request) => {
      observedSignal = request.signal;
      return await new Promise((resolve) => {
        request.signal?.addEventListener("abort", () => {
          resolve({
            exitCode: null,
            stdout: "",
            stderr: "",
            errorMessage: "identify aborted",
          });
        }, { once: true });
      });
    };
    const downloaderCalls: YouTubeDownloadOptions[] = [];
    const downloader: YouTubeDownloader = async (options) => {
      downloaderCalls.push(options);
      return { ok: false, message: "download should not start" };
    };
    const { coordinator } = createTmuApp({
      dependencyRunner: runner,
      youtubeDownloader: downloader,
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "youtube-url-download" });
    await coordinator.dispatch({ type: "setPromptInput", value: "https://www.youtube.com/watch?v=CancelIdentify" });
    await coordinator.dispatch({ type: "submitPrompt" });
    await waitFor(() => {
      expect(observedSignal).not.toBeUndefined();
    });

    await coordinator.dispatch({ type: "cancelYouTubeDownload" });

    await waitFor(() => {
      expect(observedSignal?.aborted).toBe(true);
      expect(coordinator.appState.downloads.active).toBe(false);
      expect(coordinator.appState.lastEvent).toBe("YouTube download cancelled");
    });
    expect(downloaderCalls).toEqual([]);
  });

  test("surfaces yt-dlp identify stderr from the YouTube URL prompt without starting a download", async () => {
    const requests: DependencyCommandRequest[] = [];
    const runner: DependencyCommandRunner = async (request) => {
      requests.push(request);
      return {
        exitCode: 1,
        stdout: "",
        stderr: "ERROR: [youtube] BotCheck: Sign in to confirm you are not a bot.",
      };
    };
    const { coordinator } = createTmuApp({ dependencyRunner: runner });

    await coordinator.start();
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "youtube-url-download" });
    await coordinator.dispatch({ type: "setPromptInput", value: "https://www.youtube.com/watch?v=BotCheck" });
    await coordinator.dispatch({ type: "submitPrompt" });

    await waitFor(() => {
      expect(coordinator.appState.lastEvent).toBe(
        "yt-dlp identify failed: ERROR: [youtube] BotCheck: Sign in to confirm you are not a bot.",
      );
    });
    expect(requests).toHaveLength(1);
    expect(coordinator.appState.queue.entries).toEqual([]);
    expect(coordinator.appState.downloads).toEqual({ active: false, lines: [] });
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

function connectedNavidromeConfig(navidromeOverrides: NonNullable<TmuConfigInput["providers"]>["navidrome"] = {}): TmuConfigInput {
  return {
    providers: {
      navidrome: {
        enabled: true,
        serverUrl: "https://music.example.test",
        username: "alex",
        password: "secret-password",
        clientName: "tmu-test",
        ...navidromeOverrides,
      },
    },
  };
}

function navidromeTrack(id: string, title: string, durationSeconds?: number): Track {
  return {
    identity: {
      providerId: "navidrome",
      stableId: `Navidrome:https://music.example.test:track:${id}`,
    },
    title,
    providerLabel: "Navidrome",
    durationSeconds,
  };
}

function navidromeJson(subsonicResponse: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    "subsonic-response": {
      version: "1.16.1",
      ...subsonicResponse,
    },
  }), {
    headers: { "content-type": "application/json" },
  });
}

function navidromeEndpointName(url: URL): string {
  return url.pathname.split("/").at(-1)?.replace(/\.view$/, "") ?? "";
}
