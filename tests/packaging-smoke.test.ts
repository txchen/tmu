import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  LINUX_X64_ARTIFACT,
  LINUX_X64_BUILD_ARGS,
  LINUX_X64_SMOKE_SCRIPT,
  assertLinuxX64SmokeOutput,
  parseRuntimeArgs,
} from "../src/index";

describe("Linux x64 packaging smoke contract", () => {
  test("parses snapshot target arguments without treating them as CLI file seeds", () => {
    expect(parseRuntimeArgs([
      "--snapshot",
      "--snapshot-target",
      "youtube-url-download",
      "/music/seed.flac",
    ])).toEqual({
      snapshot: true,
      snapshotTargetId: "youtube-url-download",
      cliFileArgs: ["/music/seed.flac"],
    });

    expect(parseRuntimeArgs(["--snapshot-target=offline-youtube-cache"])).toEqual({
      snapshot: false,
      snapshotTargetId: "offline-youtube-cache",
      cliFileArgs: [],
    });
  });

  test("documents the Linux x64 Bun compile target used by the smoke build", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(LINUX_X64_ARTIFACT).toBe("dist/tmu-linux-x64");
    expect(LINUX_X64_BUILD_ARGS).toEqual([
      "build",
      "--compile",
      "--target=bun-linux-x64-baseline",
      "--outfile=dist/tmu-linux-x64",
      "src/main.ts",
    ]);
    expect(pkg.scripts?.["build:linux-x64"]).toBe(`bun ${LINUX_X64_BUILD_ARGS.join(" ")}`);
    expect(pkg.scripts?.["smoke:linux-x64"]).toBe(LINUX_X64_SMOKE_SCRIPT);
  });

  test("validates representative packaged snapshot output", () => {
    expect(() => assertLinuxX64SmokeOutput({
      startup: [
        "TMU",
        "Local",
        "Queue / Player Strip",
        "Dependency Health",
        "mpv: present at /tmp/tmu-smoke/mpv (0.41.0-smoke)",
        "ffprobe: present at /tmp/tmu-smoke/ffprobe (8.1-smoke)",
        "yt-dlp: present at /tmp/tmu-smoke/yt-dlp (2026.01.02-smoke)",
      ].join("\n"),
      localSeed: [
        "Expanded Queue",
        "1. seed.mp3 - Local - queued",
      ].join("\n"),
      navidrome: [
        "Navidrome",
        "Navidrome: connected to http://127.0.0.1:12345; Library Browser ready",
        "Smoke Artist",
      ].join("\n"),
      offlineCache: [
        "Offline YouTube Cache",
        "Cached Smoke Track  Offline YouTube Cache",
      ].join("\n"),
      missingYtDlp: [
        "YouTube URL Download",
        "yt-dlp: missing at /missing/yt-dlp - YouTube URL Download disabled",
        "! YouTube URL Download disabled: yt-dlp missing at /missing/yt-dlp",
      ].join("\n"),
    })).not.toThrow();
  });
});
