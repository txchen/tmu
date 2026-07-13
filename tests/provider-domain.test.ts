import { describe, expect, test } from "vitest";
import { createTmuApp } from "../src/app";
import { createLastPlaylistSnapshot } from "../src/playlist-snapshot";
import type { Provider } from "../src/domain";

describe("narrow Provider domain", () => {
  test("the Provider contract needs only list, local search, and local playback resolution", async () => {
    const provider: Provider = {
      id: "youtube-cache",
      label: "YouTube Cache",
      listTracks: () => [],
      searchTracks: () => [],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/track.opus" }),
    };

    expect(Object.keys(provider).sort()).toEqual([
      "id",
      "label",
      "listTracks",
      "resolvePlaybackLocator",
      "searchTracks",
    ]);
    expect(await provider.resolvePlaybackLocator({ providerId: "youtube-cache", stableId: "track" }))
      .toEqual({ kind: "file", path: "/cache/track.opus" });
  });

  test("the default app exposes only the YouTube Cache Provider", () => {
    const { coordinator } = createTmuApp();

    expect(Object.keys(coordinator.appState.providers)).toEqual(["youtube-cache"]);
    expect(coordinator.appState.providers["youtube-cache"]).toMatchObject({
      id: "youtube-cache",
      label: "YouTube Cache",
      listTracks: expect.any(Function),
      searchTracks: expect.any(Function),
      resolvePlaybackLocator: expect.any(Function),
    });
  });

  test("Last Playlist Snapshot does not persist runtime Track Availability", () => {
    const snapshot = createLastPlaylistSnapshot({
      activePlaylistId: "00000000-0000-4000-8000-000000000001",
      playlists: [{
        id: "00000000-0000-4000-8000-000000000001",
        name: "Default",
        entries: [{ track: {
          identity: { providerId: "youtube-cache", stableId: "abc123" },
          title: "Cached Track",
          providerLabel: "YouTube Cache",
        }, availability: { status: "unavailable", reason: "cache entry missing" } }],
        currentIndex: 0, repeatAll: false, positionSeconds: 0, playbackStatus: "stopped",
      }],
    }, { percent: 80, ready: true });

    expect(snapshot.tracks).toEqual([{
        identity: { providerId: "youtube-cache", stableId: "abc123" },
        title: "Cached Track",
        providerLabel: "YouTube Cache",
    }]);
  });
});
