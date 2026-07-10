import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NoopPlayer,
  createYouTubeCacheProvider,
  createTmuApp,
  writeYouTubeCacheMetadata,
  type PlaybackLocator,
} from "../src/index";

class RecordingPlayer extends NoopPlayer {
  readonly loaded: PlaybackLocator[] = [];

  async load(locator: PlaybackLocator): Promise<void> {
    this.loaded.push(locator);
    await super.load(locator);
  }
}

describe("YouTubeCacheProvider", () => {
  test("discovers normalized cache metadata with present and missing media files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-offline-cache-"));

    try {
      await writeCacheEntry(dir, {
        extractor: "YouTube",
        id: "late-upload",
        title: "Late Upload",
        artist: "Ada",
        durationSeconds: 125,
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

      const provider = createYouTubeCacheProvider({
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
          identity: { providerId: "youtube-cache", stableId: "late-upload" },
          title: "Late Upload",
          availability: { status: "available" },
        },
        {
          identity: { providerId: "youtube-cache", stableId: "missing-copy" },
          title: "Missing Copy",
          availability: {
            status: "unavailable",
            reason: "Cached media file is missing",
          },
        },
      ]);
      expect(provider.listTracks()[0]).toEqual({
        identity: { providerId: "youtube-cache", stableId: "late-upload" },
        title: "Late Upload",
        providerLabel: "YouTube Cache",
        artist: "Ada",
        durationSeconds: 125,
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

      const provider = createYouTubeCacheProvider({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      });

      expect(provider.listTracks().map((track) => `${track.title}:${track.identity.stableId}`)).toEqual([
        "Amber:AbC123",
        "Zephyr:z-id",
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
      const provider = createYouTubeCacheProvider({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      });
      const identity = { providerId: "youtube-cache", stableId: "abc123" };

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
      const provider = createYouTubeCacheProvider({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      });
      const identity = { providerId: "youtube-cache", stableId: "missing" };

      expect(provider.listTracks().map((track) => track.title)).toEqual(["Missing Media"]);
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
      await writeYouTubeCacheMetadata({
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

      const provider = createYouTubeCacheProvider({
        cacheDir: dir,
        mediaDirName: "media",
        metadataFileName: "metadata.json",
      });

      expect(provider.listTracks()).toEqual([{
        identity: { providerId: "youtube-cache", stableId: "persisted" },
        title: "Persisted Track",
        providerLabel: "YouTube Cache",
        artist: "Cache Artist",
      }]);
      expect(provider.findByIdentity({
        providerId: "youtube-cache",
        stableId: "persisted",
      })?.metadataPath).toBe(join(dir, "youtube", "persisted", "metadata.json"));
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
