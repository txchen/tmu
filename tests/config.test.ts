import { describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDefaultTmuConfig, loadTmuConfig } from "../src/config";

describe("TMU Config", () => {
  test("contains YouTube settings without Provider selection or removed source config", () => {
    const config = createDefaultTmuConfig();
    expect(config).not.toHaveProperty("youtubeCache");
    expect(config).not.toHaveProperty("providers");
    expect(config).not.toHaveProperty("offlineYouTubeCache");
  });

  test("merges supported settings from a config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-config-"));
    const path = join(dir, "config.json");
    try {
      await writeFile(path, JSON.stringify({
        helpers: { ytDlp: "custom-yt-dlp" },
        youtube: { maxConcurrentDownloads: 1, cookiesFromBrowser: "firefox" },
        lowPower: { playbackProgressMs: 5000 },
      }));
      const loaded = await loadTmuConfig({ path });
      expect(loaded.config.helpers.ytDlp).toBe("custom-yt-dlp");
      expect(loaded.config.youtube.cookiesFromBrowser).toBe("firefox");
      expect(loaded.config.lowPower.playbackProgressMs).toBe(5000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
