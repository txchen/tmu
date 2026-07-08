import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppCoordinator,
  MemoryQueue,
  NoopPlayer,
  createDefaultDependencyHealth,
  createInitialAppState,
  createInitialUiState,
  createDefaultProviders,
  renderShell,
  renderShellText,
  type Track,
} from "../src/index";

async function waitFor(assertion: () => void, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(5);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function track(providerId: string, stableId: string, title: string): Track {
  return {
    identity: { providerId, stableId },
    title,
    providerLabel: providerId,
  };
}

describe("renderShell", () => {
  test("exposes navigation targets, Provider Browsing Surface, and persistent queue/player region", () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
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

  test("renders CLI-seeded queue state without requiring a TTY", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-renderer-cli-"));
    const file = join(dir, "song-a.flac");

    try {
      await writeFile(file, "not real audio");
      const coordinator = new AppCoordinator({
        appState: createInitialAppState(createDefaultProviders()),
        uiState: createInitialUiState(),
        queue: new MemoryQueue(),
        player: new NoopPlayer(),
      });

      await coordinator.start([file]);
      await waitFor(() => {
        expect(coordinator.appState.queue.entries).toHaveLength(1);
      });
      const text = renderShellText(coordinator.appState, coordinator.uiState);

      expect(text).toContain("Provider Browsing Surface");
      expect(text).toContain("Queue / Player");
      expect(text).toContain("song-a.flac [queued]");
      expect(text).toContain("> Queue");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("renders queue modes, volume readiness, current selection, and Track Availability", () => {
    const missing = track("local", "/missing.flac", "Missing File");
    const queue = new MemoryQueue();
    queue.enqueue(missing);
    queue.startAt(0);
    queue.setShuffle(true);
    queue.setRepeatAll(true);
    queue.markAvailability(missing.identity, { status: "unavailable", reason: "file no longer exists" });
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      queue,
      player: new NoopPlayer(),
    });

    coordinator.appState.playback = {
      status: "error",
      currentTrackIdentity: missing.identity,
      message: "file no longer exists",
    };
    coordinator.appState.volume = { percent: 42, ready: true };
    coordinator.uiState.focusedPane = "queue";

    const shell = renderShell(coordinator.appState, coordinator.uiState);
    const text = renderShellText(coordinator.appState, coordinator.uiState);

    expect(shell.queuePlayer.modes).toBe("Shuffle: on | Repeat: all | Volume: 42%");
    expect(shell.queuePlayer.lines).toEqual([">* Missing File [unavailable: file no longer exists]"]);
    expect(text).toContain("Shuffle: on | Repeat: all | Volume: 42%");
    expect(text).toContain("Missing File [unavailable: file no longer exists]");
  });

  test("surfaces dependency health without exposing config secrets", async () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders(), {
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
