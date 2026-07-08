import { describe, expect, test } from "bun:test";
import {
  AppCoordinator,
  MemoryQueue,
  NoopPlayer,
  createDefaultDependencyHealth,
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

  test("surfaces dependency health without exposing config secrets", async () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createSkeletonProviders(), {
        config: {
          providers: {
            navidrome: {
              enabled: true,
              password: "secret-password",
              token: "secret-token",
              salt: "secret-salt",
            },
          },
        },
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            mpv: { name: "mpv", command: "/missing/mpv", status: "missing" },
            ffprobe: { name: "ffprobe", command: "ffprobe", status: "missing" },
            "yt-dlp": { name: "yt-dlp", command: "yt-dlp", status: "missing" },
          },
          playback: {
            enabled: false,
            message: "Playback disabled: mpv missing at /missing/mpv",
          },
          metadata: {
            degraded: true,
            message: "Metadata degraded: ffprobe missing at ffprobe",
          },
          youtubeUrlDownload: {
            enabled: false,
            message: "YouTube URL Download disabled: yt-dlp missing at yt-dlp",
          },
        }),
      }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });

    coordinator.start([]);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "youtube-url-download" });
    const shell = renderShell(coordinator.appState, coordinator.uiState);
    const text = renderShellText(coordinator.appState, coordinator.uiState);

    expect(shell.health.lines).toContain("mpv: missing at /missing/mpv - playback disabled");
    expect(shell.health.lines).toContain("ffprobe: missing at ffprobe - metadata degraded");
    expect(shell.health.lines).toContain("yt-dlp: missing at yt-dlp - YouTube URL Download disabled");
    expect(shell.providerSurface.lines).toContain("! YouTube URL Download disabled: yt-dlp missing at yt-dlp");
    expect(text).not.toContain("secret-password");
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("secret-salt");
  });
});
