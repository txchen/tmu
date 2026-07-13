import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { AppCoordinator } from "../src/coordinator";
import { PlaybackFailure, type PlaybackLocator, type PlayerLoadOptions, type PlayerPlaybackState, type Provider, type Track } from "../src/domain";
import { NoopPlayer } from "../src/player";
import { MemoryPlaylistContent } from "../src/playlist-content";
import { InMemoryLastPlaylistSnapshotPersistence } from "../src/playlist-snapshot";
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
  readonly loadOptions: PlayerLoadOptions[] = [];
  teardownCount = 0;

  override async load(locator: PlaybackLocator, options: PlayerLoadOptions = {}): Promise<void> {
    this.loaded.push(locator);
    this.loadOptions.push(options);
    await super.load(locator, options);
  }

  override async teardown(): Promise<void> {
    this.teardownCount += 1;
  }

  publishForTest(state: PlayerPlaybackState): void {
    this.updateState(state);
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

class StopFailingPlayer extends RecordingPlayer {
  override async stop(): Promise<never> {
    throw new Error("mpv stop failed");
  }
}

class SeekFailingPlayer extends RecordingPlayer {
  override async seekBy(): Promise<never> {
    const message = "mpv error: property unavailable";
    this.updateState({
      ...this.playback,
      commandError: { command: "seek 42 relative", message, recoverable: true },
      message,
    });
    throw new Error(message);
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
    initialPlaylistContent: new MemoryPlaylistContent(),
    player,
  });
  return { coordinator, player };
}

describe("AppCoordinator with the narrow Provider", () => {
  test("keeps shared Track metadata and Cache Availability canonical across Playlists", async () => {
    let track = { ...cachedTrack };
    let deleted = false;
    const provider: YouTubeCacheProvider = {
      id: "youtube-cache", label: "YouTube Cache",
      listTracks: () => deleted ? [] : [track], searchTracks: () => deleted ? [] : [track],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/cached-track.opus" }),
      refresh: () => undefined, listCacheEntries: () => [], listIncompleteEntries: () => [],
      findByIdentity: () => deleted ? undefined : ({
        track, availability: { status: "available" },
        metadata: { videoId: "cached-track", title: track.title, uploader: "Cache Artist", cachedAt: "2026-01-01T00:00:00.000Z", mediaFileName: "cached-track.opus", container: "opus" },
        metadataPath: "/cache/cached-track.json", mediaPath: "/cache/cached-track.opus",
      }),
      renameTrack: async (_identity, title) => (track = { ...track, title }),
      deleteCacheEntry: async () => { deleted = true; return true; },
      cleanupIncompleteEntry: async () => false,
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player: new RecordingPlayer(),
    });
    await coordinator.dispatch({ type: "addToPlaylist", target: track });
    const defaultId = coordinator.appState.playlists.activePlaylistId;
    await coordinator.dispatch({ type: "createPlaylist", name: "Study" });
    await coordinator.dispatch({ type: "addToPlaylist", target: track });

    await coordinator.dispatch({ type: "renameTrack", identity: track.identity, title: "Canonical Title" });

    expect(coordinator.appState.playlists.playlists.map((playlist) => playlist.entries[0]?.track.title))
      .toEqual(["Canonical Title", "Canonical Title"]);
    await coordinator.dispatch({ type: "cacheOperation", operation: "request-delete", identity: track.identity });
    await coordinator.dispatch({ type: "cacheOperation", operation: "confirm" });
    expect(coordinator.appState.playlists.playlists.map((playlist) => playlist.entries[0]?.availability.status))
      .toEqual(["unavailable", "unavailable"]);
    expect(coordinator.appState.playlists.playlists.map((playlist) => playlist.entries.map((entry) => entry.track.identity.stableId)))
      .toEqual([["cached-track"], ["cached-track"]]);

    await coordinator.dispatch({ type: "switchPlaylist", playlistId: defaultId });
    expect(coordinator.appState.activePlaylistContent.entries[0]?.availability.status).toBe("unavailable");
  });

  test("shares playback failure Availability so traversal skips the identity in another Playlist", async () => {
    const player = new PlaybackFailingPlayer();
    const next = { ...cachedTrack, identity: { ...cachedTrack.identity, stableId: "next-track" }, title: "Next" };
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [cachedTrack, next], searchTracks: () => [],
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player,
    });
    await coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack });
    await coordinator.dispatch({ type: "addToPlaylist", target: next });
    const defaultId = coordinator.appState.playlists.activePlaylistId;
    await coordinator.dispatch({ type: "createPlaylist", name: "Study" });
    await coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack });
    await coordinator.dispatch({ type: "addToPlaylist", target: next });
    await coordinator.dispatch({ type: "switchPlaylist", playlistId: defaultId });
    await coordinator.dispatch({ type: "playSelected", identity: cachedTrack.identity });

    player.failPlayback("mpv playback failed: corrupt stream");
    await waitFor(() => coordinator.appState.playback.currentTrackIdentity?.stableId === "next-track");
    await coordinator.dispatch({ type: "switchPlaylist", playlistId: coordinator.appState.playlists.playlists[1]!.id });
    await coordinator.dispatch({ type: "playSelected", identity: cachedTrack.identity });
    await coordinator.dispatch({ type: "playerOperation", operation: "next-track" });

    expect(coordinator.appState.activePlaylistContent.entries[0]?.availability.status).toBe("unavailable");
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(next.identity);
  });

  test("drops shared session playback failures on runtime restart and rescans Cache Availability", async () => {
    const persistence = new InMemoryLastPlaylistSnapshotPersistence();
    const provider: YouTubeCacheProvider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [cachedTrack], searchTracks: () => [],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/cached-track.opus" }),
      refresh: () => undefined, listCacheEntries: () => [], listIncompleteEntries: () => [],
      findByIdentity: () => ({
        track: cachedTrack, availability: { status: "available" },
        metadata: { videoId: "cached-track", title: cachedTrack.title, uploader: "Cache Artist", cachedAt: "2026-01-01T00:00:00.000Z", mediaFileName: "cached-track.opus", container: "opus" },
        metadataPath: "/cache/cached-track.json", mediaPath: "/cache/cached-track.opus",
      }),
      renameTrack: async () => cachedTrack, deleteCacheEntry: async () => false,
      cleanupIncompleteEntry: async () => false,
    };
    const player = new PlaybackFailingPlayer();
    const first = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player, playlistSnapshotPersistence: persistence,
    });
    await first.dispatch({ type: "addToPlaylist", target: cachedTrack });
    await first.dispatch({ type: "createPlaylist", name: "Study" });
    await first.dispatch({ type: "addToPlaylist", target: cachedTrack });
    await first.dispatch({ type: "playSelected", identity: cachedTrack.identity });
    player.failPlayback("mpv playback failed: corrupt stream");
    await waitFor(() => first.appState.activePlaylistContent.entries[0]?.availability.status === "unavailable");
    await first.teardown();

    const restored = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player: new RecordingPlayer(), playlistSnapshotPersistence: persistence,
    });
    await restored.start();

    expect(restored.appState.playlists.playlists.map((playlist) => playlist.entries[0]?.availability.status))
      .toEqual(["available", "available"]);
  });

  test("creates and switches independent Playlist playback contexts without autoplay", async () => {
    const { coordinator, player } = harness();
    await coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack });
    await coordinator.dispatch({ type: "playSelected", identity: cachedTrack.identity });
    player.publishForTest({ status: "playing", positionSeconds: 42 });

    await coordinator.dispatch({ type: "createPlaylist", name: " Study " });

    expect(coordinator.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Default", "Study"]);
    expect(coordinator.appState.activePlaylistContent.entries).toEqual([]);
    expect(coordinator.appState.playback).toEqual({ status: "idle", currentTrackIdentity: null });
    expect(player.loaded).toHaveLength(1);

    await coordinator.dispatch({ type: "addToPlaylist", target: { ...cachedTrack, identity: { ...cachedTrack.identity, stableId: "study" } } });
    const defaultId = coordinator.appState.playlists.playlists[0]!.id;
    await coordinator.dispatch({ type: "switchPlaylist", playlistId: defaultId });

    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.identity.stableId)).toEqual(["cached-track"]);
    expect(coordinator.appState.playback).toMatchObject({ status: "paused", positionSeconds: 42, restored: true });
    expect(player.loaded).toHaveLength(1);
    expect(coordinator.appState.playlists.playlists[1]!.entries[0]!.track.identity.stableId).toBe("study");
  });

  test("rejects invalid Playlist names without changing the Active Playlist", async () => {
    const { coordinator } = harness();
    const activeId = coordinator.appState.playlists.activePlaylistId;
    await expect(coordinator.dispatch({ type: "createPlaylist", name: "default" })).rejects.toThrow("already in use");
    await coordinator.dispatch({ type: "createPlaylist", name: "Straße" });
    await expect(coordinator.dispatch({ type: "createPlaylist", name: "STRASSE" })).rejects.toThrow("already in use");
    await coordinator.dispatch({ type: "switchPlaylist", playlistId: activeId });
    await expect(coordinator.dispatch({ type: "createPlaylist", name: "                 " })).rejects.toThrow("empty");
    await expect(coordinator.dispatch({ type: "createPlaylist", name: "12345678901234567" })).rejects.toThrow("16");
    expect(coordinator.appState.playlists.activePlaylistId).toBe(activeId);
    expect(coordinator.appState.playlists.playlists).toHaveLength(2);
  });

  test.each([
    ["paused", 18, "resumable", 18],
    ["stopped", 99, "stopped", 0],
  ] as const)("switching away from %s preserves the intended Playlist resume state", async (status, positionSeconds, playbackStatus, savedPosition) => {
    const { coordinator } = harness();
    await coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack });
    await coordinator.dispatch({ type: "playSelected", identity: cachedTrack.identity });
    coordinator.appState.playback = { status, positionSeconds, currentTrackIdentity: cachedTrack.identity };
    await coordinator.dispatch({ type: "createPlaylist", name: "Other" });
    expect(coordinator.appState.playlists.playlists[0]).toMatchObject({ playbackStatus, positionSeconds: savedPosition });
  });

  test("restores the created Active Playlist after restart without autoplay", async () => {
    const persistence = new InMemoryLastPlaylistSnapshotPersistence();
    const first = new AppCoordinator({
      appState: createInitialAppState({}), uiState: createInitialUiState(), initialPlaylistContent: new MemoryPlaylistContent(),
      player: new RecordingPlayer(), playlistSnapshotPersistence: persistence,
    });
    await first.dispatch({ type: "createPlaylist", name: "Road" });
    const roadId = first.appState.playlists.activePlaylistId;

    const player = new RecordingPlayer();
    const restored = new AppCoordinator({
      appState: createInitialAppState({}), uiState: createInitialUiState(), initialPlaylistContent: new MemoryPlaylistContent(),
      player, playlistSnapshotPersistence: persistence,
    });
    await restored.start();

    expect(restored.appState.playlists.activePlaylistId).toBe(roadId);
    expect(restored.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Default", "Road"]);
    expect(restored.appState.playback.status).toBe("idle");
    expect(player.loaded).toEqual([]);
  });

  test("does not retain a newly created Playlist when switching cannot stop the Player", async () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({}), uiState: createInitialUiState(), initialPlaylistContent: new MemoryPlaylistContent(), player: new StopFailingPlayer(),
    });
    await expect(coordinator.dispatch({ type: "createPlaylist", name: "Unsafe" })).rejects.toThrow("mpv stop failed");
    expect(coordinator.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Default"]);
    expect(coordinator.appState.playlists.activePlaylistId).toBe(coordinator.appState.playlists.playlists[0]!.id);
  });

  test("Rename Track updates every Playlist copy without interrupting playback", async () => {
    let track = cachedTrack;
    const provider: YouTubeCacheProvider = {
      id: "youtube-cache", label: "YouTube Cache",
      listTracks: () => [track], searchTracks: () => [track],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/cached-track.opus" }),
      refresh: () => undefined, listCacheEntries: () => [], listIncompleteEntries: () => [],
      findByIdentity: () => undefined,
      renameTrack: async (_identity, title) => (track = { ...track, title }),
      deleteCacheEntry: async () => false, cleanupIncompleteEntry: async () => false,
    };
    const playlist = new MemoryPlaylistContent();
    playlist.add(track);
    playlist.startAt(0);
    const player = new RecordingPlayer();
    const appState = createInitialAppState({ "youtube-cache": provider });
    appState.playback = { status: "playing", currentTrackIdentity: track.identity, positionSeconds: 42 };
    const coordinator = new AppCoordinator({ appState, uiState: createInitialUiState(), initialPlaylistContent: playlist, player });
    const playbackBefore = structuredClone(coordinator.appState.playback);

    await coordinator.dispatch({ type: "renameTrack", identity: track.identity, title: "Clear Track Name" });

    expect(coordinator.appState.activePlaylistContent.entries[0]?.track.title).toBe("Clear Track Name");
    expect(coordinator.appState.playback).toEqual(playbackBefore);
    expect(player.loaded).toEqual([]);
    expect(coordinator.appState.lastEvent).toBe("Renamed to “Clear Track Name”");
  });

  test("Randomize Playlist reorders every Track while preserving Current identity", async () => {
    const playlist = new MemoryPlaylistContent({ random: () => 0 });
    const coordinator = new AppCoordinator({ appState: createInitialAppState({}), uiState: createInitialUiState(),
      initialPlaylistContent: playlist, player: new NoopPlayer() });
    const tracks = [cachedTrack, ...["b", "c", "d"].map((id) => ({
      ...cachedTrack, identity: { ...cachedTrack.identity, stableId: id }, title: id.toUpperCase(),
    }))];
    for (const target of tracks) await coordinator.dispatch({ type: "addToPlaylist", target });
    await coordinator.dispatch({ type: "playSelected", identity: tracks[0]!.identity });
    const playbackBefore = coordinator.appState.playback;

    await coordinator.dispatch({ type: "playerOperation", operation: "randomize-playlist" });

    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["b", "c", "d", "cached-track"]);
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(3);
    expect(coordinator.appState.playback).toEqual(playbackBefore);
    expect(coordinator.appState.lastEvent).toBe("randomized Playlist");
  });

  test("Play Next playlists a cached Track without starting playback", async () => {
    const { coordinator, player } = harness();

    await coordinator.dispatch({ type: "playNext", target: cachedTrack });

    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track)).toEqual([cachedTrack]);
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(-1);
    expect(player.loaded).toEqual([]);
  });

  test("Play Now resolves a local Playback Locator and starts the cached Track", async () => {
    const { coordinator, player } = harness();

    await coordinator.dispatch({ type: "playNow", target: cachedTrack });

    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(0);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(cachedTrack.identity);
    expect(player.loaded).toEqual([{ kind: "file", path: "/cache/cached-track.opus" }]);
  });

  test("Play Selected starts an existing Playlist Track from the beginning without changing Playlist order", async () => {
    const { coordinator, player } = harness();
    const first = { ...cachedTrack, identity: { ...cachedTrack.identity, stableId: "first" }, title: "First" };
    const selected = { ...cachedTrack, identity: { ...cachedTrack.identity, stableId: "selected" }, title: "Selected" };
    const last = { ...cachedTrack, identity: { ...cachedTrack.identity, stableId: "last" }, title: "Last" };
    for (const track of [first, selected, last]) {
      await coordinator.dispatch({ type: "addToPlaylist", target: track });
    }

    await coordinator.dispatch({ type: "playSelected", identity: selected.identity });

    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["first", "selected", "last"]);
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(1);
    expect(coordinator.appState.playback).toMatchObject({
      currentTrackIdentity: selected.identity,
      positionSeconds: 0,
    });
    expect(player.loaded.at(-1)).toEqual({ kind: "file", path: "/cache/cached-track.opus" });
  });

  test("Add to Playlist appends once without moving Current or starting playback", async () => {
    const { coordinator, player } = harness();
    const later: Track = {
      identity: { providerId: "youtube-cache", stableId: "later-track" },
      title: "Later Track",
      providerLabel: "YouTube Cache",
    };
    await coordinator.dispatch({ type: "playNow", target: cachedTrack });
    const loadsAfterPlayNow = player.loaded.length;

    await coordinator.dispatch({ type: "addToPlaylist", target: later });
    await coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack });

    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["cached-track", "later-track"]);
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(0);
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
    await coordinator.dispatch({ type: "addToPlaylist", target: later });
    await coordinator.dispatch({ type: "addToPlaylist", target: last });
    await coordinator.dispatch({ type: "playNow", target: cachedTrack });
    const loadsAfterPlayNow = player.loaded.length;

    await coordinator.dispatch({ type: "playNext", target: last });

    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["cached-track", "last-track", "later-track"]);
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(0);
    expect(player.loaded).toHaveLength(loadsAfterPlayNow);
  });

  test("playlist submission requires confirmation and Download Batch execution never changes Playlist or playback", async () => {
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
      initialPlaylistContent: new MemoryPlaylistContent(),
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
    const playlistBefore = structuredClone(coordinator.appState.activePlaylistContent);
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
    expect(coordinator.appState.activePlaylistContent).toEqual(playlistBefore);
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
    expect(coordinator.appState.activePlaylistContent).toEqual(playlistBefore);
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
      appState, uiState: createInitialUiState(), initialPlaylistContent: new MemoryPlaylistContent(), player: new RecordingPlayer(),
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
      initialPlaylistContent: new MemoryPlaylistContent(),
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
      uiState: createInitialUiState(), initialPlaylistContent: new MemoryPlaylistContent(), player,
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
      uiState: createInitialUiState(), initialPlaylistContent: new MemoryPlaylistContent(), player,
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
      appState, uiState: createInitialUiState(), initialPlaylistContent: new MemoryPlaylistContent(), player,
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

  test("confirmed Cache Deletion recomputes playback state and retains the Current Playlist entry unavailable", async () => {
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
      renameTrack: async (_identity, title) => ({ ...cachedTrack, title }),
      deleteCacheEntry: async () => { deleted = true; return true; },
      cleanupIncompleteEntry: async () => false,
    };
    const player = new RecordingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }),
      uiState: createInitialUiState(), initialPlaylistContent: new MemoryPlaylistContent(), player,
    });
    await coordinator.dispatch({ type: "cacheOperation", operation: "request-delete", identity: cachedTrack.identity });
    expect(coordinator.appState.cacheConfirmation).toMatchObject({
      kind: "delete-track", stem: "cached-track", stopsPlayback: false,
    });
    expect(deleted).toBe(false);

    await coordinator.dispatch({ type: "playNow", target: cachedTrack });
    await coordinator.dispatch({ type: "cacheOperation", operation: "confirm" });
    expect(deleted).toBe(true);
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(0);
    expect(coordinator.appState.activePlaylistContent.entries[0]?.availability).toMatchObject({ status: "unavailable" });
    expect(coordinator.appState.playback).toMatchObject({
      status: "stopped", positionSeconds: 0, currentTrackIdentity: cachedTrack.identity,
    });
  });

  test("direct Play Now fails on the requested unavailable Track without substituting another Playlist Track", async () => {
    const bad = { ...cachedTrack, identity: { providerId: "youtube-cache", stableId: "bad-track" }, title: "Bad" };
    const good = { ...cachedTrack, identity: { providerId: "youtube-cache", stableId: "good-track" }, title: "Good" };
    const player = new SelectivelyFailingPlayer();
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [bad, good], searchTracks: () => [bad, good],
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player,
    });
    await coordinator.dispatch({ type: "addToPlaylist", target: good });
    await coordinator.dispatch({ type: "playNow", target: bad });

    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.identity.stableId)).toEqual(["bad-track", "good-track"]);
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(0);
    expect(coordinator.appState.activePlaylistContent.entries[0]?.availability).toEqual({
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
      initialPlaylistContent: new MemoryPlaylistContent(), player,
    });
    for (const track of [first, bad, good]) await coordinator.dispatch({ type: "addToPlaylist", target: track });
    await coordinator.dispatch({ type: "playNow", target: first });
    await coordinator.dispatch({ type: "playerOperation", operation: "next-track" });

    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(good.identity);
    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["first-track", "bad-track", "good-track"]);
    expect(coordinator.appState.activePlaylistContent.entries[1]?.availability.status).toBe("unavailable");
  });

  test("asynchronous mpv failure marks Current unavailable and direct Resume does not retry or substitute", async () => {
    const player = new PlaybackFailingPlayer();
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [cachedTrack], searchTracks: () => [],
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player,
    });
    await coordinator.dispatch({ type: "playNow", target: cachedTrack });
    const loadsBeforeFailure = player.loaded.length;

    player.failPlayback("mpv playback failed: corrupt stream");
    await coordinator.dispatch({ type: "playerOperation", operation: "toggle-play-pause" });

    expect(coordinator.appState.activePlaylistContent.entries[0]?.availability).toEqual({
      status: "unavailable", reason: "mpv playback failed: corrupt stream",
    });
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(0);
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
      initialPlaylistContent: new MemoryPlaylistContent(), player,
    });
    await coordinator.dispatch({ type: "addToPlaylist", target: next });
    await coordinator.dispatch({ type: "playNow", target: cachedTrack });

    player.failPlayback("mpv playback failed: corrupt stream");
    await waitFor(() => coordinator.appState.playback.currentTrackIdentity?.stableId === "next-track");

    expect(coordinator.appState.activePlaylistContent.entries[0]?.availability.status).toBe("unavailable");
    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.identity.stableId))
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
      initialPlaylistContent: new MemoryPlaylistContent(), player,
    });
    await coordinator.dispatch({ type: "playNow", target: cachedTrack });

    expect(coordinator.appState.activePlaylistContent.entries[0]?.availability.status).not.toBe("unavailable");
    expect(coordinator.appState.playback).toMatchObject({ status: "error", message: "mpv IPC socket disconnected" });
  });

  test("restored Playlist availability is rescanned from the current YouTube Cache", async () => {
    const provider: YouTubeCacheProvider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [], searchTracks: () => [],
      resolvePlaybackLocator: async () => { throw new Error("missing"); }, refresh: () => undefined,
      listCacheEntries: () => [], listIncompleteEntries: () => [], findByIdentity: () => undefined,
      renameTrack: async () => { throw new Error("missing"); },
      deleteCacheEntry: async () => false, cleanupIncompleteEntry: async () => false,
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player: new RecordingPlayer(),
      legacyQueueSnapshotPersistence: {
        load: async () => ({
          version: 1,
          entries: [{ track: cachedTrack }],
          currentIndex: 0,
          repeatAll: false,
          volume: { percent: 100, ready: false },
          positionSeconds: 42,
        }),
        save: async () => undefined,
      },
    });
    await coordinator.start();

    expect(coordinator.appState.activePlaylistContent.entries[0]?.availability).toEqual({
      status: "unavailable", reason: "YouTube Cache entry is missing: cached-track",
    });
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(0);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(cachedTrack.identity);
  });

  test("resumes a restored Track atomically without a separate seek", async () => {
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [cachedTrack], searchTracks: () => [],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/cached-track.opus" }),
    };
    const player = new SeekFailingPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player,
      legacyQueueSnapshotPersistence: {
        load: async () => ({
          version: 1, entries: [{ track: cachedTrack }], currentIndex: 0, repeatAll: false,
          volume: { percent: 100, ready: false }, positionSeconds: 42,
        }),
        save: async () => undefined,
      },
    });
    await coordinator.start();

    await coordinator.dispatch({ type: "playerOperation", operation: "toggle-play-pause" });

    expect(player.loaded).toEqual([{ kind: "file", path: "/cache/cached-track.opus" }]);
    expect(player.loadOptions).toEqual([{ startSeconds: 42 }]);
    expect(coordinator.appState.playback).toMatchObject({
      status: "playing", currentTrackIdentity: cachedTrack.identity,
    });
    expect(player.playback.positionSeconds).toBe(42);
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
