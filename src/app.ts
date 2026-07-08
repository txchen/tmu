import { AppCoordinator } from "./coordinator";
import {
  checkDependencyHealth,
  checkHelperDependencyHealth,
  type DependencyCommandRunner,
  type DependencyHealthState,
} from "./dependencies";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BunMpvProcessAdapter, MpvPlayer, NoopPlayer } from "./player";
import { createSkeletonProviders } from "./providers";
import { MemoryQueue } from "./queue";
import { createInitialAppState, createInitialUiState } from "./state";
import { loadTmuConfig, type TmuConfig, type TmuConfigInput } from "./config";
import type { DependencyHealthRefresh } from "./coordinator";
import { FileLastQueueSnapshotPersistence, type LastQueueSnapshotPersistence } from "./snapshot";
import type { Player } from "./domain";

export type TmuAppOptions = {
  config?: TmuConfigInput;
  configPath?: string;
  configSource?: "defaults" | "file";
  dependencyHealth?: DependencyHealthState;
  refreshDependencyHealth?: DependencyHealthRefresh;
  snapshotPersistence?: LastQueueSnapshotPersistence;
  player?: Player;
};

export type TmuRuntimeOptions = {
  configPath?: string;
  dependencyRunner?: DependencyCommandRunner;
};

export function createTmuApp(options: TmuAppOptions = {}): { coordinator: AppCoordinator } {
  const providers = createSkeletonProviders();
  const coordinator = new AppCoordinator({
    appState: createInitialAppState(providers, {
      config: options.config,
      configPath: options.configPath,
      configSource: options.configSource,
      dependencyHealth: options.dependencyHealth,
    }),
    uiState: createInitialUiState(),
    queue: new MemoryQueue(),
    player: options.player ?? new NoopPlayer(),
    refreshDependencyHealth: options.refreshDependencyHealth,
    snapshotPersistence: options.snapshotPersistence,
  });

  return { coordinator };
}

export async function createTmuRuntime(options: TmuRuntimeOptions = {}): Promise<{ coordinator: AppCoordinator; config: TmuConfig }> {
  const loaded = await loadTmuConfig({ path: options.configPath });
  let dependencyHealth = await checkDependencyHealth(loaded.config, {
    runner: options.dependencyRunner,
  });
  const player = dependencyHealth.playback.enabled
    ? new MpvPlayer({
      command: loaded.config.helpers.mpv,
      ipcPath: join(tmpdir(), `tmu-mpv-${process.pid}-${Date.now()}.sock`),
      workDir: tmpdir(),
      adapter: new BunMpvProcessAdapter(),
      commandTimeoutMs: loaded.config.dependencyPolicy.checkTimeoutMs,
    })
    : new NoopPlayer();

  if (dependencyHealth.playback.enabled) {
    try {
      await player.start();
    } catch (error) {
      await player.teardown().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      dependencyHealth = {
        ...dependencyHealth,
        playback: {
          enabled: false,
          message: `Playback disabled: ${message}`,
        },
      };
    }
  }

  return {
    ...createTmuApp({
      config: loaded.config,
      configPath: loaded.path,
      configSource: loaded.source,
      dependencyHealth,
      player,
      snapshotPersistence: new FileLastQueueSnapshotPersistence(loaded.config.persistence.lastQueueSnapshotPath),
      refreshDependencyHealth: (helper, currentHealth) =>
        checkHelperDependencyHealth(loaded.config, helper, currentHealth, {
          runner: options.dependencyRunner,
        }),
    }),
    config: loaded.config,
  };
}
