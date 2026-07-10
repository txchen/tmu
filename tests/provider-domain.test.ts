import { describe, expect, test } from "bun:test";
import { createTmuApp } from "../src/app";
import { createLastQueueSnapshot } from "../src/snapshot";
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

  test("Last Queue Snapshot does not persist runtime Track Availability", () => {
    const snapshot = createLastQueueSnapshot({
      entries: [{
        track: {
          identity: { providerId: "youtube-cache", stableId: "abc123" },
          title: "Cached Track",
          providerLabel: "YouTube Cache",
        },
        availability: { status: "unavailable", reason: "cache entry missing" },
      }],
      currentIndex: 0,
      shuffle: false,
      repeatAll: false,
    }, { percent: 80, ready: true });

    expect(snapshot.entries).toEqual([{
      track: {
        identity: { providerId: "youtube-cache", stableId: "abc123" },
        title: "Cached Track",
        providerLabel: "YouTube Cache",
      },
    }]);
  });
});
