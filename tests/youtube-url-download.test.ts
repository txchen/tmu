import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFfprobeYouTubeMediaValidator,
  downloadYouTubeUrl,
  identifyYouTubeUrl,
  nodeYouTubeDownloadProcessRunner,
  parseYtDlpDownloadProgressLine,
  validateYouTubeUrlDownloadInput,
  type DependencyCommandRunner,
  type DependencyCommandRequest,
  type YouTubeDownloadProcessRequest,
  type YouTubeDownloadProcessRunner,
} from "../src/index";

describe("YouTube URL Download adapter", () => {
  test("accepts direct YouTube and YouTube Music URL forms", () => {
    const accepted = [
      "https://www.youtube.com/watch?v=abc123XYZ_0",
      "https://youtube.com/watch?v=abc123XYZ_0&t=42",
      "https://m.youtube.com/watch?v=abc123XYZ_0",
      "https://music.youtube.com/watch?v=abc123XYZ_0",
      "https://youtu.be/abc123XYZ_0",
      "https://www.youtube.com/shorts/abc123XYZ_0",
      "https://www.youtube.com/embed/abc123XYZ_0",
    ];

    expect(accepted.map((input) => validateYouTubeUrlDownloadInput(input).ok)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  test("rejects out-of-scope YouTube URL Download inputs with clear messages", () => {
    const rejected = [
      ["never gonna give you up", "direct YouTube or YouTube Music URL"],
      ["ytsearch1:never gonna give you up", "ytsearch inputs"],
      ["https://www.youtube.com/results?search_query=ambient", "search URLs"],
      ["https://www.youtube.com/playlist?list=PL123", "playlist URLs"],
      ["https://www.youtube.com/watch?v=abc123XYZ_0&list=PL123", "playlist URLs"],
      ["https://www.youtube.com/@some-channel", "channel URLs"],
      ["https://music.youtube.com/library", "account/library URLs"],
      ["https://www.youtube.com/live/abc123XYZ_0", "live streams"],
      ["https://example.com/watch?v=abc123XYZ_0", "non-YouTube sites"],
    ];

    for (const [input, message] of rejected) {
      const result = validateYouTubeUrlDownloadInput(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain(message);
    }
  });

  test("identifies metadata with a finite timeout and lowercased extractor/id identity", async () => {
    let request: DependencyCommandRequest | undefined;
    const runner: DependencyCommandRunner = async (nextRequest) => {
      request = nextRequest;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          extractor_key: "YouTube",
          id: "AbC123",
          title: "Identified Track",
          uploader: "Cache Artist",
          duration: 181.7,
        }),
        stderr: "",
      };
    };

    const result = await identifyYouTubeUrl("https://music.youtube.com/watch?v=AbC123", {
      command: "/opt/bin/yt-dlp",
      timeoutMs: 3456,
      cookiesFromBrowser: "firefox",
      runner,
    });

    expect(result).toEqual({
      ok: true,
      identity: {
        providerId: "offline-youtube-cache",
        stableId: "youtube:AbC123",
      },
      metadata: {
        extractor: "youtube",
        id: "AbC123",
        title: "Identified Track",
        artist: "Cache Artist",
        durationSeconds: 181.7,
      },
    });
    expect(request).toMatchObject({
      helper: "yt-dlp",
      command: "/opt/bin/yt-dlp",
      timeoutMs: 3456,
    });
    expect(request?.args).toEqual([
      "--dump-single-json",
      "--skip-download",
      "--no-playlist",
      "--cookies-from-browser",
      "firefox",
      "--",
      "https://music.youtube.com/watch?v=AbC123",
    ]);
  });

  test("surfaces explanatory yt-dlp stderr for restricted or unavailable media", async () => {
    const runner: DependencyCommandRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "ERROR: [youtube] AbC123: Video unavailable. This video is restricted in your region.",
    });

    const result = await identifyYouTubeUrl("https://www.youtube.com/watch?v=AbC123", {
      command: "yt-dlp",
      timeoutMs: 2000,
      runner,
    });

    expect(result).toEqual({
      ok: false,
      message: "yt-dlp identify failed: ERROR: [youtube] AbC123: Video unavailable. This video is restricted in your region.",
    });
  });

  test("reports identify timeouts and rejects live metadata before cache lookup", async () => {
    const timedOutRunner: DependencyCommandRunner = async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      errorMessage: "Command timed out after 25ms",
    });
    const timedOut = await identifyYouTubeUrl("https://www.youtube.com/watch?v=AbC123", {
      command: "yt-dlp",
      timeoutMs: 25,
      runner: timedOutRunner,
    });
    expect(timedOut).toEqual({
      ok: false,
      message: "yt-dlp identify timed out: Command timed out after 25ms",
    });

    const liveRunner: DependencyCommandRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        extractor_key: "YouTube",
        id: "Live123",
        title: "Live Now",
        is_live: true,
      }),
      stderr: "",
    });
    const live = await identifyYouTubeUrl("https://www.youtube.com/watch?v=Live123", {
      command: "yt-dlp",
      timeoutMs: 2000,
      runner: liveRunner,
    });
    expect(live).toEqual({
      ok: false,
      message: "YouTube URL Download rejects live streams",
    });
  });

  test("validates downloaded media with ffprobe before cache metadata can be written", async () => {
    const requests: DependencyCommandRequest[] = [];
    const validator = createFfprobeYouTubeMediaValidator({
      command: "/opt/bin/ffprobe",
      timeoutMs: 1234,
      runner: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stdout: JSON.stringify({ streams: [{ codec_type: "audio" }] }),
          stderr: "",
        };
      },
    });

      await expect(validator("/tmp/downloaded.webm")).resolves.toEqual({ ok: true });
    expect(requests).toEqual([{
      helper: "ffprobe",
      command: "/opt/bin/ffprobe",
      args: [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "json",
        "/tmp/downloaded.webm",
      ],
      timeoutMs: 1234,
    }]);

    const failed = await createFfprobeYouTubeMediaValidator({
      command: "ffprobe",
      timeoutMs: 2000,
      runner: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ streams: [{ codec_type: "video" }] }),
        stderr: "",
      }),
    })("/tmp/not-audio.webm");
    expect(failed).toEqual({
      ok: false,
      message: "Downloaded media validation failed: no audio stream found",
    });
  });

  test("downloads cache misses with stable yt-dlp command shape and writes normalized metadata after validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-download-"));
    let request: YouTubeDownloadProcessRequest | undefined;
    const runner: YouTubeDownloadProcessRunner = async (nextRequest) => {
      request = nextRequest;
      await expect(readFile(join(dir, "youtube", "AbC123", "download-archive.txt"), "utf8")).rejects.toThrow();
      await mkdir(join(dir, "youtube", "AbC123", "media"), { recursive: true });
      await writeFile(join(dir, "youtube", "AbC123", "media", "youtube-AbC123.webm"), "audio bytes");
      nextRequest.onLine("[download]  42.5% of 4.00MiB at 1.00MiB/s ETA 00:02");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const validated: string[] = [];

    try {
      await mkdir(join(dir, "youtube", "AbC123"), { recursive: true });
      await writeFile(join(dir, "youtube", "AbC123", "download-archive.txt"), "youtube AbC123\n");
      const result = await downloadYouTubeUrl({
        url: "https://www.youtube.com/watch?v=AbC123",
        command: "/opt/bin/yt-dlp",
        cache: {
          cacheDir: dir,
          mediaDirName: "media",
          metadataFileName: "metadata.json",
        },
        metadata: {
          extractor: "youtube",
          id: "AbC123",
          title: "Downloaded Track",
          artist: "Prompt Artist",
          durationSeconds: 188,
        },
        cookiesFromBrowser: "firefox:Profile With Spaces",
        progressThrottleMs: 500,
        now: () => 1000,
        runner,
        validateMedia: async (path) => {
          validated.push(path);
          return { ok: true };
        },
      });

      expect(result).toMatchObject({
        ok: true,
        mediaPath: join(dir, "youtube", "AbC123", "media", "youtube-AbC123.webm"),
        metadataPath: join(dir, "youtube", "AbC123", "metadata.json"),
        sourceMetadataPath: join(dir, "youtube", "AbC123", "source.json"),
      });
      expect(request).toMatchObject({
        helper: "yt-dlp",
        command: "/opt/bin/yt-dlp",
        graceKillMs: 1500,
      });
      expect(request?.args).toEqual([
        "--no-playlist",
        "--format",
        "bestaudio/best",
        "--continue",
        "--part",
        "--newline",
        "--progress",
        "--download-archive",
        join(dir, "youtube", "AbC123", "download-archive.txt"),
        "--output",
        join(dir, "youtube", "AbC123", "media", "youtube-AbC123.%(ext)s"),
        "--cookies-from-browser",
        "firefox:Profile With Spaces",
        "--",
        "https://www.youtube.com/watch?v=AbC123",
      ]);
      expect(validated).toEqual([join(dir, "youtube", "AbC123", "media", "youtube-AbC123.webm")]);
      expect(JSON.parse(await readFile(join(dir, "youtube", "AbC123", "metadata.json"), "utf8"))).toEqual({
        version: 1,
        extractor: "youtube",
        id: "AbC123",
        title: "Downloaded Track",
        mediaFileName: "youtube-AbC123.webm",
        artist: "Prompt Artist",
        durationSeconds: 188,
      });
      expect(JSON.parse(await readFile(join(dir, "youtube", "AbC123", "source.json"), "utf8"))).toEqual({
        version: 1,
        url: "https://www.youtube.com/watch?v=AbC123",
        extractor: "youtube",
        id: "AbC123",
        title: "Downloaded Track",
        artist: "Prompt Artist",
        durationSeconds: 188,
      });
      const entryFiles = await readdir(join(dir, "youtube", "AbC123"));
      expect(entryFiles.filter((file) => file.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps the download archive when existing media can satisfy the cache entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-download-archive-"));
    let archiveDuringRun = "";
    const runner: YouTubeDownloadProcessRunner = async () => {
      archiveDuringRun = await readFile(join(dir, "youtube", "Archived123", "download-archive.txt"), "utf8");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await mkdir(join(dir, "youtube", "Archived123", "media"), { recursive: true });
      await writeFile(join(dir, "youtube", "Archived123", "download-archive.txt"), "youtube Archived123\n");
      await writeFile(join(dir, "youtube", "Archived123", "media", "youtube-Archived123.webm"), "audio bytes");

      const result = await downloadYouTubeUrl({
        url: "https://www.youtube.com/watch?v=Archived123",
        command: "yt-dlp",
        cache: {
          cacheDir: dir,
          mediaDirName: "media",
          metadataFileName: "metadata.json",
        },
        metadata: {
          extractor: "youtube",
          id: "Archived123",
          title: "Archived Track",
        },
        progressThrottleMs: 500,
        runner,
        validateMedia: async () => ({ ok: true }),
      });

      expect(archiveDuringRun).toBe("youtube Archived123\n");
      expect(result).toMatchObject({
        ok: true,
        mediaPath: join(dir, "youtube", "Archived123", "media", "youtube-Archived123.webm"),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("parses and throttles line-oriented yt-dlp progress for display", async () => {
    expect(parseYtDlpDownloadProgressLine("[download]   7.4% of 3.00MiB at 800.00KiB/s ETA 00:08"))
      .toBe("download 7.4% at 800.00KiB/s ETA 00:08");
    expect(parseYtDlpDownloadProgressLine("[download] Destination: /tmp/cache/youtube-AbC123.webm"))
      .toBe("download destination: youtube-AbC123.webm");
    expect(parseYtDlpDownloadProgressLine("plain warning")).toBeUndefined();

    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-progress-"));
    const progress: string[] = [];
    const times = [0, 100, 200, 600];
    const runner: YouTubeDownloadProcessRunner = async (request) => {
      await mkdir(join(dir, "youtube", "AbC123", "media"), { recursive: true });
      await writeFile(join(dir, "youtube", "AbC123", "media", "youtube-AbC123.webm"), "audio bytes");
      request.onLine("[download]   1.0% of 3.00MiB at 100.00KiB/s ETA 00:30");
      request.onLine("[download]   2.0% of 3.00MiB at 200.00KiB/s ETA 00:20");
      request.onLine("[download]   3.0% of 3.00MiB at 300.00KiB/s ETA 00:10");
      request.onLine("[download]   4.0% of 3.00MiB at 400.00KiB/s ETA 00:05");
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    try {
      await downloadYouTubeUrl({
        url: "https://www.youtube.com/watch?v=AbC123",
        command: "yt-dlp",
        cache: { cacheDir: dir, mediaDirName: "media", metadataFileName: "metadata.json" },
        metadata: { extractor: "youtube", id: "AbC123", title: "Progress Track" },
        progressThrottleMs: 500,
        now: () => times.shift() ?? 600,
        runner,
        validateMedia: async () => ({ ok: true }),
        onProgress: (line) => progress.push(line),
      });

      expect(progress).toEqual([
        "download 1.0% at 100.00KiB/s ETA 00:30",
        "download 4.0% at 400.00KiB/s ETA 00:05",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("surfaces download stderr and does not write metadata when media validation fails", async () => {
    const failedDir = await mkdtemp(join(tmpdir(), "tmu-youtube-failed-"));
    const validationDir = await mkdtemp(join(tmpdir(), "tmu-youtube-validation-"));

    try {
      const failed = await downloadYouTubeUrl({
        url: "https://www.youtube.com/watch?v=Restricted",
        command: "yt-dlp",
        cache: { cacheDir: failedDir, mediaDirName: "media", metadataFileName: "metadata.json" },
        metadata: { extractor: "youtube", id: "Restricted", title: "Restricted Track" },
        progressThrottleMs: 500,
        validateMedia: async () => ({ ok: true }),
        runner: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "ERROR: [youtube] Restricted: This video is DRM protected.",
        }),
      });
      expect(failed).toEqual({
        ok: false,
        message: "yt-dlp download failed: ERROR: [youtube] Restricted: This video is DRM protected.",
      });

      const invalid = await downloadYouTubeUrl({
        url: "https://www.youtube.com/watch?v=Invalid",
        command: "yt-dlp",
        cache: { cacheDir: validationDir, mediaDirName: "media", metadataFileName: "metadata.json" },
        metadata: { extractor: "youtube", id: "Invalid", title: "Invalid Media" },
        progressThrottleMs: 500,
        runner: async () => {
          await mkdir(join(validationDir, "youtube", "Invalid", "media"), { recursive: true });
          await writeFile(join(validationDir, "youtube", "Invalid", "media", "youtube-Invalid.webm"), "audio bytes");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        validateMedia: async () => ({ ok: false, message: "Downloaded media is not playable audio" }),
      });

      expect(invalid).toEqual({
        ok: false,
        message: "Downloaded media is not playable audio",
      });
      await expect(readFile(join(validationDir, "youtube", "Invalid", "metadata.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(failedDir, { recursive: true, force: true });
      await rm(validationDir, { recursive: true, force: true });
    }
  });

  test("preserves existing cache metadata when an atomic metadata write fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-atomic-"));
    const fixedNow = 1234567890;
    const originalDateNow = Date.now;
    const metadataPath = join(dir, "youtube", "Atomic", "metadata.json");
    const oldMetadata = {
      version: 1,
      extractor: "youtube",
      id: "Atomic",
      title: "Existing Title",
      mediaFileName: "youtube-Atomic.webm",
    };

    try {
      await mkdir(join(dir, "youtube", "Atomic", "media"), { recursive: true });
      await writeFile(metadataPath, `${JSON.stringify(oldMetadata, null, 2)}\n`, "utf8");
      await mkdir(`${metadataPath}.${process.pid}.${fixedNow}.tmp`);
      Date.now = () => fixedNow;

      await expect(downloadYouTubeUrl({
        url: "https://www.youtube.com/watch?v=Atomic",
        command: "yt-dlp",
        cache: { cacheDir: dir, mediaDirName: "media", metadataFileName: "metadata.json" },
        metadata: { extractor: "youtube", id: "Atomic", title: "New Title" },
        progressThrottleMs: 500,
        runner: async () => {
          await writeFile(join(dir, "youtube", "Atomic", "media", "youtube-Atomic.webm"), "audio bytes");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        validateMedia: async () => ({ ok: true }),
      })).rejects.toThrow();

      expect(JSON.parse(await readFile(metadataPath, "utf8"))).toEqual(oldMetadata);
    } finally {
      Date.now = originalDateNow;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes cancellation signals to the download process runner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-cancel-"));
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;

    try {
      const resultPromise = downloadYouTubeUrl({
        url: "https://www.youtube.com/watch?v=CancelMe",
        command: "yt-dlp",
        cache: { cacheDir: dir, mediaDirName: "media", metadataFileName: "metadata.json" },
        metadata: { extractor: "youtube", id: "CancelMe", title: "Cancel Track" },
        progressThrottleMs: 500,
        signal: controller.signal,
        validateMedia: async () => ({ ok: true }),
        runner: async (request) => {
          observedSignal = request.signal;
          await writeFile(join(dir, "youtube", "CancelMe", "media", "youtube-CancelMe.webm.part"), "partial");
          controller.abort();
          return { exitCode: null, stdout: "", stderr: "", cancelled: true };
        },
      });

      await expect(resultPromise).resolves.toEqual({
        ok: false,
        message: "YouTube download cancelled; partial files cleaned up",
        cancelled: true,
        cleanup: "complete",
      });
      expect(observedSignal).toBe(controller.signal);
      await expect(readFile(join(dir, "youtube", "CancelMe", "media", "youtube-CancelMe.webm.part"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("honors cancellation after yt-dlp exits before cache metadata is written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-late-cancel-"));
    const controller = new AbortController();
    let validatedPath = "";

    try {
      const result = await downloadYouTubeUrl({
        url: "https://www.youtube.com/watch?v=LateCancel",
        command: "yt-dlp",
        cache: { cacheDir: dir, mediaDirName: "media", metadataFileName: "metadata.json" },
        metadata: { extractor: "youtube", id: "LateCancel", title: "Late Cancel Track" },
        progressThrottleMs: 500,
        signal: controller.signal,
        runner: async () => {
          await mkdir(join(dir, "youtube", "LateCancel", "media"), { recursive: true });
          await writeFile(join(dir, "youtube", "LateCancel", "media", "youtube-LateCancel.webm"), "audio bytes");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        validateMedia: async (path) => {
          validatedPath = path;
          controller.abort();
          return { ok: true };
        },
      });

      expect(result).toEqual({
        ok: false,
        message: "YouTube download cancelled; partial files cleaned up",
        cancelled: true,
        cleanup: "complete",
      });
      expect(validatedPath).toBe(join(dir, "youtube", "LateCancel", "media", "youtube-LateCancel.webm"));
      await expect(readFile(join(dir, "youtube", "LateCancel", "metadata.json"), "utf8")).rejects.toThrow();
      await expect(readFile(join(dir, "youtube", "LateCancel", "source.json"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("honors cancellation at the final cache metadata write boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-youtube-final-cancel-"));
    const controller = new AbortController();
    const originalDateNow = Date.now;
    let dateCalls = 0;

    try {
      Date.now = () => {
        dateCalls += 1;
        if (dateCalls === 2) controller.abort();
        return 9000 + dateCalls;
      };

      const result = await downloadYouTubeUrl({
        url: "https://www.youtube.com/watch?v=FinalCancel",
        command: "yt-dlp",
        cache: { cacheDir: dir, mediaDirName: "media", metadataFileName: "metadata.json" },
        metadata: { extractor: "youtube", id: "FinalCancel", title: "Final Cancel Track" },
        progressThrottleMs: 500,
        signal: controller.signal,
        runner: async () => {
          await mkdir(join(dir, "youtube", "FinalCancel", "media"), { recursive: true });
          await writeFile(join(dir, "youtube", "FinalCancel", "media", "youtube-FinalCancel.webm"), "audio bytes");
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        validateMedia: async () => ({ ok: true }),
      });

      expect(result).toEqual({
        ok: false,
        message: "YouTube download cancelled; partial files cleaned up",
        cancelled: true,
        cleanup: "complete",
      });
      await expect(readFile(join(dir, "youtube", "FinalCancel", "source.json"), "utf8")).rejects.toThrow();
      await expect(readFile(join(dir, "youtube", "FinalCancel", "metadata.json"), "utf8")).rejects.toThrow();
    } finally {
      Date.now = originalDateNow;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("default download process runner terminates and force-kills cancelled children after grace", async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    const resultPromise = nodeYouTubeDownloadProcessRunner({
      helper: "yt-dlp",
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write('ready\\n'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      graceKillMs: 20,
      signal: controller.signal,
      onLine: (line) => lines.push(line),
    });

    await waitFor(() => {
      expect(lines).toContain("ready");
    });
    controller.abort();

    const result = await resultPromise;

    expect(result.cancelled).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.exitCode).toBeNull();
  });
});

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
