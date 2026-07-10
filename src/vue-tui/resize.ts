import type { AppCoordinator } from "../coordinator";
import {
  queueHomeVisibleRows,
  responsiveTier,
  selectedUnavailableQueueEntry,
} from "../ui-state";
import { overlayContentRows, providerNavigationRows } from "../provider-navigation";

export function dispatchTerminalResize(
  coordinator: AppCoordinator,
  columns: number,
  rows: number,
): void {
  const selected = selectedUnavailableQueueEntry(
    coordinator.appState.queue.entries,
    coordinator.uiState.selectedQueueIdentity,
  );
  const tier = responsiveTier(columns, rows);
  const overlay = coordinator.uiState.overlays.at(-1);
  const overlayRows = overlay?.kind === "music-picker"
    ? providerNavigationRows(
      coordinator.appState,
      overlay.providerLocation ?? { providerId: null, path: [] },
    )
    : [];
  coordinator.dispatchUi({
    type: "resize",
    columns,
    rows,
    queueIdentities: coordinator.queueTrackIdentities(),
    visibleQueueRows: queueHomeVisibleRows(tier, rows, Boolean(selected)),
    overlayRowCount: overlay?.kind === "music-picker" ? overlayRows.length : undefined,
    visibleOverlayRows: overlay ? overlayContentRows(overlay.kind, tier, columns, rows) : undefined,
  });
}
