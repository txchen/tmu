import type { AppCoordinator } from "../coordinator";
import type { ConfirmationKind, UiState } from "../domain";

export type ConfirmationDescriptor = {
  kind: ConfirmationKind;
  title: string;
  consequence: string;
  confirmLabel: string;
  target?: string;
  batchId?: number;
};

export function activeConfirmation(coordinator: AppCoordinator): ConfirmationDescriptor | null {
  const app = coordinator.appState;
  if (app.downloads.quitConfirmationRequired) return {
    kind: "quit-downloads", title: "Quit TMU?", confirmLabel: "Quit",
    consequence: "Active and pending download work will be cancelled.",
  };
  if (app.downloads.confirmation) return {
    kind: "accept-playlist", title: `Accept playlist “${app.downloads.confirmation.title}”?`,
    target: app.downloads.confirmation.title, confirmLabel: "Download all",
    consequence: `This will create one Download Batch containing all ${app.downloads.confirmation.itemCount} source items.`,
  };
  if (app.cacheConfirmation) {
    const cache = app.cacheConfirmation;
    return {
      kind: cache.kind === "delete-track" ? "delete-cache" : "cleanup-cache",
      title: cache.kind === "delete-track" ? `Permanently delete “${cache.title ?? cache.stem}”?` : `Clean incomplete entry “${cache.title ?? cache.stem}”?`,
      target: cache.stem, confirmLabel: cache.kind === "delete-track" ? "Delete" : "Clean",
      consequence: cache.stopsPlayback
        ? "The cache files will be removed permanently and current playback will stop."
        : "The cache files will be removed permanently and must be downloaded again.",
    };
  }
  const pending = coordinator.uiState.pendingConfirmation;
  if (!pending) return null;
  if (pending.kind === "clear-queue") return {
    kind: pending.kind, title: "Clear Queue?", confirmLabel: "Clear",
    consequence: "All Queue entries will be removed and playback will stop.",
  };
  if (pending.kind === "cancel-download") return {
    ...pending, title: `Cancel ${pending.target ?? "active Download Batch"}?`, confirmLabel: "Cancel download",
    consequence: "Active work will stop and partial files will be cleaned up.",
  };
  if (pending.kind === "remove-pending-download") return {
    ...pending, title: `Remove ${pending.target ?? "pending Download Batch"}?`, confirmLabel: "Remove",
    consequence: "This pending work will not be downloaded.",
  };
  return null;
}

export function matchingConfirmationChoice(ui: UiState, confirmation: ConfirmationDescriptor) {
  const pending = ui.pendingConfirmation;
  return pending?.kind === confirmation.kind
    && pending.batchId === confirmation.batchId
    && pending.target === confirmation.target
    ? pending.choice
    : "cancel";
}

export async function activateConfirmation(
  confirmation: ConfirmationDescriptor,
  confirmed: boolean,
  coordinator: AppCoordinator,
): Promise<void> {
  switch (confirmation.kind) {
    case "clear-queue": if (confirmed) await coordinator.dispatch({ type: "clearQueue" }); return;
    case "cancel-download":
      if (confirmed) await coordinator.dispatch({ type: "downloadOperation", operation: "cancel-active" });
      return;
    case "remove-pending-download":
      if (confirmed && confirmation.batchId !== undefined) {
        await coordinator.dispatch({ type: "downloadOperation", operation: "remove-pending", batchId: confirmation.batchId });
      }
      return;
    case "delete-cache":
    case "cleanup-cache":
      await coordinator.dispatch({ type: "cacheOperation", operation: confirmed ? "confirm" : "cancel" });
      return;
    case "accept-playlist":
      await coordinator.dispatch({ type: "downloadOperation", operation: confirmed ? "confirm-playlist" : "cancel-playlist" });
      return;
    case "quit-downloads":
      await coordinator.dispatch({ type: "downloadOperation", operation: confirmed ? "confirm-quit" : "cancel-quit" });
      return;
  }
}
