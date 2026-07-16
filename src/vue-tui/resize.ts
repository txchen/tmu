import type { TuiDaemonClient } from "../daemon-client";

export function dispatchTerminalResize(
  coordinator: TuiDaemonClient,
  columns: number,
  rows: number,
): void {
  coordinator.dispatchUi({
    type: "resize",
    columns,
    rows,
    playlistIdentities: coordinator.playlistTrackIdentities(),
  });
}
