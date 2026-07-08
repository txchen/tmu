import { describe, expect, test } from "bun:test";
import {
  identifyYouTubeUrl,
  validateYouTubeUrlDownloadInput,
  type DependencyCommandRunner,
  type DependencyCommandRequest,
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
});
