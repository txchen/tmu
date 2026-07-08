import {
  NAVIGATION_TARGETS,
  type AppState,
  type Provider,
  type NavigationTargetId,
  type UiState,
} from "./domain";
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
    },
    playback: {
      status: "idle",
      currentTrackIdentity: null,
    },
    startupMode: "empty",
    downloads: {
      active: false,
      lines: [],
    },
    appErrors: [],
    lastEvent: "opened target switcher",
  };
}

export function createInitialUiState(): UiState {
  const selectedContentIndexByTarget = Object.fromEntries(
    NAVIGATION_TARGETS.map((target) => [target.id, 0]),
  ) as Record<NavigationTargetId, number>;

  return {
    activeTargetId: "local",
    focusedPane: "targets",
    selectedTargetIndex: 0,
    selectedContentIndexByTarget,
    selectedQueueIndex: 0,
    activePrompt: null,
    filterText: "",
    scrollByPane: {
      targets: 0,
      content: 0,
      queue: 0,
    },
  };
}
