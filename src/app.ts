import { AppCoordinator } from "./coordinator";
import {
  checkDependencyHealth,
  checkHelperDependencyHealth,
  type DependencyCommandRunner,
  type DependencyHealthState,
} from "./dependencies";
import { NoopPlayer } from "./player";
import { createSkeletonProviders } from "./providers";
import { MemoryQueue } from "./queue";
import { createInitialAppState, createInitialUiState } from "./state";
import { loadTmuConfig, type TmuConfig, type TmuConfigInput } from "./config";
import type { DependencyHealthRefresh } from "./coordinator";

export type TmuAppOptions = {
  config?: TmuConfigInput;
  configPath?: string;
  configSource?: "defaults" | "file";
  dependencyHealth?: DependencyHealthState;
  refreshDependencyHealth?: DependencyHealthRefresh;
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
    player: new NoopPlayer(),
    refreshDependencyHealth: options.refreshDependencyHealth,
  });

  return { coordinator };
}

export async function createTmuRuntime(options: TmuRuntimeOptions = {}): Promise<{ coordinator: AppCoordinator; config: TmuConfig }> {
  const loaded = await loadTmuConfig({ path: options.configPath });
  const dependencyHealth = await checkDependencyHealth(loaded.config, {
    runner: options.dependencyRunner,
  });

  return {
    ...createTmuApp({
      config: loaded.config,
      configPath: loaded.path,
      configSource: loaded.source,
      dependencyHealth,
      refreshDependencyHealth: (helper, currentHealth) =>
        checkHelperDependencyHealth(loaded.config, helper, currentHealth, {
          runner: options.dependencyRunner,
        }),
    }),
    config: loaded.config,
  };
}
