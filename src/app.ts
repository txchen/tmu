import { AppCoordinator } from "./coordinator";
import { NoopPlayer } from "./player";
import { createSkeletonProviders } from "./providers";
import { MemoryQueue } from "./queue";
import { createInitialAppState, createInitialUiState } from "./state";

export function createTmuApp(): { coordinator: AppCoordinator } {
  const providers = createSkeletonProviders();
  const coordinator = new AppCoordinator({
    appState: createInitialAppState(providers),
    uiState: createInitialUiState(),
    queue: new MemoryQueue(),
    player: new NoopPlayer(),
  });

  return { coordinator };
}
