import type { AppCoordinator } from "../coordinator";

export function dispatchTerminalResize(
  coordinator: AppCoordinator,
  columns: number,
  rows: number,
): void {
  coordinator.dispatchUi({
    type: "resize",
    columns,
    rows,
    queueIdentities: coordinator.queueTrackIdentities(),
  });
}
