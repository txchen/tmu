import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@vue-tui/testing";
import { createTmuApp } from "../src/app";
import { AppCoordinator } from "../src/coordinator";
import type { Provider, Track } from "../src/domain";
import { NoopPlayer } from "../src/player";
import { MemoryQueue } from "../src/queue";
import { createInitialAppState, createInitialUiState } from "../src/state";
import { createTmuRoot } from "../src/vue-tui/component";
import type { YouTubeCacheProvider } from "../src/youtube-cache";

afterEach(() => cleanup());

describe("TMU top-level surface smoke", () => {
  test("opens on Playback and reaches Library and YouTube Downloader while retaining tab-local input", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });

    expect(terminal.lastFrame()).toContain("[1 Playback]");
    expect(terminal.lastFrame()).toContain("2 Library");
    expect(terminal.lastFrame()).toContain("3 YouTube Downloader");

    await terminal.stdin.write("2");
    await terminal.stdin.write("cached");
    expect(terminal.lastFrame()).toContain("[2 Library]");
    expect(terminal.lastFrame()).toContain("Cache Search: cached");

    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("3");
    await terminal.stdin.write("https://youtu.be/abc123");
    expect(terminal.lastFrame()).toContain("[3 YouTube Downloader]");
    expect(terminal.lastFrame()).toContain("https://youtu.be/abc123");

    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("2");
    expect(terminal.lastFrame()).toContain("Cache Search: cached");

    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("Library Help");
  });

  test("keeps core Playback queue actions available after provider narrowing", async () => {
    const first = cachedTrack("first", "First");
    const second = cachedTrack("second", "Second");
    const provider: Provider = {
      id: "youtube-cache",
      label: "YouTube Cache",
      listTracks: () => [first, second],
      searchTracks: () => [first, second],
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });
    await coordinator.dispatch({ type: "playNext", target: first });
    await coordinator.dispatch({ type: "playNext", target: second });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });

    await terminal.stdin.write(" ");
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(second.identity);

    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("Playback Help");
    await terminal.stdin.write("\x1b");

    await terminal.stdin.write("2");
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("s");
    expect(coordinator.appState.playback.status).toBe("stopped");
    await terminal.stdin.write("1");

    await terminal.stdin.write("C");
    expect(terminal.lastFrame()).toContain("Clear Queue permanently?");
    await terminal.stdin.write("y");
    expect(coordinator.appState.queue.entries).toEqual([]);

    await terminal.stdin.write("2");
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("a");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["first"]);
    expect(coordinator.appState.queue.currentIndex).toBe(-1);

    await terminal.stdin.write("j");
    await terminal.stdin.write("N");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["second", "first"]);
    expect(coordinator.appState.queue.currentIndex).toBe(-1);

    await terminal.stdin.write("\r");
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(second.identity);
  });

  test("Library shows Cache Health and confirms permanent Cache Deletion", async () => {
    const track = cachedTrack("cached00001", "Cached");
    let deleted = false;
    let cleanedStem: string | undefined;
    const provider: YouTubeCacheProvider = {
      id: "youtube-cache", label: "YouTube Cache",
      listTracks: () => deleted ? [] : [track], searchTracks: () => deleted ? [] : [track],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/cached00001.opus" }),
      refresh: () => undefined,
      listCacheEntries: () => [],
      listIncompleteEntries: () => cleanedStem ? [] : [
        { stem: "broken00001", paths: ["/cache/broken00001.opus"], reason: "Cache media has no sidecar" },
        { stem: "broken00002", paths: ["/cache/broken00002.opus"], reason: "Cache media has no sidecar" },
      ],
      findByIdentity: () => deleted ? undefined : ({
        track, availability: { status: "available" },
        metadata: {
          videoId: "cached00001", title: "Cached", uploader: "Artist",
          cachedAt: "2026-01-01T00:00:00.000Z", mediaFileName: "cached00001.opus", container: "opus",
        }, metadataPath: "/cache/cached00001.json", mediaPath: "/cache/cached00001.opus",
      }),
      deleteCacheEntry: async () => { deleted = true; return true; },
      cleanupIncompleteEntry: async (stem) => { cleanedStem = stem; return true; },
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player: new NoopPlayer(),
    });
    await coordinator.dispatch({ type: "playNow", target: track });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });
    await terminal.stdin.write("2");
    expect(terminal.lastFrame()).toContain("Cache Health: broken00001");
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("d");
    expect(terminal.lastFrame()).toContain("Permanently delete Cached? This will stop playback.");
    await terminal.stdin.write("y");
    expect(deleted).toBe(true);
    await terminal.stdin.write("J");
    await terminal.stdin.write("X");
    expect(terminal.lastFrame()).toContain("Clean incomplete broken00002?");
    await terminal.stdin.write("y");
    expect(cleanedStem).toBe("broken00002");
  });
});

function cachedTrack(stableId: string, title: string): Track {
  return {
    identity: { providerId: "youtube-cache", stableId },
    title,
    providerLabel: "YouTube Cache",
  };
}
