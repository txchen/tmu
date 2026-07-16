import { describe, expect, test } from "vitest";
import { createTmuApp } from "../src/app";
import { InProcessDaemonApplication } from "../src/daemon-client";
import { exerciseDaemonClientContract } from "./daemon-client-contract";

describe("DaemonClient contract", () => {
  test("in-process adapter", async () => {
    const { coordinator } = createTmuApp();
    const daemon = new InProcessDaemonApplication(coordinator);
    await daemon.start();
    await exerciseDaemonClientContract({
      connect: () => daemon.connect(),
      command: (client, command) => client.submit(command),
      dispose: () => daemon.teardown(),
    });
  });

  test("requires challenges for every protected Shared Command", async () => {
    const { coordinator } = createTmuApp();
    const daemon = new InProcessDaemonApplication(coordinator);
    await daemon.start();
    const client = await daemon.connect();
    const protectedIntents = [
      { type: "deletePlaylist", playlistId: coordinator.appState.playlists.activePlaylistId },
      { type: "clearPlaylist" },
      { type: "cacheOperation", operation: "confirm" },
      { type: "downloadOperation", operation: "cancel-active" },
      { type: "downloadOperation", operation: "remove-pending", batchId: 1 },
      { type: "downloadOperation", operation: "confirm-playlist" },
      { type: "downloadOperation", operation: "confirm-quit" },
    ] as const;
    for (const intent of protectedIntents) {
      await expect(client.submit({ type: "intent", intent })).resolves.toMatchObject({
        status: "error", message: expect.stringContaining("Confirmation Challenge"),
      });
    }
    const kinds = ["clear-playlist", "delete-playlist", "quit-downloads", "shutdown-daemon"] as const;
    for (const kind of kinds) {
      const challenge = await client.requestChallenge({ kind, targetId: coordinator.appState.playlists.activePlaylistId });
      expect(challenge).toMatchObject({ kind, revision: client.snapshot.revision });
      await client.cancelChallenge(challenge.token);
    }
    await daemon.teardown();
  });

  test("TUI clients keep Viewed Playlist and UI State behind the client seam", async () => {
    const { coordinator } = createTmuApp();
    const daemon = new InProcessDaemonApplication(coordinator);
    await daemon.start();
    const first = await daemon.connectTui();
    const second = await daemon.connectTui();
    await first.dispatch({ type: "createPlaylist", name: "Focus" });
    first.dispatchUi({ type: "switchTab", tab: "library" });
    expect(first.viewedPlaylistId).not.toBe(second.viewedPlaylistId);
    expect(first.uiState.activeTab).toBe("library");
    expect(second.uiState.activeTab).toBe("playback");
    expect(coordinator.appState.playlists.activePlaylistId).toBe(second.viewedPlaylistId);
    await daemon.teardown();
  });

  test("challenges expire, survive unrelated revisions, execute once, and die with their client", async () => {
    let now = 1_000;
    const { coordinator } = createTmuApp();
    const daemon = new InProcessDaemonApplication(coordinator, () => now);
    await daemon.start();
    const client = await daemon.connect();
    await client.submit({ type: "createPlaylist", name: "Disposable" });
    const disposableId = client.uiState.viewedPlaylistId;
    const expiring = await client.requestChallenge({ kind: "delete-playlist", targetId: disposableId });
    now = expiring.expiresAt;
    await expect(client.confirmChallenge(expiring.token)).resolves.toMatchObject({ status: "stale-confirmation" });

    const valid = await client.requestChallenge({ kind: "delete-playlist", targetId: disposableId });
    await client.submit({ type: "adjustVolume", delta: -5 });
    await expect(client.confirmChallenge(valid.token)).resolves.toMatchObject({ status: "success" });
    await expect(client.confirmChallenge(valid.token)).resolves.toMatchObject({ status: "stale-confirmation" });

    const abandoned = await client.requestChallenge({ kind: "shutdown-daemon", targetId: "daemon" });
    client.disconnect();
    await expect(client.confirmChallenge(abandoned.token)).rejects.toThrow("disconnected");
    await daemon.teardown();
  });
});
