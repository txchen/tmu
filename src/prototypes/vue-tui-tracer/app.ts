#!/usr/bin/env bun
import { createApp } from "@vue-tui/runtime";
import { AppCoordinator } from "../../coordinator";
import { createDefaultDependencyHealth } from "../../dependencies";
import type { Track } from "../../domain";
import { NoopPlayer } from "../../player";
import { MemoryQueue } from "../../queue";
import { InMemoryLastQueueSnapshotPersistence } from "../../snapshot";
import { createInitialAppState, createInitialUiState } from "../../state";
import { createVueTuiTracer } from "./component";

const tracerTrack: Track = {
  identity: { providerId: "tracer", stableId: "restored-track" },
  title: "Restored Track",
  artist: "Tracer Artist",
  providerLabel: "Development Tracer",
};

export async function createDevelopmentTracerCoordinator(): Promise<AppCoordinator> {
  const snapshots = new InMemoryLastQueueSnapshotPersistence();
  await snapshots.save({
    version: 1,
    entries: [{ track: tracerTrack, availability: { status: "available" } }],
    currentIndex: 0,
    shuffle: false,
    repeatAll: false,
    volume: { percent: 72, ready: true },
  });
  const dependencyHealth = createDefaultDependencyHealth();
  dependencyHealth.playback = { enabled: true, message: "Development tracer Player ready" };
  const coordinator = new AppCoordinator({
    appState: createInitialAppState({
      tracer: {
        id: "tracer",
        label: "Development Tracer",
        hint: "one restored Track",
        listVisibleTracks: () => [tracerTrack],
        resolvePlaybackLocator: async () => ({ kind: "file", path: "/dev/null" }),
      },
    }, { dependencyHealth }),
    uiState: createInitialUiState(),
    queue: new MemoryQueue(),
    player: new NoopPlayer(),
    snapshotPersistence: snapshots,
  });
  await coordinator.start([]);
  return coordinator;
}

export async function main(): Promise<void> {
  const coordinator = await createDevelopmentTracerCoordinator();
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
  process.on("SIGWINCH", handleBunPtyResize);
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
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    process.off("SIGHUP", handleSighup);
    app.unmount();
    await coordinator.teardown();
  }
}

if (import.meta.main) await main();
