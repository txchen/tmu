import { AppCoordinator } from "./coordinator";
import {
  checkHelperDependencyHealth,
  createDefaultDependencyHealth,
  type DependencyCommandRunner,
  type DependencyHealthState,
} from "./dependencies";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NodeMpvProcessAdapter, MpvPlayer, NoopPlayer } from "./player";
import { createDefaultProviders } from "./providers";
import { MemoryPlaylistContent } from "./playlist-content";
import { createInitialAppState, createInitialUiState } from "./state";
import { createDefaultTmuConfig, loadTmuConfig, type TmuConfig, type TmuConfigInput } from "./config";
import type { DependencyHealthRefresh } from "./coordinator";
import { FileAppPreferencesPersistence, type AppPreferencesPersistence } from "./preferences";
import { FileLastQueueSnapshotPersistence, type LastQueueSnapshotPersistence } from "./snapshot";
import { FileLastPlaylistSnapshotPersistence, type LastPlaylistSnapshotPersistence } from "./playlist-snapshot";
import type { Player } from "./domain";
import type { executeYouTubeDownloadBatch, prepareYouTubeDownloadBatch } from "./youtube-url-download";

export type TmuAppOptions = {
  config?: TmuConfigInput;
  configPath?: string;
  configSource?: "defaults" | "file";
  dependencyHealth?: DependencyHealthState;
  refreshDependencyHealth?: DependencyHealthRefresh;
  legacyQueueSnapshotPersistence?: LastQueueSnapshotPersistence;
  playlistSnapshotPersistence?: LastPlaylistSnapshotPersistence;
  appPreferencesPersistence?: AppPreferencesPersistence;
  player?: Player;
  dependencyRunner?: DependencyCommandRunner;
  prepareDownloadBatch?: typeof prepareYouTubeDownloadBatch;
  executeDownloadBatch?: typeof executeYouTubeDownloadBatch;
};

export type TmuRuntimeOptions = {
  configPath?: string;
  dependencyRunner?: DependencyCommandRunner;
  startPlayer?: boolean;
};

export function createTmuApp(options: TmuAppOptions = {}): {
  coordinator: AppCoordinator;
} {
  const config = createDefaultTmuConfig(options.config);
  const dependencyHealth = options.dependencyHealth ?? createDefaultDependencyHealth();
  const providers = createDefaultProviders();
  const coordinator = new AppCoordinator({
    appState: createInitialAppState(providers, {
      config,
      configPath: options.configPath,
      configSource: options.configSource,
      dependencyHealth,
    }),
    uiState: createInitialUiState(),
    initialPlaylistContent: new MemoryPlaylistContent(),
    player: options.player ?? new NoopPlayer(),
    refreshDependencyHealth: options.refreshDependencyHealth,
    legacyQueueSnapshotPersistence: options.legacyQueueSnapshotPersistence,
    playlistSnapshotPersistence: options.playlistSnapshotPersistence,
    appPreferencesPersistence: options.appPreferencesPersistence,
    dependencyRunner: options.dependencyRunner,
    prepareDownloadBatch: options.prepareDownloadBatch,
    executeDownloadBatch: options.executeDownloadBatch,
  });

  return { coordinator };
}

export async function createTmuRuntime(options: TmuRuntimeOptions = {}): Promise<{
  coordinator: AppCoordinator;
  config: TmuConfig;
}> {
  const loaded = await loadTmuConfig({ path: options.configPath });
  const shouldStartPlayer = options.startPlayer ?? true;
  const dependencyHealth = createDefaultDependencyHealth();
  const player = shouldStartPlayer
    ? new MpvPlayer({
      command: loaded.config.helpers.mpv,
      ipcPath: join(tmpdir(), `tmu-mpv-${process.pid}-${Date.now()}.sock`),
      workDir: tmpdir(),
      adapter: new NodeMpvProcessAdapter(),
      commandTimeoutMs: loaded.config.dependencyPolicy.checkTimeoutMs,
      positionPollMs: loaded.config.lowPower.playbackTickMs,
    })
    : new NoopPlayer();

  return {
    ...createTmuApp({
      config: loaded.config,
      configPath: loaded.path,
      configSource: loaded.source,
      dependencyHealth,
      player,
      legacyQueueSnapshotPersistence: new FileLastQueueSnapshotPersistence(loaded.config.persistence.lastQueueSnapshotPath),
      playlistSnapshotPersistence: new FileLastPlaylistSnapshotPersistence(loaded.config.persistence.lastPlaylistSnapshotPath),
      appPreferencesPersistence: new FileAppPreferencesPersistence(loaded.config.persistence.appPreferencesPath),
      refreshDependencyHealth: (helper, currentHealth) =>
        checkHelperDependencyHealth(loaded.config, helper, currentHealth, {
          runner: options.dependencyRunner,
        }),
      dependencyRunner: options.dependencyRunner,
    }),
    config: loaded.config,
  };
}
