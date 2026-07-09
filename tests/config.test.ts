import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDefaultTmuConfig,
  loadTmuConfig,
  redactTmuConfig,
} from "../src/index";

describe("TMU config", () => {
  test("loads defaults when the config file does not exist", async () => {
    const loaded = await loadTmuConfig({
      path: join(tmpdir(), "tmu-missing-config-test", "config.json"),
    });

    expect(loaded.source).toBe("defaults");
    expect(loaded.config.helpers).toEqual({
      mpv: "mpv",
      ffprobe: "ffprobe",
      ytDlp: "yt-dlp",
    });
    expect(loaded.config.providers.navidrome).toMatchObject({
      enabled: false,
      serverUrl: "",
      username: "",
      apiVersion: "1.16.1",
      clientName: "tmu",
      scrobble: true,
    });
    expect(loaded.config.providers.local.directorySoftCap).toBe(10000);
    expect(loaded.config.offlineYouTubeCache.cacheDir).toContain("offline-youtube-cache");
    expect(loaded.config.persistence.lastQueueSnapshotPath).toContain("last-queue.json");
    expect(loaded.config.persistence.appPreferencesPath).toContain("preferences.json");
    expect(loaded.config.lowPower).toEqual({
      playbackTickMs: 1000,
      downloadProgressThrottleMs: 1000,
      providerProgressThrottleMs: 1000,
    });
  });

  test("merges an MVP config file over defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-config-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      helpers: {
        mpv: "/opt/bin/mpv",
        ytDlp: "/opt/bin/yt-dlp",
      },
      providers: {
        local: {
          directorySoftCap: 25,
        },
        navidrome: {
          enabled: true,
          serverUrl: "https://music.example.test",
          username: "alex",
          token: "nav-token",
          salt: "nav-salt",
          password: "nav-password",
          scrobble: false,
        },
        youtubeUrlDownload: {
          enabled: false,
        },
      },
      lowPower: {
        playbackTickMs: 1000,
      },
      offlineYouTubeCache: {
        cacheDir: "/var/cache/tmu/youtube",
        metadataFileName: "entry.json",
      },
      youtube: {
        cookiesFromBrowser: "firefox",
        maxConcurrentDownloads: 1,
      },
      persistence: {
        lastQueueSnapshotPath: "/var/lib/tmu/last-queue.json",
        appPreferencesPath: "/var/lib/tmu/preferences.json",
      },
    }));

    const loaded = await loadTmuConfig({ path });

    expect(loaded.source).toBe("file");
    expect(loaded.config.helpers).toEqual({
      mpv: "/opt/bin/mpv",
      ffprobe: "ffprobe",
      ytDlp: "/opt/bin/yt-dlp",
    });
    expect(loaded.config.providers.navidrome).toMatchObject({
      enabled: true,
      serverUrl: "https://music.example.test",
      username: "alex",
      token: "nav-token",
      salt: "nav-salt",
      password: "nav-password",
      scrobble: false,
    });
    expect(loaded.config.providers.local.directorySoftCap).toBe(25);
    expect(loaded.config.providers.youtubeUrlDownload.enabled).toBe(false);
    expect(loaded.config.lowPower.playbackTickMs).toBe(1000);
    expect(loaded.config.lowPower.downloadProgressThrottleMs).toBe(1000);
    expect(loaded.config.offlineYouTubeCache.cacheDir).toBe("/var/cache/tmu/youtube");
    expect(loaded.config.offlineYouTubeCache.metadataFileName).toBe("entry.json");
    expect(loaded.config.youtube.cookiesFromBrowser).toBe("firefox");
    expect(loaded.config.persistence.lastQueueSnapshotPath).toBe("/var/lib/tmu/last-queue.json");
    expect(loaded.config.persistence.appPreferencesPath).toBe("/var/lib/tmu/preferences.json");
  });

  test("redacts secret fields from display and diagnostics copies", () => {
    const config = createDefaultTmuConfig({
      providers: {
        navidrome: {
          enabled: true,
          password: "secret-password",
          token: "secret-token",
          salt: "secret-salt",
        },
      },
    });

    const redacted = redactTmuConfig(config);
    const asText = JSON.stringify(redacted);

    expect(redacted.providers.navidrome.password).toBe("[redacted]");
    expect(redacted.providers.navidrome.token).toBe("[redacted]");
    expect(redacted.providers.navidrome.salt).toBe("[redacted]");
    expect(asText).not.toContain("secret-password");
    expect(asText).not.toContain("secret-token");
    expect(asText).not.toContain("secret-salt");
  });
});
