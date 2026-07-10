import type { AppCoordinator, AppIntent } from "../src/index";

type CoordinatorContractAction =
  | { type: "selectNavigationTarget"; targetId: string }
  | { type: "moveSelection"; delta: number }
  | { type: "activateSelectedContent" }
  | { type: "cycleFocus" }
  | { type: "enqueueSelectedTrack" }
  | { type: "refreshNavidromeLibrary" }
  | { type: "openNavidromeSearchPrompt" }
  | { type: "setPromptInput"; value: string }
  | { type: "submitPrompt" }
  | { type: "openLocalPathPrompt" }
  | { type: "startSelectedQueueEntry" }
  | { type: "removeSelectedQueueEntry" }
  | { type: "moveSelectedQueueEntry"; delta: number };

/** Drives Provider and Queue contract setup without widening production AppIntent. */
export async function driveCoordinatorContract(
  coordinator: AppCoordinator,
  intent: AppIntent | CoordinatorContractAction,
): Promise<void> {
  if (isAppIntent(intent)) {
    await coordinator.dispatch(intent);
    return;
  }

  if (intent.type === "refreshNavidromeLibrary" && coordinator.uiState.activeTargetId !== "navidrome") return;
  const method = intent.type;
  const callable = Reflect.get(coordinator, method) as (...args: unknown[]) => unknown;
  const argument = "targetId" in intent ? intent.targetId
    : "delta" in intent ? intent.delta
    : "value" in intent ? intent.value
    : undefined;
  await callable.call(coordinator, ...argument === undefined ? [] : [argument]);
}

function isAppIntent(intent: AppIntent | CoordinatorContractAction): intent is AppIntent {
  return [
    "playNext", "playNow", "removeQueueTrack", "moveQueueTrack", "clearQueue",
    "providerOperation", "globalSearch", "downloadOperation", "persistenceOperation", "playerOperation",
  ].includes(intent.type);
}
