import { describe, expect, test } from "vitest";
import {
  checkDependencyHealth,
  checkHelperDependencyHealth,
  createDefaultTmuConfig,
  createDefaultDependencyHealth,
  nodeDependencyCommandRunner,
  type DependencyCommandRunner,
} from "../src/index";

describe("dependency health", () => {
  test("checks configured helper command paths and detects versions", async () => {
    const config = createDefaultTmuConfig({
      helpers: {
        mpv: "/opt/bin/mpv",
        ytDlp: "/opt/bin/yt-dlp",
      },
    });
    const runner: DependencyCommandRunner = async ({ command }) => {
      if (command === "/opt/bin/mpv") return { exitCode: 0, stdout: "mpv 0.39.0\n", stderr: "" };
      if (command === "/opt/bin/yt-dlp") return { exitCode: 0, stdout: "2026.01.02\n", stderr: "" };
      return { exitCode: 127, stdout: "", stderr: "not found" };
    };

    const health = await checkDependencyHealth(config, { runner });

    expect(health.helpers.mpv).toMatchObject({
      command: "/opt/bin/mpv",
      status: "present",
      version: "0.39.0",
    });
    expect(health.helpers["yt-dlp"]).toMatchObject({
      command: "/opt/bin/yt-dlp",
      status: "present",
      version: "2026.01.02",
    });
    expect(health.playback.enabled).toBe(true);
    expect(health.youtubeUrlDownload.enabled).toBe(true);
  });

  test("reports source-gated missing helpers without host dependencies", async () => {
    const config = createDefaultTmuConfig({
      helpers: {
        mpv: "/missing/mpv",
        ytDlp: "/missing/yt-dlp",
      },
    });
    const runner: DependencyCommandRunner = async ({ command }) => ({
      exitCode: 127,
      stdout: "",
      stderr: `${command}: not found`,
      errorMessage: "not found",
    });

    const health = await checkDependencyHealth(config, { runner });

    expect(health.helpers.mpv).toMatchObject({
      command: "/missing/mpv",
      status: "missing",
    });
    expect(health.playback).toEqual({
      enabled: false,
      message: "mpv is not installed or cannot be found at /missing/mpv. Install mpv and ensure the configured command is available on PATH.",
    });
    expect(health.youtubeUrlDownload).toEqual({
      enabled: false,
      message: "yt-dlp is not installed or cannot be found at /missing/yt-dlp. Install yt-dlp and ensure the configured command is available on PATH.",
    });
  });

  test.each([
    { missing: "mpv", playbackEnabled: false, downloadEnabled: true },
    { missing: "yt-dlp", playbackEnabled: true, downloadEnabled: false },
  ] as const)("a missing $missing disables only its corresponding feature", async ({
    missing, playbackEnabled, downloadEnabled,
  }) => {
    const config = createDefaultTmuConfig();
    const runner: DependencyCommandRunner = async ({ helper, command }) => helper === missing
      ? { exitCode: 127, stdout: "", stderr: `${command}: not found`, errorMessage: "not found" }
      : { exitCode: 0, stdout: `${helper} 1.0.0\n`, stderr: "" };

    const health = await checkDependencyHealth(config, { runner });

    expect(health.playback.enabled).toBe(playbackEnabled);
    expect(health.youtubeUrlDownload.enabled).toBe(downloadEnabled);
  });

  test("can recheck only yt-dlp for the YouTube URL Download source", async () => {
    const config = createDefaultTmuConfig({
      helpers: {
        ytDlp: "/opt/bin/yt-dlp",
      },
    });
    const requestedHelpers: string[] = [];
    const runner: DependencyCommandRunner = async ({ helper, command }) => {
      requestedHelpers.push(helper);
      return { exitCode: 0, stdout: `${command} 2026.01.02\n`, stderr: "" };
    };

    const health = await checkHelperDependencyHealth(
      config,
      "yt-dlp",
      createDefaultDependencyHealth({
        helpers: {
          "yt-dlp": { name: "yt-dlp", command: "/old/yt-dlp", status: "missing" },
        },
        youtubeUrlDownload: {
          enabled: false,
          message: "yt-dlp is not installed or cannot be found at /old/yt-dlp. Install yt-dlp and ensure the configured command is available on PATH.",
        },
      }),
      { runner },
    );

    expect(requestedHelpers).toEqual(["yt-dlp"]);
    expect(health.helpers["yt-dlp"]).toMatchObject({
      command: "/opt/bin/yt-dlp",
      status: "present",
      version: "/opt/bin/yt-dlp 2026.01.02",
    });
    expect(health.playback.enabled).toBe(true);
    expect(health.youtubeUrlDownload.enabled).toBe(true);
  });

  test("reports execFile timeouts with an explicit timeout message", async () => {
    const result = await nodeDependencyCommandRunner({
      helper: "yt-dlp",
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 1000)"],
      timeoutMs: 10,
    });

    expect(result).toMatchObject({
      exitCode: null,
      errorMessage: "Command timed out after 10ms",
    });
  });
});
