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

  test("daemon-owned single downloads survive client disconnect while unconfirmed playlists do not", async () => {
    const executed: string[] = [];
    const cancelled: string[] = [];
    const { coordinator } = createTmuApp({
      refreshDependencyHealth: async (_helper, current) => current,
      prepareDownloadBatch: async (url) => url.includes("playlist") ? {
        kind: "confirmation-required" as const,
        confirmation: { title: "Shared Mix", itemCount: 2 },
        confirm: () => ({ sourceUrl: url, kind: "playlist" as const, entries: [] }),
        cancel: () => { cancelled.push(url); return { kind: "cancelled" as const }; },
      } : { kind: "ready" as const, batch: { sourceUrl: url, kind: "single" as const, entries: [] } },
      executeDownloadBatch: async (batch) => {
        executed.push(batch.sourceUrl);
        return { downloaded: 1, alreadyCached: 0, failed: 0, cancelled: 0, failures: [] };
      },
    });
    const daemon = new InProcessDaemonApplication(coordinator);
    await daemon.start();

    const single = await daemon.connect();
    await single.submit({ type: "intent", intent: { type: "downloadOperation", operation: "start", url: "https://youtu.be/single" } });
    single.disconnect();
    await waitFor(() => executed.includes("https://youtu.be/single"));

    const playlist = await daemon.connect();
    await playlist.submit({ type: "intent", intent: { type: "downloadOperation", operation: "start", url: "https://youtube.com/playlist?list=PL1" } });
    await waitFor(() => playlist.snapshot.state.downloads.confirmation !== undefined);
    playlist.disconnect();
    await waitFor(() => coordinator.appState.downloads.confirmation === undefined);
    expect(cancelled).toEqual(["https://youtube.com/playlist?list=PL1"]);
    expect(executed).not.toContain("https://youtube.com/playlist?list=PL1");
    await daemon.teardown();
  });

  test("confirmed playlist downloads survive their accepting client", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const executed: string[] = [];
    const url = "https://youtube.com/playlist?list=PL2";
    const { coordinator } = createTmuApp({
      refreshDependencyHealth: async (_helper, current) => current,
      prepareDownloadBatch: async () => ({
        kind: "confirmation-required", confirmation: { title: "Accepted Mix", itemCount: 3 },
        confirm: () => ({ sourceUrl: url, kind: "playlist", entries: [] }),
        cancel: () => ({ kind: "cancelled" }),
      }),
      executeDownloadBatch: async (batch) => {
        executed.push(batch.sourceUrl); await gate;
        return { downloaded: 3, alreadyCached: 0, failed: 0, cancelled: 0, failures: [] };
      },
    });
    const daemon = new InProcessDaemonApplication(coordinator); await daemon.start();
    const owner = await daemon.connect();
    const peer = await daemon.connect();
    await owner.submit({ type: "intent", intent: { type: "downloadOperation", operation: "start", url } });
    await waitFor(() => owner.snapshot.state.downloads.confirmation !== undefined);
    await expect(peer.requestChallenge({ kind: "accept-playlist", targetId: "playlist" })).rejects.toThrow("another client");
    const challenge = await owner.requestChallenge({ kind: "accept-playlist", targetId: "playlist" });
    await owner.confirmChallenge(challenge.token);
    owner.disconnect();
    await waitFor(() => executed.length === 1);
    expect(peer.snapshot.state.downloads.activeBatch?.kind).toBe("playlist");
    release();
    await waitFor(() => peer.snapshot.state.downloads.summaries.length === 1);
    await daemon.teardown();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
