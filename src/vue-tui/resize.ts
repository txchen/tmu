import type { AppCoordinator } from "../coordinator";
import {
  queueHomeVisibleRows,
  responsiveTier,
  selectedUnavailableQueueEntry,
} from "../ui-state";

export function dispatchTerminalResize(
  coordinator: AppCoordinator,
  columns: number,
  rows: number,
): void {
  const selected = selectedUnavailableQueueEntry(
    coordinator.appState.queue.entries,
    coordinator.uiState.selectedQueueIdentity,
  );
  coordinator.dispatchUi({
    type: "resize",
    columns,
    rows,
    queueIdentities: coordinator.queueTrackIdentities(),
    visibleQueueRows: queueHomeVisibleRows(responsiveTier(columns, rows), rows, Boolean(selected)),
  });
}
