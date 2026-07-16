import { expect } from "vitest";
import type { DaemonClient, SharedCommand } from "../src/daemon-client";

export type DaemonClientContractHarness = {
  connect(): Promise<DaemonClient>;
  command(client: DaemonClient, command: SharedCommand): Promise<unknown>;
  dispose(): Promise<void>;
};

export async function exerciseDaemonClientContract(harness: DaemonClientContractHarness): Promise<void> {
  const first = await harness.connect();
  const second = await harness.connect();
  expect(first.snapshot.revision).toBeGreaterThan(0);
  expect(first.snapshot.state).toEqual(second.snapshot.state);
  expect("uiState" in first.snapshot).toBe(false);
  expect(Object.isFrozen(first.snapshot.state.playlists.playlists)).toBe(true);

  const firstFeedback: string[] = [];
  const secondFeedback: string[] = [];
  first.onFeedback((feedback) => firstFeedback.push(feedback.message));
  second.onFeedback((feedback) => secondFeedback.push(feedback.message));
  await harness.command(first, { type: "createPlaylist", name: "Study" });
  expect(firstFeedback).toContain("created Playlist Study");
  expect(secondFeedback).toEqual([]);
  expect(first.snapshot.revision).toBe(second.snapshot.revision);
  expect(first.uiState.viewedPlaylistId).not.toBe(second.uiState.viewedPlaylistId);
  first.dispatchUi({ type: "switchTab", tab: "library" });
  first.dispatchUi({ type: "setLibraryQuery", query: "private search" });
  first.dispatchUi({ type: "setDownloaderInput", value: "https://youtu.be/client-local" });
  first.dispatchUi({ type: "openOverlay", kind: "shortcut-help" });
  first.dispatchUi({ type: "setNotification", notification: { level: "success", message: "local only" } });
  expect(first.uiState.activeTab).toBe("library");
  expect(second.uiState.activeTab).toBe("playback");
  expect(first.uiState.library.query).toBe("private search");
  expect(second.uiState.library.query).toBe("");
  expect(first.uiState.downloader.urlInput).toContain("client-local");
  expect(second.uiState.downloader.urlInput).toBe("");
  expect(first.uiState.overlays).toHaveLength(1);
  expect(second.uiState.overlays).toEqual([]);
  expect(first.uiState.notification?.message).toBe("local only");
  expect(second.uiState.notification).toBeNull();

  const revisionBeforeVolume = first.snapshot.revision;
  await Promise.all([
    harness.command(first, { type: "adjustVolume", delta: -5 }),
    harness.command(second, { type: "adjustVolume", delta: -5 }),
  ]);
  expect(second.snapshot.state.volume.percent).toBe(90);
  expect(second.snapshot.revision).toBeGreaterThan(revisionBeforeVolume);

  const notices: string[] = [];
  first.onNotice((notice) => notices.push(notice.message));
  second.onNotice((notice) => notices.push(notice.message));
  await harness.command(first, { type: "broadcastNotice", message: "maintenance soon" });
  expect(notices).toEqual(["maintenance soon", "maintenance soon"]);

  const challenge = await first.requestChallenge({ kind: "delete-playlist", targetId: first.uiState.viewedPlaylistId });
  await expect(second.confirmChallenge(challenge.token)).rejects.toThrow("client");
  await first.cancelChallenge(challenge.token);
  await expect(first.confirmChallenge(challenge.token)).resolves.toMatchObject({ status: "stale-confirmation" });

  const singleUse = await first.requestChallenge({ kind: "delete-playlist", targetId: first.uiState.viewedPlaylistId });
  await harness.command(second, { type: "adjustVolume", delta: 5 });
  await expect(first.confirmChallenge(singleUse.token)).resolves.toMatchObject({ status: "success" });
  expect(first.uiState.viewedPlaylistId).toBe(first.snapshot.state.playlists.playingPlaylistId);
  expect(second.uiState.viewedPlaylistId).toBe(first.snapshot.state.playlists.playingPlaylistId);
  await expect(first.confirmChallenge(singleUse.token)).resolves.toMatchObject({ status: "stale-confirmation" });

  const accepted = harness.command(first, { type: "adjustVolume", delta: 5 });
  const abandoned = await first.requestChallenge({ kind: "shutdown-daemon", targetId: "daemon" });
  first.disconnect();
  await accepted;
  await expect(first.confirmChallenge(abandoned.token)).rejects.toThrow("disconnected");
  expect(second.snapshot.state.volume.percent).toBe(100);
  await harness.dispose();
}
