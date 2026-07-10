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
  type LastQueueSnapshot,
  type LastQueueSnapshotPersistence,
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

class RecordingSnapshotPersistence implements LastQueueSnapshotPersistence {
  readonly saves: LastQueueSnapshot[] = [];
  snapshot: LastQueueSnapshot | null = null;
  failWrites = 0;
  quarantined = false;

  async load(): Promise<LastQueueSnapshot | null> {
    return this.snapshot;
  }

  async save(snapshot: LastQueueSnapshot): Promise<void> {
    if (this.failWrites > 0) {
      this.failWrites -= 1;
      throw new Error("disk is read-only");
    }
    this.snapshot = structuredClone(snapshot);
    this.saves.push(structuredClone(snapshot));
  }


  wasLastLoadQuarantined(): boolean {
    return this.quarantined;
  }
}

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
    capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["track"], operations: [] },
    getNavigationRoot: () => ({ visible: true, order: 10, detail: "fake provider" }),
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
    capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["local-directory", "track"], operations: [] },
    getNavigationRoot: () => ({ visible: true, order: 10, detail: "files and folders" }),
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
    capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["local-directory", "track"], operations: [] },
    getNavigationRoot: () => ({ visible: true, order: 10, detail: "files and folders" }),
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

class FailingTeardownPlayer extends RecordingPlayer {
  async teardown(): Promise<void> {
    this.teardowns += 1;
    throw new Error("Player teardown failed");
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
    expect(coordinator.uiState.overlays[0]).toMatchObject({
      ...uiState.overlays[0], message: expect.stringContaining("Press Enter to retry"),
    });
    expect(coordinator.appState.lastEvent).toContain("Provider is offline");

    outcome = "cancel";
    await coordinator.dispatch({ type: "playNow", target });
    expect(coordinator.appState.queue.entries.map((entry) => entry.track)).toEqual([a]);
    expect(coordinator.uiState.overlays[0]).toMatchObject({
      ...uiState.overlays[0], message: expect.stringContaining("cancelled"),
    });
    expect(coordinator.appState.lastEvent).toBe("Music Collection resolution cancelled");
  });

  test("resolves a lightweight Navidrome Album through the atomic Play Next Queue transformation", async () => {
    const current = track("local", "current", "Current");
    const queue = new MemoryQueue();
    queue.enqueue(current);
    queue.startAt(0);
    const navidrome = createNavidromeProvider({
      config: createDefaultTmuConfig(connectedNavidromeConfig()).providers.navidrome,
      saltFactory: () => "salt",
      fetcher: async () => navidromeJson({ status: "ok", album: { song: [
        { id: "two", title: "Two", discNumber: 1, track: 2 },
        { id: "one", title: "One", discNumber: 1, track: 1 },
      ] } }),
    });
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ navidrome }), uiState: createInitialUiState(),
      queue, player: new NoopPlayer(),
    });

    await coordinator.dispatch({ type: "playNext", target: {
      kind: "music-collection", id: "navidrome:album:album", label: "Album",
      resolve: { providerId: "navidrome", operation: "album-tracks", collectionId: "album" },
    } });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["Current", "One", "Two"]);
    expect(coordinator.appState.queue.currentIndex).toBe(0);

    await coordinator.dispatch({ type: "playNow", target: {
      kind: "music-collection", id: "navidrome:album:album", label: "Album",
      resolve: { providerId: "navidrome", operation: "album-tracks", collectionId: "album" },
    } });
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["Current", "One", "Two"]);
    expect(coordinator.appState.queue.currentIndex).toBe(1);
  });

  test("keeps Queue and Picker Overlay unchanged when Navidrome collection resolution fails", async () => {
    const current = track("local", "current", "Current");
    const queue = new MemoryQueue();
    queue.enqueue(current);
    const navidrome = createNavidromeProvider({
      config: createDefaultTmuConfig(connectedNavidromeConfig()).providers.navidrome,
      saltFactory: () => "salt",
      fetcher: async () => navidromeJson({ status: "failed", error: { code: 0, message: "server offline" } }),
    });
    const uiState = createInitialUiState();
    uiState.overlays = [{
      kind: "music-picker", focus: "results", query: "album", selectedIdentity: null,
      selectedResultIndex: 2, scroll: 1,
    }];
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ navidrome }), uiState, queue, player: new NoopPlayer(),
    });

    await coordinator.dispatch({ type: "playNext", target: {
      kind: "music-collection", id: "navidrome:album:album", label: "Album",
      resolve: { providerId: "navidrome", operation: "album-tracks", collectionId: "album" },
    } });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track)).toEqual([current]);
    expect(coordinator.uiState.overlays[0]).toMatchObject({
      ...uiState.overlays[0], message: expect.stringContaining("Press Enter to retry"),
    });
    expect(coordinator.appState.lastEvent).toContain("server offline");
  });

  test("opens a Navidrome Artist search result into its Albums while keeping the Picker Overlay open", async () => {
    const navidrome = createNavidromeProvider({
      config: createDefaultTmuConfig(connectedNavidromeConfig()).providers.navidrome,
      saltFactory: () => "salt",
      fetcher: async () => navidromeJson({ status: "ok", artist: { album: [
        { id: "album", name: "Album", artist: "Artist" },
      ] } }),
    });
    const uiState = createInitialUiState();
    uiState.overlays = [{
      kind: "music-picker", focus: "results", query: "artist", selectedIdentity: null,
      selectedResultIndex: 2, scroll: 1,
    }];
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ navidrome }), uiState, queue: new MemoryQueue(), player: new NoopPlayer(),
    });

    await coordinator.dispatch({ type: "globalSearch", operation: "open", result: {
      providerId: "navidrome", providerLabel: "Navidrome", type: "artist", id: "artist", label: "Artist",
    } });

    expect(coordinator.uiState.overlays).toHaveLength(1);
    expect(coordinator.uiState.overlays[0]).toMatchObject({
      query: "", providerLocation: { providerId: "navidrome", path: [{ kind: "artists" }, { kind: "artist", id: "artist" }] },
    });
    expect(navidrome.listBrowserEntries!({ providerId: "navidrome", path: [{ kind: "artists" }, { kind: "artist", id: "artist" }] }))
      .toEqual(expect.arrayContaining([
        { id: "artist", kind: "artist", label: "Artist" },
        { id: "album", kind: "album", label: "Album", detail: "Artist" },
      ]));
  });

  test("starts on Queue Home with source-neutral Provider navigation and separate app and UI state", async () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });

    await coordinator.start();

    expect(coordinator.appState.queue.entries).toEqual([]);
    expect(coordinator.uiState.focusedPane).toBe("queue");
    expect(coordinator.uiState.activeTargetId).toBe("queue");
    expect(coordinator.uiState.providerLocation).toEqual({ providerId: null, path: [] });
    expect(coordinator.appState).not.toBe(coordinator.uiState);
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
    first.dispatchUi({ type: "updateView", patch: {
      activeTargetId: "local", focusedPane: "content", providerLocation: { providerId: "local", path: [] },
    } });
    await first.dispatch({ type: "playerOperation", operation: "toggle-shuffle" });
    await first.dispatch({ type: "playerOperation", operation: "toggle-repeat-all" });
    await first.dispatch({ type: "playerOperation", operation: "set-volume", percent: 36, ready: true });

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
    expect(second.uiState.activeTargetId).toBe("queue");
    expect(second.uiState.focusedPane).toBe("queue");
    expect(second.uiState.providerLocation).toEqual({ providerId: null, path: [] });
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
      expect(coordinator.uiState.activeTargetId).toBe("queue");
      expect(coordinator.uiState.providerLocation).toEqual({ providerId: null, path: [] });
      expect(coordinator.appState.appErrors).toEqual(expect.arrayContaining([
        expect.stringContaining("Last Queue Snapshot was corrupted"),
        expect.stringContaining("Ignored corrupted app preferences"),
      ]));
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
      await coordinator.dispatch({ type: "providerOperation", providerId: "local", operation: "open-path", path: album });

      expect(coordinator.uiState.activeTargetId).toBe("queue");
      expect(coordinator.uiState.providerLocation).toEqual({ providerId: null, path: [] });
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
      await coordinator.dispatch({ type: "providerOperation", providerId: "local", operation: "open-path", path: dir, signal: controller.signal });

      expect(coordinator.appState.queue.entries).toEqual([]);
      expect(coordinator.appState.lastEvent).toBe("cancelled Local open after 0 Tracks");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retries a configured Navidrome failure through the Provider operation", async () => {
    const config = connectedNavidromeConfig();
    const provider = createNavidromeProvider({
      config: createDefaultTmuConfig(config).providers.navidrome,
      fetcher: async () => new Response(JSON.stringify({
        "subsonic-response": { status: "ok", version: "1.16.1" },
      }), { status: 200 }),
    });
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ navidrome: provider }, { config }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new RecordingPlayer(),
    });

    await coordinator.dispatch({ type: "providerOperation", providerId: "navidrome", operation: "retry" });

    expect(provider.getConnectionState().status).toBe("connected");
    expect(coordinator.appState.lastEvent).toBe("Navidrome connection restored");
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

  test("completes coordinator teardown and records cleanup failures", async () => {
    const player = new FailingTeardownPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    await expect(coordinator.teardown()).resolves.toBeUndefined();

    expect(player.teardowns).toBe(1);
    expect(coordinator.appState.appErrors).toContain("Coordinator cleanup failed: Player teardown failed");
  });

  test("quit intent tears down the Player through the App Coordinator", async () => {
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });

    await coordinator.dispatch({ type: "playerOperation", operation: "quit" });
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

  test("atomically restores Current Track and position for explicit Resume without autoplay and selects Current", async () => {
    const first = track("local", "/music/first.flac", "First");
    const current = track("local", "/music/current.flac", "Current");
    const persistence = new RecordingSnapshotPersistence();
    persistence.snapshot = {
      version: 1,
      entries: [first, current].map((item) => ({ track: item, availability: { status: "available" as const } })),
      currentIndex: 1,
      positionSeconds: 37,
      shuffle: true,
      repeatAll: true,
      volume: { percent: 63, ready: true },
    };
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ local: fakeProvider("local", [first, current]) }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
      snapshotPersistence: persistence,
    });

    await coordinator.start();

    expect(player.loaded).toEqual([]);
    expect(coordinator.appState.playback).toEqual({
      status: "paused",
      positionSeconds: 37,
      currentTrackIdentity: current.identity,
    });
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(current.identity);
    expect(coordinator.appState.queue).toMatchObject({ currentIndex: 1, shuffle: true, repeatAll: true });
    expect(coordinator.appState.volume).toEqual({ percent: 63, ready: true });
    expect(player.volumes).toEqual([63]);

    await coordinator.dispatch({ type: "playerOperation", operation: "toggle-play-pause" });
    expect(player.loaded).toEqual([{ kind: "file", path: "/resolved/local//music/current.flac" }]);
    expect(player.seeks).toEqual([37]);
  });

  test("invalid startup restore suppresses quit replacement until a meaningful change", async () => {
    const persistence = new RecordingSnapshotPersistence();
    persistence.quarantined = true;
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ local: fakeProvider("local") }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
      snapshotPersistence: persistence,
    });
    await coordinator.start();
    await coordinator.teardown();

    expect(persistence.saves).toEqual([]);
  });

  test("automatically follows visible Queue order at natural completion and stops at the end", async () => {
    const first = track("local", "/music/first.flac", "First File");
    const missing = track("local", "/music/missing.flac", "Missing File");
    const last = track("local", "/music/last.flac", "Last File");
    const queue = new MemoryQueue();
    const player = new ManualPlaybackPlayer();
    const snapshotPersistence = new RecordingSnapshotPersistence();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ local: fakeProvider("local", [first, missing, last]) }),
      uiState: createInitialUiState(),
      queue,
      player,
      snapshotPersistence,
    });

    for (const queued of [first, missing, last]) queue.enqueue(queued);
    queue.markAvailability(missing.identity, { status: "unavailable", reason: "file missing" });
    await coordinator.dispatch({ type: "playNow", target: first });

    player.emitPlaybackState({ status: "idle", idle: true, eof: true });
    await waitFor(() => expect(coordinator.appState.playback.currentTrackIdentity).toEqual(last.identity));
    await waitFor(() => expect(snapshotPersistence.snapshot?.currentIndex).toBe(2));
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
    await waitFor(() => expect(snapshotPersistence.snapshot?.positionSeconds).toBe(0));
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
