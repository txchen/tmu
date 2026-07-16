import type { TuiDaemonClient } from "../daemon-client";
import type { ConfirmationKind, UiState } from "../domain";

export type ConfirmationDescriptor = {
  kind: ConfirmationKind;
  title: string;
  consequence: string;
  confirmLabel: string;
  target?: string;
  batchId?: number;
};

export function activeConfirmation(coordinator: TuiDaemonClient): ConfirmationDescriptor | null {
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
  if (pending.kind === "delete-playlist") {
    const playlist = app.playlists.playlists.find((candidate) => candidate.id === pending.target);
    if (!playlist) return null;
    return {
      ...pending, title: `Delete Playlist “${playlist.name}”?`, confirmLabel: "Delete",
      consequence: `${playlist.entries.length} ${playlist.entries.length === 1 ? "Track" : "Tracks"} will be removed from this Playlist. YouTube Cache files will not be changed.`,
    };
  }
  if (pending.kind === "clear-playlist") return {
    kind: pending.kind, title: "Clear Playlist?", confirmLabel: "Clear",
    consequence: "All Playlist entries will be removed and playback will stop.",
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
  coordinator: TuiDaemonClient,
): Promise<void> {
  const protect = async (kind: ConfirmationDescriptor["kind"], targetId: string, intent: Parameters<TuiDaemonClient["dispatch"]>[0]) => {
    if (coordinator.confirmProtected) await coordinator.confirmProtected(kind, targetId, intent);
    else await coordinator.dispatch(intent);
  };
  switch (confirmation.kind) {
    case "delete-playlist":
      if (confirmed && confirmation.target) await protect(confirmation.kind, confirmation.target, { type: "deletePlaylist", playlistId: confirmation.target });
      return;
    case "clear-playlist": if (confirmed) await protect(confirmation.kind, coordinator.viewedPlaylistId ?? coordinator.appState.playlists.activePlaylistId, { type: "clearPlaylist" }); return;
    case "cancel-download":
      if (confirmed) await protect(confirmation.kind, String(confirmation.batchId ?? "active"), { type: "downloadOperation", operation: "cancel-active" });
      return;
    case "remove-pending-download":
      if (confirmed && confirmation.batchId !== undefined) {
        await protect(confirmation.kind, String(confirmation.batchId), { type: "downloadOperation", operation: "remove-pending", batchId: confirmation.batchId });
      }
      return;
    case "delete-cache":
    case "cleanup-cache":
      if (confirmed) await protect(confirmation.kind, confirmation.target ?? "cache-entry", { type: "cacheOperation", operation: "confirm" });
      else await coordinator.dispatch({ type: "cacheOperation", operation: "cancel" });
      return;
    case "accept-playlist":
      if (confirmed) await protect(confirmation.kind, confirmation.target ?? "playlist-download", { type: "downloadOperation", operation: "confirm-playlist" });
      else await coordinator.dispatch({ type: "downloadOperation", operation: "cancel-playlist" });
      return;
    case "quit-downloads":
      if (confirmed) await protect(confirmation.kind, "download-pipeline", { type: "downloadOperation", operation: "confirm-quit" });
      else await coordinator.dispatch({ type: "downloadOperation", operation: "cancel-quit" });
      return;
  }
}
