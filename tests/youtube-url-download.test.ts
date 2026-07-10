import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeYouTubeDownloadBatch,
  prepareYouTubeDownloadBatch,
  validateYouTubeUrlDownloadInput,
  type DependencyCommandRequest,
  type DownloadBatchEntry,
  type YouTubeDownloadBatch,
  type YouTubeDownloadProcessRunner,
} from "../src/index";

describe("YouTube URL Download adapter", () => {
  test("accepts one supported video URL and rejects bare, multiple, and non-YouTube inputs before extraction", () => {
    for (const input of [
      "https://youtube.com/watch?v=One",
      "https://music.youtube.com/watch?v=One",
      "https://youtu.be/One",
      "https://youtube.com/shorts/One",
    ]) expect(validateYouTubeUrlDownloadInput(input)).toMatchObject({ ok: true, kind: "single" });

    for (const input of [
      "One",
      "https://example.com/watch?v=One",
      "https://youtube.com/watch?v=One https://youtu.be/Two",
    ]) expect(validateYouTubeUrlDownloadInput(input).ok).toBe(false);
  });

  test("treats watch URLs with list parameters as one video", async () => {
    let request: DependencyCommandRequest | undefined;
    const prepared = await prepareYouTubeDownloadBatch(
      "https://youtube.com/watch?v=One&list=PLSurprise&index=4",
      {
        command: "yt-dlp",
        timeoutMs: 1000,
        runner: async (value) => {
          request = value;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ extractor_key: "Youtube", id: "One00000001", title: "First", uploader: "Artist" }),
            stderr: "",
          };
        },
      },
    );

    expect(prepared).toMatchObject({
      kind: "ready",
      batch: { kind: "single", entries: [{ kind: "track", metadata: { id: "One00000001" } }] },
    });
    expect(request?.args).toContain("--no-playlist");
    expect(request?.args.at(-1)).toBe("https://youtube.com/watch?v=One");
  });

  test("rejects extracted IDs that are not canonical YouTube video IDs", async () => {
    const prepared = await prepareYouTubeDownloadBatch("https://youtube.com/watch?v=short", {
      command: "yt-dlp",
      timeoutMs: 1000,
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ extractor_key: "Youtube", id: "short", title: "Bad", uploader: "Artist" }),
        stderr: "",
      }),
    });
    expect(prepared).toMatchObject({ kind: "rejected" });
  });

  test("preflights explicit playlists with title and total source count, preserving unavailable entries in source order", async () => {
    const prepared = await prepareYouTubeDownloadBatch("https://youtube.com/playlist?list=PL1", {
      command: "yt-dlp",
      timeoutMs: 1000,
      runner: async (request) => {
        expect(request.args).toContain("--flat-playlist");
        expect(request.args).toContain("--yes-playlist");
        expect(request.args).toContain("--ignore-errors");
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            _type: "playlist",
            title: "Road Trip",
            playlist_count: 5,
            entries: [
              { extractor: "youtube", id: "A0000000000", title: "Alpha", uploader: "Artist A" },
              null,
              { title: "Private video" },
              { extractor: "youtube", id: "B0000000000", title: "Beta", channel: "Artist B" },
            ],
          }),
        };
      },
    });

    expect(prepared).toMatchObject({
      kind: "confirmation-required",
      confirmation: { title: "Road Trip", itemCount: 5 },
    });
    expect(prepared.kind).toBe("confirmation-required");
    if (prepared.kind !== "confirmation-required") throw new Error("expected confirmation");
    expect(prepared.cancel()).toEqual({ kind: "cancelled" });
    expect(prepared.confirm()).toMatchObject({
        kind: "playlist",
        entries: [
          { kind: "track", metadata: { id: "A0000000000" } },
          { kind: "unavailable" },
          { kind: "unavailable", title: "Private video" },
          { kind: "track", metadata: { id: "B0000000000" } },
          { kind: "unavailable", message: "YouTube playlist entry was unavailable during preflight" },
        ],
    });
    await expect(executeYouTubeDownloadBatch({
      sourceUrl: "https://youtube.com/playlist?list=PL1",
      kind: "playlist",
      entries: [],
    }, {
      command: "yt-dlp",
      cache: { cacheDir: "/tmp/unused" },
      progressThrottleMs: 500,
    })).rejects.toThrow("must be created by preflight");
  });

  test("processes source order sequentially, skips healthy entries, repairs incomplete entries, and summarizes every outcome", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-download-batch-"));
    const started: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const batch = await makeBatch([
      track("Healthy0001", "Healthy track"),
      { kind: "unavailable", title: "Deleted video", message: "Playlist item is private, deleted, or unavailable" },
      track("Repair00001", "Repaired track"),
      track("Broken00001", "Broken track"),
      track("Fresh000001", "Fresh track"),
    ]);
    const runner: YouTubeDownloadProcessRunner = async (request) => {
      const id = videoIdFromArgs(request.args);
      started.push(id);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(1);
      if (id === "Broken00001") {
        concurrent -= 1;
        return { exitCode: 1, stdout: "", stderr: "ERROR: unavailable" };
      }
      const output = request.args[request.args.indexOf("--output") + 1]!;
      await writeFile(output.replace("%(ext)s", id === "Repair00001" ? "m4a" : "webm"), `audio-${id}`);
      concurrent -= 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await writeHealthy(dir, "Healthy0001", "webm");
      await writeFile(join(dir, "Repair00001.webm"), "old incomplete media");
      const summary = await executeYouTubeDownloadBatch(batch, {
        command: "yt-dlp", cache: { cacheDir: dir }, progressThrottleMs: 500, runner, now: () => 1000,
      });

      expect(started).toEqual(["Repair00001", "Broken00001", "Fresh000001"]);
      expect(maxConcurrent).toBe(1);
      expect(summary).toEqual({
        downloaded: 2,
        alreadyCached: 1,
        failed: 2,
        cancelled: 0,
        failures: [
          { index: 1, title: "Deleted video", message: "Playlist item is private, deleted, or unavailable" },
          { index: 3, title: "Broken track", message: "yt-dlp download failed: ERROR: unavailable" },
        ],
      });
      expect(await readFile(join(dir, "Repair00001.m4a"), "utf8")).toBe("audio-Repair00001");
      await expect(readFile(join(dir, "Repair00001.webm"), "utf8")).rejects.toThrow();
      expect(JSON.parse(await readFile(join(dir, "Repair00001.json"), "utf8"))).toEqual({
        videoId: "Repair00001", title: "Repaired track", uploader: "Uploader", cachedAt: new Date(1000).toISOString(),
        mediaFileName: "Repair00001.m4a", container: "m4a",
      });
      expect(await readdir(dir)).not.toContain(".partial-Broken00001");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("requires successful yt-dlp plus non-empty output without invoking a media validator", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-download-empty-"));
    let validatorCalled = false;
    try {
      const summary = await executeYouTubeDownloadBatch(await makeBatch([track("Empty000001", "Empty")]), {
        command: "yt-dlp",
        cache: { cacheDir: dir },
        progressThrottleMs: 500,
        runner: async (request) => {
          const output = request.args[request.args.indexOf("--output") + 1]!;
          await writeFile(output.replace("%(ext)s", "webm"), "");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        // The batch API deliberately exposes no ffprobe/media-validation dependency.
        ...(validatorCalled ? { impossible: true } : {}),
      });
      expect(validatorCalled).toBe(false);
      expect(summary).toMatchObject({ downloaded: 0, failed: 1 });
      await expect(readFile(join(dir, "Empty000001.json"), "utf8")).rejects.toThrow();
      await expect(readFile(join(dir, "Empty000001.webm"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("restores prior incomplete media when replacement metadata cannot commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-download-repair-rollback-"));
    const controller = new AbortController();
    try {
      await writeFile(join(dir, "Restore0001.opus"), "prior repairable media");
      await writeFile(join(dir, "Restore0001.json"), "{broken");
      const summary = await executeYouTubeDownloadBatch(await makeBatch([track("Restore0001", "Restore")]), {
        command: "yt-dlp",
        cache: { cacheDir: dir },
        progressThrottleMs: 500,
        signal: controller.signal,
        runner: async (request) => {
          const output = request.args[request.args.indexOf("--output") + 1]!;
          await writeFile(output.replace("%(ext)s", "opus"), "new media");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        now: () => {
          controller.abort();
          return 1000;
        },
      });
      expect(summary).toMatchObject({ downloaded: 0, cancelled: 1 });
      expect(await readFile(join(dir, "Restore0001.opus"), "utf8")).toBe("prior repairable media");
      expect(await readFile(join(dir, "Restore0001.json"), "utf8")).toBe("{broken");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cancellation cleans the interrupted item while preserving known unavailable failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-download-cancel-"));
    const controller = new AbortController();
    try {
      const summary = await executeYouTubeDownloadBatch(await makeBatch([
        track("One00000001", "One"),
        { kind: "unavailable", title: "Private", message: "unavailable" },
        track("Two00000002", "Two"),
      ]), {
        command: "yt-dlp", cache: { cacheDir: dir }, progressThrottleMs: 500, signal: controller.signal,
        runner: async (request) => {
          const output = request.args[request.args.indexOf("--output") + 1]!;
          await writeFile(output.replace("%(ext)s", "webm.part"), "partial");
          controller.abort();
          return { exitCode: null, stdout: "", stderr: "", cancelled: true };
        },
      });
      expect(summary).toEqual({
        downloaded: 0,
        alreadyCached: 0,
        failed: 1,
        cancelled: 2,
        failures: [{ index: 1, title: "Private", message: "Playlist item is private, deleted, or unavailable" }],
      });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function track(id: string, title: string): DownloadBatchEntry {
  return { kind: "track", url: `https://www.youtube.com/watch?v=${id}`, metadata: { extractor: "youtube", id, title, uploader: "Uploader" } };
}

async function makeBatch(entries: DownloadBatchEntry[]): Promise<YouTubeDownloadBatch> {
  const prepared = await prepareYouTubeDownloadBatch("https://youtube.com/playlist?list=PL1", {
    command: "yt-dlp",
    timeoutMs: 1000,
    runner: async () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        _type: "playlist",
        title: "Test playlist",
        playlist_count: entries.length,
        entries: entries.map((entry) => entry.kind === "track"
          ? { ...entry.metadata, extractor: "youtube" }
          : { title: entry.title }),
      }),
    }),
  });
  if (prepared.kind !== "confirmation-required") throw new Error("expected playlist confirmation");
  return prepared.confirm();
}

function videoIdFromArgs(args: string[]): string {
  return new URL(args.at(-1)!).searchParams.get("v")!;
}

async function writeHealthy(dir: string, id: string, extension: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.${extension}`), "healthy audio");
  await writeFile(join(dir, `${id}.json`), JSON.stringify({
    videoId: id, title: `${id} track`, uploader: "Uploader", cachedAt: new Date(0).toISOString(),
    mediaFileName: `${id}.${extension}`, container: extension,
  }));
}
