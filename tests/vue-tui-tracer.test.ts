import { afterEach, describe, expect, test } from "bun:test";
import { render, cleanup } from "@vue-tui/testing";
import {
  AppCoordinator,
  InMemoryLastQueueSnapshotPersistence,
  MemoryQueue,
  createDefaultDependencyHealth,
  createInitialAppState,
  createInitialUiState,
  type PlaybackLocator,
  type Player,
  type PlayerPlaybackState,
  type Track,
} from "../src/index";
import { createVueTuiTracer } from "../src/prototypes/vue-tui-tracer/component";

afterEach(() => cleanup());

const restoredTrack: Track = {
  identity: { providerId: "tracer", stableId: "restored-track" },
  title: "Restored Track",
  artist: "Tracer Artist",
  providerLabel: "Development Tracer",
};

class TracerPlayer implements Player {
  toggles = 0;
  private state: PlayerPlaybackState = { status: "idle" };
  private readonly listeners = new Set<(state: PlayerPlaybackState) => void>();

  get playback(): PlayerPlaybackState {
    return this.state;
  }

  async start(): Promise<PlayerPlaybackState> {
    return this.state;
  }

  async load(_locator: PlaybackLocator): Promise<void> {
    this.publish({ status: "playing" });
  }

  async togglePause(): Promise<PlayerPlaybackState> {
    this.toggles += 1;
    this.publish({ ...this.state, status: this.state.status === "playing" ? "paused" : "playing" });
    return this.state;
  }

  async setPaused(paused: boolean): Promise<PlayerPlaybackState> {
    this.publish({ ...this.state, status: paused ? "paused" : "playing" });
    return this.state;
  }

  async stop(): Promise<PlayerPlaybackState> {
    this.publish({ status: "stopped" });
    return this.state;
  }

  async seekBy(_seconds: number): Promise<PlayerPlaybackState> {
    return this.state;
  }

  async setVolume(percent: number): Promise<PlayerPlaybackState> {
    this.publish({ ...this.state, volumePercent: percent });
    return this.state;
  }

  async teardown(): Promise<void> {}

  onPlaybackStateChange(listener: (state: PlayerPlaybackState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishPosition(positionSeconds: number): void {
    this.publish({ ...this.state, status: "playing", positionSeconds });
  }

  private publish(state: PlayerPlaybackState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

async function developmentTracerHarness() {
  const snapshots = new InMemoryLastQueueSnapshotPersistence();
  await snapshots.save({
    version: 1,
    entries: [{ track: restoredTrack, availability: { status: "available" } }],
    currentIndex: 0,
    shuffle: false,
    repeatAll: false,
    volume: { percent: 72, ready: true },
  });
  const player = new TracerPlayer();
  const health = createDefaultDependencyHealth();
  health.playback = { enabled: true, message: "Development tracer Player ready" };
  const coordinator = new AppCoordinator({
    appState: createInitialAppState({
      tracer: {
        id: "tracer",
        label: "Development Tracer",
        hint: "one restored Track",
        listVisibleTracks: () => [restoredTrack],
        resolvePlaybackLocator: async () => ({ kind: "file", path: "/dev/null" }),
      },
    }, { dependencyHealth: health }),
    uiState: createInitialUiState(),
    queue: new MemoryQueue(),
    player,
    snapshotPersistence: snapshots,
  });
  await coordinator.start([]);
  return { coordinator, player };
}

describe("development-only vue-tui tracer", () => {
  test("restores Queue Home without autoplay, resumes through registry dispatch, and traps overlay input", async () => {
    const { coordinator, player } = await developmentTracerHarness();
    const terminal = await render(createVueTuiTracer({ coordinator }), { columns: 120, rows: 24 });

    expect(terminal.lastFrame()).toContain("Queue Home · wide");
    expect(terminal.lastFrame()).toContain("Restored Track");
    expect(terminal.lastFrame()).toContain("Restored — Space to Resume");
    expect(player.toggles).toBe(0);

    await terminal.stdin.write(" ");
    expect(player.toggles).toBe(1);
    expect(terminal.lastFrame()).toContain("Playing");

    await terminal.stdin.write("o");
    expect(terminal.lastFrame()).toContain("Picker Overlay · music-picker");
    await terminal.stdin.write(" ");
    expect(player.toggles).toBe(1);
    await terminal.stdin.write("q");
    expect(terminal.lastFrame()).not.toContain("Picker Overlay");
    expect(terminal.lastFrame()).toContain("Restored Track");
  });

  test("crosses responsive tiers without losing Current Track, Track Identity selection, or overlay state", async () => {
    const { coordinator } = await developmentTracerHarness();
    const terminal = await render(createVueTuiTracer({ coordinator }), { columns: 120, rows: 24 });
    await terminal.stdin.write("o");

    for (const [columns, rows, tier] of [
      [100, 24, "medium"],
      [70, 24, "narrow"],
      [50, 14, "terminal-too-small"],
      [130, 30, "wide"],
    ] as const) {
      await terminal.terminal.resize(columns, rows);
      await terminal.waitUntilRenderFlush();
      expect(coordinator.uiState.terminal.tier).toBe(tier);
      expect(coordinator.uiState.selectedQueueIdentity).toEqual(restoredTrack.identity);
      expect(coordinator.appState.playback.currentTrackIdentity).toEqual(restoredTrack.identity);
      expect(coordinator.uiState.overlays.at(-1)?.kind).toBe("music-picker");
    }
  });

  test("does not redraw while idle or for playback-position-only publications", async () => {
    const { coordinator, player } = await developmentTracerHarness();
    const terminal = await render(createVueTuiTracer({ coordinator }), { columns: 120, rows: 24 });
    const initialFrames = terminal.frames.length;

    await Bun.sleep(80);
    expect(terminal.frames).toHaveLength(initialFrames);

    await terminal.stdin.write(" ");
    const playingFrames = terminal.frames.length;
    player.publishPosition(1);
    await Bun.sleep(80);
    expect(terminal.frames).toHaveLength(playingFrames);
  });
});
