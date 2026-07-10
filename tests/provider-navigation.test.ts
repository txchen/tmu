import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultTmuConfig } from "../src/config";
import { createNavidromeProvider } from "../src/navidrome";
import { createOfflineYouTubeCacheProvider, writeOfflineYouTubeCacheMetadata } from "../src/offline-youtube-cache";
import { overlayGeometry, providerNavigationRows } from "../src/provider-navigation";
import { createLocalProvider } from "../src/providers";
import { createInitialAppState } from "../src/state";

describe("Provider navigation", () => {
  test("uses capped wide geometry, medium insets, and narrow usable-screen fill", () => {
    expect(overlayGeometry("music-picker", "wide", 200, 50)).toEqual({ width: 112, height: 32 });
    expect(overlayGeometry("shortcut-help", "wide", 120, 40)).toEqual({ width: 88, height: 28 });
    expect(overlayGeometry("music-picker", "medium", 100, 24)).toEqual({ width: 96, height: 22 });
    expect(overlayGeometry("music-picker", "narrow", 70, 24)).toEqual({ width: 70, height: 22 });
  });

  test("starts at a source-neutral root and omits unconfigured Navidrome", () => {
    const config = createDefaultTmuConfig();
    const appState = createInitialAppState({
      local: createLocalProvider(),
      navidrome: createNavidromeProvider({ config: config.providers.navidrome }),
      "offline-youtube-cache": createOfflineYouTubeCacheProvider(config.offlineYouTubeCache),
    });

    expect(providerNavigationRows(appState, { providerId: null, path: [] }).map((row) => row.label)).toEqual([
      "Local",
      "Offline YouTube Cache",
    ]);
    expect(appState.providers.local?.capabilities).toEqual({
      searchableResultTypes: ["track"],
      browsableHierarchy: ["local-directory", "track"],
      operations: [],
    });
    expect(appState.providers["offline-youtube-cache"]?.capabilities).toEqual({
      searchableResultTypes: ["track"],
      browsableHierarchy: ["track"],
      operations: ["refresh"],
    });
  });

  test("shows configured Navidrome disabled, offline, and authentication recovery states", () => {
    for (const [state, expected] of [
      [{ status: "missing-config", message: "set enabled", missingFields: ["enabled"] }, "Disabled · Enable in TMU Config"],
      [{ status: "api-failure", message: "connection refused" }, "Offline · Retry"],
      [{ status: "auth-failure", message: "wrong password" }, "Authentication failed · Check credentials and retry"],
    ] as const) {
      const config = createDefaultTmuConfig({ providers: { navidrome: { serverUrl: "https://music.example.test" } } });
      const navidrome = createNavidromeProvider({ config: config.providers.navidrome });
      Object.assign(navidrome, { getConnectionState: () => state });
      const appState = createInitialAppState({ navidrome }, { config });

      expect(providerNavigationRows(appState, { providerId: null, path: [] })).toContainEqual(
        expect.objectContaining({ label: "Navidrome", detail: expected }),
      );
    }
  });

  test("Local exposes one directory level and playable Tracks without making directories queueable", async () => {
    const root = `/tmp/tmu-provider-navigation-${process.pid}-${crypto.randomUUID()}`;
    await mkdir(join(root, "Album"), { recursive: true });
    await writeFile(join(root, "track.mp3"), "audio");
    try {
      const provider = createLocalProvider();
      const appState = createInitialAppState({ local: provider });
      const rows = providerNavigationRows(appState, { providerId: "local", path: [root] });

      expect(rows.map(({ kind, label }) => ({ kind, label }))).toEqual([
        { kind: "local-directory", label: "Album" },
        { kind: "track", label: "track.mp3" },
      ]);
      expect(provider.playableTargetAt?.({ providerId: "local", path: [root] }, 0)).toBeUndefined();
      expect(provider.playableTargetAt?.({ providerId: "local", path: [root] }, 1)).toMatchObject({
        title: "track.mp3",
        identity: { providerId: "local", stableId: join(root, "track.mp3") },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Offline YouTube Cache browses Tracks only", async () => {
    const root = `/tmp/tmu-cache-navigation-${process.pid}-${crypto.randomUUID()}`;
    const options = { cacheDir: root, mediaDirName: "media", metadataFileName: "metadata.json" };
    try {
      await writeOfflineYouTubeCacheMetadata(options, {
        version: 1, extractor: "youtube", id: "abc", title: "Cached Track", mediaFileName: "audio.webm",
      });
      const provider = createOfflineYouTubeCacheProvider(options);
      const appState = createInitialAppState({ "offline-youtube-cache": provider });
      const rows = providerNavigationRows(appState, { providerId: "offline-youtube-cache", path: [] });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "track", label: "Cached Track" });
      expect(rows.every((row) => row.kind === "track")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
