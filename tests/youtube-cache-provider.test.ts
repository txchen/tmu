import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createYouTubeCacheProvider,
  writeYouTubeCacheMetadata,
} from "../src/index";

describe("YouTubeCacheProvider", () => {
  test("lists only healthy flat cache entries newest first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-cache-"));
    try {
      await writeEntry(dir, {
        videoId: "older123456",
        title: "Older Track",
        uploader: "Ada",
        cachedAt: "2026-02-01T10:00:00.000Z",
        mediaFileName: "older123456.opus",
        container: "opus",
      });
      await writeEntry(dir, {
        videoId: "newer456789",
        title: "Newer Track",
        uploader: "Grace",
        durationSeconds: 125,
        cachedAt: "2026-03-01T10:00:00.000Z",
        mediaFileName: "newer456789.webm",
        container: "webm",
        thumbnailUrl: "https://i.ytimg.com/vi/newer456789/default.jpg",
      });

      const provider = createYouTubeCacheProvider({ cacheDir: dir });

      expect(provider.listTracks()).toEqual([
        {
          identity: { providerId: "youtube-cache", stableId: "newer456789" },
          title: "Newer Track",
          artist: "Grace",
          durationSeconds: 125,
          providerLabel: "YouTube Cache",
        },
        {
          identity: { providerId: "youtube-cache", stableId: "older123456" },
          title: "Older Track",
          artist: "Ada",
          providerLabel: "YouTube Cache",
        },
      ]);
      expect(provider.listCacheEntries().map((entry) => entry.mediaPath)).toEqual([
        join(dir, "newer456789.webm"),
        join(dir, "older123456.opus"),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("searches locally by title, uploader, and exact-case-insensitive video ID", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-cache-"));
    try {
      await writeEntry(dir, entry("AbC123xyz01", "Quiet Night", "Studio Channel"));
      await writeEntry(dir, entry("other456789", "Morning Light", "Elsewhere"));
      const provider = createYouTubeCacheProvider({ cacheDir: dir });

      expect(provider.searchTracks("quiet").map(id)).toEqual(["AbC123xyz01"]);
      expect(provider.searchTracks("STUDIO").map(id)).toEqual(["AbC123xyz01"]);
      expect(provider.searchTracks("abc123").map(id)).toEqual(["AbC123xyz01"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("detects incomplete TMU-shaped entries but excludes them and ignores unrelated files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-cache-"));
    try {
      await writeFile(join(dir, "missmedia01.json"), JSON.stringify(entryMetadata(
        "missmedia01", "Missing Media", "Ada", "missmedia01.opus",
      )));
      await writeFile(join(dir, "emptymedia0.opus"), "");
      await writeFile(join(dir, "emptymedia0.json"), JSON.stringify(entryMetadata(
        "emptymedia0", "Empty Media", "Ada", "emptymedia0.opus",
      )));
      await writeFile(join(dir, "orphan12345.webm"), "orphan bytes");
      await writeFile(join(dir, "broken45678.json"), "{not json");
      await writeFile(join(dir, "notes.txt"), "leave me alone");
      await writeFile(join(dir, "random.json"), JSON.stringify({ hello: "world" }));
      await writeFile(join(dir, "settings.json"), "{not json");
      await writeFile(join(dir, "favorite.mp3"), "user audio");

      const provider = createYouTubeCacheProvider({ cacheDir: dir });

      expect(provider.listTracks()).toEqual([]);
      expect(provider.listIncompleteEntries().map((entry) => entry.stem)).toEqual([
        "broken45678",
        "emptymedia0",
        "missmedia01",
        "orphan12345",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects mismatched names, extra sidecar authority, and invalid metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-cache-"));
    try {
      const cases = [
        ["wrongstem01", { ...entryMetadata("actualid001", "Wrong Stem", "Ada", "wrongstem01.opus") }],
        ["wrongmedia1", { ...entryMetadata("wrongmedia1", "Wrong Media", "Ada", "different.opus") }],
        ["sourceurl01", { ...entryMetadata("sourceurl01", "Source URL", "Ada", "sourceurl01.opus"), sourceUrl: "https://youtube.com/watch?v=sourceurl01" }],
        ["badtime0001", { ...entryMetadata("badtime0001", "Bad Time", "Ada", "badtime0001.opus"), cachedAt: "yesterday" }],
      ] as const;
      for (const [stem, metadata] of cases) {
        await writeFile(join(dir, `${stem}.json`), JSON.stringify(metadata));
        await writeFile(join(dir, `${stem}.opus`), "audio");
      }
      await writeFile(join(dir, "duplicate01.json"), JSON.stringify(entryMetadata(
        "duplicate01", "Duplicate", "Ada", "duplicate01.opus",
      )));
      await writeFile(join(dir, "duplicate01.opus"), "audio");
      await writeFile(join(dir, "duplicate01.webm"), "audio");
      const duplicateSidecar = entryMetadata("sidecase001", "Sidecar Case", "Ada", "sidecase001.opus");
      await writeFile(join(dir, "sidecase001.json"), JSON.stringify(duplicateSidecar));
      await writeFile(join(dir, "sidecase001.JSON"), JSON.stringify(duplicateSidecar));
      await writeFile(join(dir, "sidecase001.opus"), "audio");

      const provider = createYouTubeCacheProvider({ cacheDir: dir });
      expect(provider.listTracks()).toEqual([]);
      expect(provider.listIncompleteEntries()).toHaveLength(6);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes only the authoritative sidecar fields beside media", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-cache-"));
    try {
      const metadataPath = await writeYouTubeCacheMetadata({ cacheDir: dir }, {
        videoId: "persisted01",
        title: "Persisted Track",
        uploader: "Cache Artist",
        durationSeconds: 99,
        cachedAt: "2026-04-05T12:34:56.000Z",
        mediaFileName: "persisted01.m4a",
        container: "m4a",
        thumbnailUrl: "https://i.ytimg.com/vi/persisted01/default.jpg",
      });

      expect(metadataPath).toBe(join(dir, "persisted01.json"));
      expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual({
        videoId: "persisted01",
        title: "Persisted Track",
        uploader: "Cache Artist",
        durationSeconds: 99,
        cachedAt: "2026-04-05T12:34:56.000Z",
        mediaFileName: "persisted01.m4a",
        container: "m4a",
        thumbnailUrl: "https://i.ytimg.com/vi/persisted01/default.jpg",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resolves only a healthy cache Track to its local media file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-cache-"));
    try {
      await writeEntry(dir, entry("playable001", "Playable", "Ada"));
      const provider = createYouTubeCacheProvider({ cacheDir: dir });

      await expect(provider.resolvePlaybackLocator({
        providerId: "youtube-cache",
        stableId: "playable001",
      })).resolves.toEqual({ kind: "file", path: join(dir, "playable001.opus") });
      await expect(provider.resolvePlaybackLocator({
        providerId: "youtube-cache",
        stableId: "missing0000",
      })).rejects.toThrow("YouTube Cache entry is missing: missing0000");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("permanently deletes one healthy entry and cleans only one targeted incomplete entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-cache-delete-"));
    try {
      await writeEntry(dir, entry("healthy0001", "Healthy", "Ada"));
      await writeFile(join(dir, "broken00001.opus"), "orphan bytes");
      await writeFile(join(dir, "notes.txt"), "unrelated");
      const provider = createYouTubeCacheProvider({ cacheDir: dir });

      await expect(provider.deleteCacheEntry({ providerId: "youtube-cache", stableId: "healthy0001" }))
        .resolves.toBe(true);
      expect(provider.listTracks()).toEqual([]);
      await expect(readFile(join(dir, "healthy0001.opus"), "utf8")).rejects.toThrow();
      await expect(readFile(join(dir, "healthy0001.json"), "utf8")).rejects.toThrow();

      await expect(provider.cleanupIncompleteEntry("broken00001")).resolves.toBe(true);
      expect(provider.listIncompleteEntries()).toEqual([]);
      expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("unrelated");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function id(track: { identity: { stableId: string } }): string {
  return track.identity.stableId;
}

function entry(videoId: string, title: string, uploader: string) {
  return {
    videoId,
    title,
    uploader,
    cachedAt: "2026-01-01T00:00:00.000Z",
    mediaFileName: `${videoId}.opus`,
    container: "opus",
  };
}

function entryMetadata(
  videoId: string,
  title: string,
  uploader: string,
  mediaFileName: string,
) {
  return {
    videoId,
    title,
    uploader,
    cachedAt: "2026-01-01T00:00:00.000Z",
    mediaFileName,
    container: "opus",
  };
}

async function writeEntry(
  cacheDir: string,
  metadata: ReturnType<typeof entry> & { durationSeconds?: number; thumbnailUrl?: string },
): Promise<void> {
  await writeFile(join(cacheDir, metadata.mediaFileName), "audio bytes");
  await writeFile(join(cacheDir, `${metadata.videoId}.json`), JSON.stringify(metadata));
}
