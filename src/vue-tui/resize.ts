import type { AppCoordinator } from "../coordinator";
import { sameIdentity } from "../domain";
import { queueHomeVisibleRows, responsiveTier } from "../ui-state";

export function dispatchTerminalResize(
  coordinator: AppCoordinator,
  columns: number,
  rows: number,
): void {
  const selected = coordinator.appState.queue.entries.find((entry) =>
    sameIdentity(entry.track.identity, coordinator.uiState.selectedQueueIdentity));
  const hasExceptionalLine = selected?.availability.status === "unavailable";
  coordinator.dispatchUi({
    type: "resize",
    columns,
    rows,
    queueIdentities: coordinator.queueTrackIdentities(),
    visibleQueueRows: queueHomeVisibleRows(responsiveTier(columns, rows), rows, hasExceptionalLine),
  });
}
