import {
  type AppState,
  type Provider,
  type UiState,
} from "./domain";
import { createInitialUiState as createFrameworkNeutralUiState } from "./ui-state";
import {
  createDefaultTmuConfig,
  defaultConfigPath,
  redactTmuConfig,
  type TmuConfigInput,
} from "./config";
import {
  createDefaultDependencyHealth,
  type DependencyHealthState,
} from "./dependencies";
import { createEmptyGlobalSearchState } from "./global-search";

export type InitialAppStateOptions = {
  config?: TmuConfigInput;
  configPath?: string;
  configSource?: "defaults" | "file";
  dependencyHealth?: DependencyHealthState;
};

export function createInitialAppState(
  providers: Record<string, Provider>,
  options: InitialAppStateOptions = {},
): AppState {
  const config = createDefaultTmuConfig(options.config);

  return {
    config: redactTmuConfig(config),
    configPath: options.configPath ?? defaultConfigPath(),
    configSource: options.configSource ?? "defaults",
    dependencyHealth: options.dependencyHealth ?? createDefaultDependencyHealth(),
    providers,
    queue: {
      entries: [],
      currentIndex: -1,
      shuffle: false,
      repeatAll: false,
    },
    playback: {
      status: "idle",
      currentTrackIdentity: null,
    },
    volume: {
      percent: 100,
      ready: false,
    },
    downloads: {
      active: false,
      lines: [],
    },
    globalSearch: createEmptyGlobalSearchState(),
    appErrors: [],
    lastEvent: "opened target switcher",
  };
}

export function createInitialUiState(): UiState {
  return createFrameworkNeutralUiState();
}
