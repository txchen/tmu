import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LegacyTuiController,
  MemoryQueue,
  NoopPlayer,
  createDefaultDependencyHealth,
  createInitialAppState,
  createInitialUiState,
  createDefaultProviders,
  createTmuApp,
  renderShell,
  renderShellText,
  type TmuConfigInput,
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
  test("exposes navigation targets, Provider Browsing Surface, and persistent queue/player region", async () => {
    const coordinator = new LegacyTuiController({
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });

    await coordinator.start([]);
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
    expect(shell.queuePlayer.title).toBe("Queue / Player Strip");
    expect(shell.queuePlayer.nowPlaying).toBe("Idle - add a Track to the shared Queue");
    expect(shell.queuePlayer.playbackState).toBe("State: idle");
    expect(shell.queuePlayer.progress).toBe("Progress: --:--");
    expect(shell.queuePlayer.availability).toBe("Availability: no queued Tracks");
  });

  test("renders CLI-seeded queue state without requiring a TTY", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-renderer-cli-"));
    const file = join(dir, "song-a.flac");

    try {
      await writeFile(file, "not real audio");
      const coordinator = new LegacyTuiController({
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
      expect(text).toContain("Queue / Player Strip");
      expect(text).toContain("song-a.flac [queued]");
      expect(text).toContain("> Queue");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("renders persistent strip playback details, current selection, and Track Availability", () => {
    const missing = track("local", "/missing.flac", "Missing File");
    const queue = new MemoryQueue();
    queue.enqueue(missing);
    queue.startAt(0);
    queue.setShuffle(true);
    queue.setRepeatAll(true);
    queue.markAvailability(missing.identity, { status: "unavailable", reason: "file no longer exists" });
    const uiState = createInitialUiState();
    uiState.focusedPane = "queue";
    const coordinator = new LegacyTuiController({
      appState: createInitialAppState(createDefaultProviders()),
      uiState,
      queue,
      player: new NoopPlayer(),
    });

    coordinator.appState.playback = {
      status: "error",
      currentTrackIdentity: missing.identity,
      positionSeconds: 65,
      durationSeconds: 210,
      message: "file no longer exists",
    };
    coordinator.appState.volume = { percent: 42, ready: true };
    const shell = renderShell(coordinator.appState, coordinator.uiState);
    const text = renderShellText(coordinator.appState, coordinator.uiState);

    expect(shell.queuePlayer.nowPlaying).toBe("Error Missing File - file no longer exists");
    expect(shell.queuePlayer.playbackState).toBe("State: error");
    expect(shell.queuePlayer.progress).toBe("Progress: 01:05 / 03:30");
    expect(shell.queuePlayer.modes).toBe("Shuffle: on | Repeat: all | Volume: 42%");
    expect(shell.queuePlayer.availability).toBe("Availability: Missing File - unavailable: file no longer exists");
    expect(shell.queuePlayer.lines).toEqual([">* Missing File [unavailable: file no longer exists]"]);
    expect(text).toContain("Progress: 01:05 / 03:30");
    expect(text).toContain("Shuffle: on | Repeat: all | Volume: 42%");
    expect(text).toContain("Missing File [unavailable: file no longer exists]");
  });

  test("renders the Queue navigation target as an expanded Queue view while keeping the player strip", () => {
    const playable = {
      ...track("local", "/music/playable.flac", "Playable File"),
      durationSeconds: 125,
    };
    const missing = track("local", "/music/missing.flac", "Missing File");
    const queue = new MemoryQueue();
    queue.enqueue(playable);
    queue.enqueue(missing);
    queue.startAt(0);
    queue.markAvailability(playable.identity, { status: "available" });
    queue.markAvailability(missing.identity, { status: "unavailable", reason: "file no longer exists" });
    const uiState = createInitialUiState();
    uiState.activeTargetId = "queue";
    uiState.focusedPane = "queue";
    uiState.selectedQueueIndex = 1;
    const coordinator = new LegacyTuiController({
      appState: createInitialAppState(createDefaultProviders()),
      uiState,
      queue,
      player: new NoopPlayer(),
    });

    coordinator.appState.playback = {
      status: "playing",
      currentTrackIdentity: playable.identity,
      positionSeconds: 5,
      durationSeconds: 125,
    };
    coordinator.appState.volume = { percent: 80, ready: true };
    const shell = renderShell(coordinator.appState, coordinator.uiState);
    const text = renderShellText(coordinator.appState, coordinator.uiState);

    expect(shell.providerSurface.title).toBe("Expanded Queue");
    expect(shell.providerSurface.lines).toEqual([
      "   1. Playable File - local - 02:05 - playing - current",
      ">* 2. Missing File - local - unavailable: file no longer exists",
    ]);
    expect(shell.queuePlayer.nowPlaying).toBe("Playing Playable File");
    expect(shell.queuePlayer.progress).toBe("Progress: 00:05 / 02:05");
    expect(shell.queuePlayer.lines).toContain(">* Missing File [unavailable: file no longer exists]");
    expect(text).toContain("Expanded Queue");
    expect(text).toContain("Queue / Player Strip");
  });

  test("surfaces dependency health without exposing config secrets", async () => {
    const coordinator = new LegacyTuiController({
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

    await coordinator.start([]);
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

  test("renders YouTube download progress lines on the YouTube URL Download surface", async () => {
    const { coordinator } = createTmuApp();

    await coordinator.start([]);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "youtube-url-download" });
    coordinator.appState.downloads = {
      active: true,
      lines: [
        "download 12.5% at 1.00MiB/s ETA 00:07",
        "download destination: youtube-AbC123.webm",
      ],
    };

    const shell = renderShell(coordinator.appState, coordinator.uiState);

    expect(shell.providerSurface.lines).toContain("download 12.5% at 1.00MiB/s ETA 00:07");
    expect(shell.providerSurface.lines).toContain("download destination: youtube-AbC123.webm");
  });

  test("renders Navidrome missing-config Provider state", async () => {
    const { coordinator } = createTmuApp();

    await coordinator.start([]);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });
    const text = renderShellText(coordinator.appState, coordinator.uiState);

    expect(text).toContain("! Navidrome missing config:");
    expect(text).toContain("server URL");
    expect(text).toContain("password or token+salt");
  });

  test("renders Navidrome connected Provider state", async () => {
    const seenPaths: string[] = [];
    const { coordinator } = createTmuApp({
      config: connectedNavidromeConfig(),
      navidromeFetcher: async (url) => {
        seenPaths.push(url.pathname);
        if (url.pathname.endsWith("/getArtists.view")) {
          return navidromeJson({
            status: "ok",
            artists: {
              index: [
                {
                  name: "A",
                  artist: [
                    { id: "artist-1", name: "Alpha", albumCount: 2 },
                    { id: "artist-2", name: "Arc Light", albumCount: 1 },
                  ],
                },
              ],
            },
          });
        }
        return navidromeJson({ status: "ok" });
      },
      navidromeSaltFactory: () => "salt",
    });

    await coordinator.start([]);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });
    const shell = renderShell(coordinator.appState, coordinator.uiState);

    expect(shell.providerSurface.lines).toContain(
      "Navidrome: connected to https://music.example.test; Library Browser ready",
    );
    expect(shell.providerSurface.lines).toContain(">* Artists");
    expect(shell.providerSurface.lines).toContain("     Alpha (2 albums)");
    expect(shell.providerSurface.lines).toContain("     Arc Light (1 album)");
    expect(seenPaths).toEqual([
      "/rest/ping.view",
      "/rest/getArtists.view",
    ]);

    await coordinator.dispatch({ type: "moveSelection", delta: 1 });
    const movedShell = renderShell(coordinator.appState, coordinator.uiState);
    expect(movedShell.providerSurface.lines).toContain(">*   Alpha (2 albums)");
    expect(seenPaths).toEqual([
      "/rest/ping.view",
      "/rest/getArtists.view",
    ]);
  });

  test("renders Navidrome auth failure Provider state without secrets", async () => {
    const { coordinator } = createTmuApp({
      config: connectedNavidromeConfig({
        password: "secret-password",
        token: "secret-token",
        salt: "secret-salt",
      }),
      navidromeFetcher: async () => navidromeJson({
        status: "failed",
        error: {
          code: 40,
          message: "bad secret-password secret-token secret-salt",
        },
      }),
      navidromeSaltFactory: () => "salt",
    });

    await coordinator.start([]);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });
    const text = renderShellText(coordinator.appState, coordinator.uiState);

    expect(text).toContain("! Navidrome auth failed: bad [redacted] [redacted] [redacted] (code 40)");
    expect(text).not.toContain("secret-password");
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("secret-salt");
  });

  test("renders Navidrome API failure Provider state", async () => {
    const { coordinator } = createTmuApp({
      config: connectedNavidromeConfig(),
      navidromeFetcher: async () => navidromeJson({
        status: "failed",
        error: {
          code: 70,
          message: "The requested data was not found",
        },
      }),
      navidromeSaltFactory: () => "salt",
    });

    await coordinator.start([]);
    await coordinator.dispatch({ type: "selectNavigationTarget", targetId: "navidrome" });
    const text = renderShellText(coordinator.appState, coordinator.uiState);

    expect(text).toContain("! Navidrome API failed: The requested data was not found (code 70)");
  });
});

function connectedNavidromeConfig(
  overrides: NonNullable<NonNullable<TmuConfigInput["providers"]>["navidrome"]> = {},
): TmuConfigInput {
  return {
    providers: {
      navidrome: {
        enabled: true,
        serverUrl: "https://music.example.test",
        username: "alex",
        password: "secret-password",
        clientName: "tmu-test",
        ...overrides,
      },
    },
  };
}

function navidromeJson(subsonicResponse: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    "subsonic-response": {
      version: "1.16.1",
      ...subsonicResponse,
    },
  }), {
    headers: { "content-type": "application/json" },
  });
}
