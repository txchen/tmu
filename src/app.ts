import { AppCoordinator } from "./coordinator";
import {
  checkDependencyHealth,
  checkHelperDependencyHealth,
  createDefaultDependencyHealth,
  type DependencyCommandRunner,
  type DependencyHealthState,
} from "./dependencies";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BunMpvProcessAdapter, MpvPlayer, NoopPlayer } from "./player";
import { createDefaultProviders } from "./providers";
import { MemoryQueue } from "./queue";
import { createInitialAppState, createInitialUiState } from "./state";
import { createDefaultTmuConfig, loadTmuConfig, type TmuConfig, type TmuConfigInput } from "./config";
import type { DependencyHealthRefresh } from "./coordinator";
import { FileAppPreferencesPersistence, type AppPreferencesPersistence } from "./preferences";
import { FileLastQueueSnapshotPersistence, type LastQueueSnapshotPersistence } from "./snapshot";
import type { Player } from "./domain";
import type { NavidromeFetcher } from "./navidrome";
import type { YouTubeDownloader } from "./youtube-url-download";

export type TmuAppOptions = {
  config?: TmuConfigInput;
  configPath?: string;
  configSource?: "defaults" | "file";
  dependencyHealth?: DependencyHealthState;
  refreshDependencyHealth?: DependencyHealthRefresh;
  snapshotPersistence?: LastQueueSnapshotPersistence;
  appPreferencesPersistence?: AppPreferencesPersistence;
  player?: Player;
  dependencyRunner?: DependencyCommandRunner;
  youtubeDownloader?: YouTubeDownloader;
  navidromeFetcher?: NavidromeFetcher;
  navidromeSaltFactory?: () => string;
};

export type TmuRuntimeOptions = {
  configPath?: string;
  dependencyRunner?: DependencyCommandRunner;
  startPlayer?: boolean;
};

export function createTmuApp(options: TmuAppOptions = {}): {
  coordinator: AppCoordinator;
  appCoordinator: AppCoordinator;
} {
  const config = createDefaultTmuConfig(options.config);
  const dependencyHealth = options.dependencyHealth ?? createDefaultDependencyHealth();
  const providers = createDefaultProviders({
    local: {
      dependencyHealth,
      ffprobeCommand: config.helpers.ffprobe,
      runner: options.dependencyRunner,
      metadataTimeoutMs: config.dependencyPolicy.checkTimeoutMs,
      directorySoftCap: config.providers.local.directorySoftCap,
    },
    navidrome: {
      config: config.providers.navidrome,
      fetcher: options.navidromeFetcher,
      saltFactory: options.navidromeSaltFactory,
    },
    offlineYouTubeCache: config.offlineYouTubeCache,
  });
  const coordinator = new AppCoordinator({
    appState: createInitialAppState(providers, {
      config,
      configPath: options.configPath,
      configSource: options.configSource,
      dependencyHealth,
    }),
    uiState: createInitialUiState(),
    queue: new MemoryQueue(),
    player: options.player ?? new NoopPlayer(),
    refreshDependencyHealth: options.refreshDependencyHealth,
    snapshotPersistence: options.snapshotPersistence,
    appPreferencesPersistence: options.appPreferencesPersistence,
    dependencyRunner: options.dependencyRunner,
    youtubeDownloader: options.youtubeDownloader,
  });

  return { coordinator, appCoordinator: coordinator };
}

export async function createTmuRuntime(options: TmuRuntimeOptions = {}): Promise<{
  coordinator: AppCoordinator;
  appCoordinator: AppCoordinator;
  config: TmuConfig;
}> {
  const loaded = await loadTmuConfig({ path: options.configPath });
  let dependencyHealth = await checkDependencyHealth(loaded.config, {
    runner: options.dependencyRunner,
  });
  const shouldStartPlayer = options.startPlayer ?? true;
  const player = dependencyHealth.playback.enabled && shouldStartPlayer
    ? new MpvPlayer({
      command: loaded.config.helpers.mpv,
      ipcPath: join(tmpdir(), `tmu-mpv-${process.pid}-${Date.now()}.sock`),
      workDir: tmpdir(),
      adapter: new BunMpvProcessAdapter(),
      commandTimeoutMs: loaded.config.dependencyPolicy.checkTimeoutMs,
      positionPollMs: loaded.config.lowPower.playbackTickMs,
    })
    : new NoopPlayer();

  if (dependencyHealth.playback.enabled && shouldStartPlayer) {
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
