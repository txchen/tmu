import { describe, expect, test } from "bun:test";
import {
  AppCoordinator,
  MemoryQueue,
  NoopPlayer,
  createInitialAppState,
  createInitialUiState,
  createSkeletonProviders,
  renderShell,
  renderShellText,
} from "../src/index";

describe("renderShell", () => {
  test("exposes navigation targets, Provider Browsing Surface, and persistent queue/player region", () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createSkeletonProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });

    coordinator.start([]);
    const shell = renderShell(coordinator.appState, coordinator.uiState);

    expect(shell.navigationTargets.map((target) => target.label)).toEqual([
      "Local",
      "Navidrome",
      "Offline YouTube Cache",
      "YouTube URL Download",
      "Queue",
    ]);
    expect(shell.providerSurface.title).toBe("Local");
    expect(shell.providerSurface.emptyMessage).toContain("Provider Browsing Surface");
    expect(shell.queuePlayer.title).toBe("Queue / Player");
    expect(shell.queuePlayer.nowPlaying).toBe("Idle - add a Track to the shared Queue");
  });

  test("renders CLI-seeded queue state without requiring a TTY", () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createSkeletonProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });

    coordinator.start(["./song-a.flac"]);
    const text = renderShellText(coordinator.appState, coordinator.uiState);

    expect(text).toContain("Provider Browsing Surface");
    expect(text).toContain("Queue / Player");
    expect(text).toContain("song-a.flac [queued]");
    expect(text).toContain("> Queue");
  });
});
