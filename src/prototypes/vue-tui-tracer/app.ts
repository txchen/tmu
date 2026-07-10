#!/usr/bin/env bun
import { createApp } from "@vue-tui/runtime";
import { AppCoordinator } from "../../coordinator";
import { createDefaultDependencyHealth } from "../../dependencies";
import type { PlaybackLocator, Player, PlayerPlaybackState, Track } from "../../domain";
import { MemoryQueue } from "../../queue";
import { InMemoryLastQueueSnapshotPersistence } from "../../snapshot";
import { createInitialAppState, createInitialUiState } from "../../state";
import { createVueTuiTracer } from "./component";

export const developmentTracerTrack: Track = {
  identity: { providerId: "tracer", stableId: "restored-track" },
  title: "Restored Track",
  artist: "Tracer Artist",
  providerLabel: "Development Tracer",
};

export class DevelopmentTracerPlayer implements Player {
  toggles = 0;
  private state: PlayerPlaybackState = { status: "paused", positionSeconds: 37 };
  private readonly listeners = new Set<(state: PlayerPlaybackState) => void>();

  get playback(): PlayerPlaybackState {
    return this.state;
  }

  async start(): Promise<PlayerPlaybackState> {
    return this.state;
  }

  async load(_locator: PlaybackLocator): Promise<void> {
    this.publish({ status: "playing", positionSeconds: 0 });
  }

  async togglePause(): Promise<PlayerPlaybackState> {
    this.toggles += 1;
    this.publish({
      ...this.state,
      status: this.state.status === "playing" ? "paused" : "playing",
    });
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
    this.publish({ ...this.state, positionSeconds });
  }

  private publish(state: PlayerPlaybackState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

export async function createDevelopmentTracerRuntime(options: { player?: Player } = {}): Promise<{
  coordinator: AppCoordinator;
  player: Player;
}> {
  const snapshots = new InMemoryLastQueueSnapshotPersistence();
  await snapshots.save({
    version: 1,
    entries: [{ track: developmentTracerTrack, availability: { status: "available" } }],
    currentIndex: 0,
    shuffle: false,
    repeatAll: false,
    volume: { percent: 72, ready: true },
  });
  const dependencyHealth = createDefaultDependencyHealth();
  dependencyHealth.playback = { enabled: true, message: "Development tracer Player ready" };
  const appState = createInitialAppState({
    tracer: {
      id: "tracer",
      label: "Development Tracer",
      hint: "one restored Track",
      listVisibleTracks: () => [developmentTracerTrack],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/dev/null" }),
    },
  }, { dependencyHealth });
  appState.playback = {
    status: "paused",
    positionSeconds: 37,
    currentTrackIdentity: developmentTracerTrack.identity,
  };
  const player = options.player ?? new DevelopmentTracerPlayer();
  const coordinator = new AppCoordinator({
    appState,
    uiState: createInitialUiState(),
    queue: new MemoryQueue(),
    player,
    snapshotPersistence: snapshots,
  });
  await coordinator.start([]);
  return { coordinator, player };
}

export async function main(): Promise<void> {
  const runtime = await createDevelopmentTracerRuntime();
  const { coordinator } = runtime;
  const app = createApp(createVueTuiTracer({ coordinator }));
  // Bun's PTY sends SIGWINCH but does not currently surface Node's stdout
  // `resize` event that vue-tui watches. Keep this demonstrated compatibility
  // shim local to the development tracer.
  const handleBunPtyResize = () => {
    coordinator.dispatchUi({
      type: "resize",
      columns: process.stdout.columns ?? coordinator.uiState.terminal.columns,
      rows: process.stdout.rows ?? coordinator.uiState.terminal.rows,
      queueIdentities: coordinator.queueTrackIdentities(),
      visibleQueueRows: Math.max(1, (process.stdout.rows ?? 24) - 5),
    });
  };
  const publishPlaybackPosition = () => {
    if (!(runtime.player instanceof DevelopmentTracerPlayer)) return;
    runtime.player.publishPosition((runtime.player.playback.positionSeconds ?? 0) + 1);
  };
  process.on("SIGWINCH", handleBunPtyResize);
  process.on("SIGUSR1", publishPlaybackPosition);
  app.mount({
    alternateScreen: true,
    interactive: true,
    patchConsole: false,
  });
  let terminating = false;
  const terminateFromSignal = (exitCode: number) => {
    if (terminating) return;
    terminating = true;
    app.unmount();
    void coordinator.teardown().finally(() => process.exit(exitCode));
  };
  const handleSigint = () => terminateFromSignal(130);
  const handleSigterm = () => terminateFromSignal(143);
  const handleSighup = () => terminateFromSignal(129);
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  process.once("SIGHUP", handleSighup);
  try {
    await app.waitUntilExit();
  } finally {
    process.off("SIGWINCH", handleBunPtyResize);
    process.off("SIGUSR1", publishPlaybackPosition);
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    process.off("SIGHUP", handleSighup);
    app.unmount();
    await coordinator.teardown();
  }
}

if (import.meta.main) await main();
