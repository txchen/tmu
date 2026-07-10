import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NoopPlayer,
  createOfflineYouTubeCacheProvider,
  createTmuApp,
  writeOfflineYouTubeCacheMetadata,
  type PlaybackLocator,
} from "../src/index";

class RecordingPlayer extends NoopPlayer {
  readonly loaded: PlaybackLocator[] = [];

  async load(locator: PlaybackLocator): Promise<void> {
    this.loaded.push(locator);
    await super.load(locator);
  }
}

describe("OfflineYouTubeCacheProvider", () => {
  test("discovers normalized cache metadata with present and missing media files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-offline-cache-"));

    try {
      await writeCacheEntry(dir, {
        extractor: "YouTube",
        id: "late-upload",
        title: "Late Upload",
        artist: "Ada",
        album: "Uploads",
        durationSeconds: 125,
        coverArtId: "yt-thumb",
        mediaFileName: "late-upload.opus",
        writeMedia: true,
      });
      await writeCacheEntry(dir, {
        extractor: "youtube",
        id: "missing-copy",
        title: "Missing Copy",
        mediaFileName: "missing-copy.m4a",
        writeMedia: false,
      });

      const provider = createOfflineYouTubeCacheProvider({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      });

      expect(provider.listCacheEntries().map((entry) => ({
        identity: entry.track.identity,
        title: entry.track.title,
        availability: entry.availability,
      }))).toEqual([
        {
          identity: { providerId: "offline-youtube-cache", stableId: "youtube:late-upload" },
          title: "Late Upload",
          availability: { status: "available" },
        },
        {
          identity: { providerId: "offline-youtube-cache", stableId: "youtube:missing-copy" },
          title: "Missing Copy",
          availability: {
            status: "unavailable",
            reason: "Cached media file is missing",
          },
        },
      ]);
      expect(provider.listVisibleTracks()[0]).toEqual({
        identity: { providerId: "offline-youtube-cache", stableId: "youtube:late-upload" },
        title: "Late Upload",
        providerLabel: "Offline YouTube Cache",
        artist: "Ada",
        album: "Uploads",
        durationSeconds: 125,
        coverArtId: "yt-thumb",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("orders browse entries by normalized title while preserving durable extractor/id identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-offline-cache-"));

    try {
      await writeCacheEntry(dir, {
        extractor: "youtube",
        id: "z-id",
        title: "Zephyr",
        mediaFileName: "z.opus",
        writeMedia: true,
      });
      await writeCacheEntry(dir, {
        extractor: "YouTube",
        id: "AbC123",
        title: "Amber",
        mediaFileName: "a.opus",
        writeMedia: true,
      });

      const provider = createOfflineYouTubeCacheProvider({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      });

      expect(provider.listVisibleTracks().map((track) => `${track.title}:${track.identity.stableId}`)).toEqual([
        "Amber:youtube:AbC123",
        "Zephyr:youtube:z-id",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("looks up cache entries by Track Identity and resolves present media to local-file Playback Locators", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-offline-cache-"));

    try {
      await writeCacheEntry(dir, {
        extractor: "youtube",
        id: "abc123",
        title: "Cached Track",
        mediaFileName: "cached.webm",
        writeMedia: true,
      });
      const provider = createOfflineYouTubeCacheProvider({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      });
      const identity = { providerId: "offline-youtube-cache", stableId: "youtube:abc123" };

      const entry = provider.findByIdentity(identity);

      expect(entry?.track.title).toBe("Cached Track");
      await expect(provider.resolvePlaybackLocator(identity)).resolves.toEqual({
        kind: "file",
        path: join(dir, "youtube", "abc123", "media", "cached.webm"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps unavailable cache entries visible and rejects playback resolution when media is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-offline-cache-"));

    try {
      await writeCacheEntry(dir, {
        extractor: "youtube",
        id: "missing",
        title: "Missing Media",
        mediaFileName: "missing.opus",
        writeMedia: false,
      });
      const provider = createOfflineYouTubeCacheProvider({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      });
      const identity = { providerId: "offline-youtube-cache", stableId: "youtube:missing" };

      expect(provider.listVisibleTracks().map((track) => track.title)).toEqual(["Missing Media"]);
      expect(provider.findByIdentity(identity)?.availability).toEqual({
        status: "unavailable",
        reason: "Cached media file is missing",
      });
      await expect(provider.resolvePlaybackLocator(identity)).rejects.toThrow("Cached media file is missing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("persists normalized cache metadata as file sidecars without creating an app database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-offline-cache-"));

    try {
      await writeOfflineYouTubeCacheMetadata({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      }, {
        version: 1,
        extractor: "youtube",
        id: "persisted",
        title: "Persisted Track",
        artist: "Cache Artist",
        mediaFileName: "persisted.opus",
      });
      await mkdir(join(dir, "youtube", "persisted", "media"), { recursive: true });
      await writeFile(join(dir, "youtube", "persisted", "media", "persisted.opus"), "audio bytes");

      const provider = createOfflineYouTubeCacheProvider({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      });

      expect(provider.listVisibleTracks()).toEqual([{
        identity: { providerId: "offline-youtube-cache", stableId: "youtube:persisted" },
        title: "Persisted Track",
        providerLabel: "Offline YouTube Cache",
        artist: "Cache Artist",
      }]);
      expect(provider.findByIdentity({
        providerId: "offline-youtube-cache",
        stableId: "youtube:persisted",
      })?.metadataPath).toBe(join(dir, "youtube", "persisted", "metadata.json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("enqueues and plays cached Tracks through the shared Queue and mpv file path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-offline-cache-"));
    const player = new RecordingPlayer();

    try {
      await writeCacheEntry(dir, {
        extractor: "youtube",
        id: "playable",
        title: "Playable Cache",
        mediaFileName: "playable.opus",
        writeMedia: true,
      });
      const { coordinator } = createTmuApp({
        config: {
          offlineYouTubeCache: {
            cacheDir: dir,
            mediaDirName: "media",
            metadataFileName: "metadata.json",
          },
        },
        player,
      });

      await coordinator.start();
      await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "offline-youtube-cache" });
      await coordinator.dispatch({ type: "enqueueSelectedTrack" });
      await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "queue" });
      await coordinator.dispatch({ type: "startSelectedQueueEntry" });

      expect(coordinator.appState.queue.entries[0]?.track.identity).toEqual({
        providerId: "offline-youtube-cache",
        stableId: "youtube:playable",
      });
      expect(player.loaded).toEqual([{
        kind: "file",
        path: join(dir, "youtube", "playable", "media", "playable.opus"),
      }]);
      expect(coordinator.appState.playback.status).toBe("playing");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shows unavailable cached media in the Provider Browsing Surface", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-offline-cache-"));

    try {
      await writeCacheEntry(dir, {
        extractor: "youtube",
        id: "missing",
        title: "Missing Browse Entry",
        mediaFileName: "missing.opus",
        writeMedia: false,
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

    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function writeCacheEntry(
  cacheDir: string,
  options: {
    extractor: string;
    id: string;
    title: string;
    mediaFileName: string;
    writeMedia: boolean;
    artist?: string;
    album?: string;
    durationSeconds?: number;
    coverArtId?: string;
  },
): Promise<void> {
  const extractor = options.extractor.toLowerCase();
  const entryDir = join(cacheDir, extractor, options.id);
  await mkdir(join(entryDir, "media"), { recursive: true });
  await writeFile(join(entryDir, "metadata.json"), JSON.stringify({
    version: 1,
    extractor: options.extractor,
    id: options.id,
    title: options.title,
    artist: options.artist,
    album: options.album,
    durationSeconds: options.durationSeconds,
    coverArtId: options.coverArtId,
    mediaFileName: options.mediaFileName,
  }, null, 2));
  if (options.writeMedia) {
    await writeFile(join(entryDir, "media", options.mediaFileName), "audio bytes");
  }
}
