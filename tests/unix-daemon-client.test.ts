import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { createTmuApp } from "../src/app";
import { InProcessDaemonApplication } from "../src/daemon-client";
import { DAEMON_PROTOCOL_VERSION, encodeFrame, FrameDecoder } from "../src/daemon-protocol";
import { DaemonProtocolMismatchError, resolveDaemonPaths, UnixDaemonClient, UnixDaemonServer } from "../src/daemon-runtime";
import { exerciseDaemonClientContract } from "./daemon-client-contract";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function foregroundDaemon() {
  const root = await mkdtemp(join(tmpdir(), "tmu-unix-daemon-test-")); roots.push(root);
  await mkdir(join(root, "run"), { mode: 0o700 });
  const paths = await resolveDaemonPaths({ XDG_RUNTIME_DIR: join(root, "run"), XDG_STATE_HOME: join(root, "state") });
  const { coordinator } = createTmuApp();
  const application = new InProcessDaemonApplication(coordinator);
  await application.start();
  const server = new UnixDaemonServer(application, paths);
  await server.listen();
  return { paths, server };
}

describe("Unix-socket DaemonClient", () => {
  test("passes the reusable DaemonClient contract", async () => {
    const { paths, server } = await foregroundDaemon();
    await exerciseDaemonClientContract({
      connect: () => UnixDaemonClient.connect(paths.socketPath),
      command: (client, command) => client.submit(command),
      dispose: () => server.close(),
    });
  });

  test("requires an exact protocol integer", async () => {
    const { paths, server } = await foregroundDaemon();
    await expect(UnixDaemonClient.connect(paths.socketPath, { protocolVersion: DAEMON_PROTOCOL_VERSION + 1 }))
      .rejects.toBeInstanceOf(DaemonProtocolMismatchError);
    await server.close();
  });

  test("disconnects only a persistently slow client and keeps peers converging", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmu-slow-client-test-")); roots.push(root);
    await mkdir(join(root, "run"), { mode: 0o700 });
    const paths = await resolveDaemonPaths({ XDG_RUNTIME_DIR: join(root, "run"), XDG_STATE_HOME: join(root, "state") });
    const { coordinator } = createTmuApp();
    const application = new InProcessDaemonApplication(coordinator); await application.start();
    const server = new UnixDaemonServer(application, paths, { maxOutboundBytes: 8_192 }); await server.listen();
    const healthy = await UnixDaemonClient.connect(paths.socketPath);
    const slow = createConnection(paths.socketPath);
    const decoder = new FrameDecoder();
    await new Promise<void>((resolve, reject) => {
      slow.once("error", reject);
      slow.once("connect", () => slow.write(encodeFrame({
        type: "hello", protocolVersion: DAEMON_PROTOCOL_VERSION, clientVersion: "test", clientIdentity: "slow-client",
      })));
      slow.on("data", function ready(chunk) {
        for (const message of decoder.push(chunk)) {
          if ((message as { type?: string }).type === "welcome") {
            slow.off("data", ready); slow.pause(); resolve(); return;
          }
        }
      });
    });
    const closed = new Promise<void>((resolve) => slow.once("close", () => resolve()));
    const payload = "x".repeat(4_096);
    for (let index = 0; index < 200; index += 1) {
      await healthy.submit({ type: "broadcastNotice", message: `${index}:${payload}` });
      if (slow.destroyed) break;
    }
    slow.resume();
    await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("slow client remained connected")), 2_000))]);
    await expect(healthy.submit({ type: "adjustVolume", delta: -5 })).resolves.toMatchObject({ status: "success" });
    expect(healthy.snapshot.state.volume.percent).toBe(95);
    healthy.disconnect();
    await server.close();
  }, 10_000);

  test("shares daemon-owned downloads across socket clients after the submitter exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmu-shared-download-test-")); roots.push(root);
    await mkdir(join(root, "run"), { mode: 0o700 });
    const paths = await resolveDaemonPaths({ XDG_RUNTIME_DIR: join(root, "run"), XDG_STATE_HOME: join(root, "state") });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { coordinator } = createTmuApp({
      refreshDependencyHealth: async (_helper, current) => current,
      prepareDownloadBatch: async (url) => ({ kind: "ready", batch: { sourceUrl: url, kind: "single", entries: [] } }),
      executeDownloadBatch: async () => {
        await gate;
        return { downloaded: 1, alreadyCached: 0, failed: 0, cancelled: 0, failures: [] };
      },
    });
    const application = new InProcessDaemonApplication(coordinator); await application.start();
    const server = new UnixDaemonServer(application, paths); await server.listen();
    const submitter = await UnixDaemonClient.connect(paths.socketPath);
    const observer = await UnixDaemonClient.connect(paths.socketPath);
    await submitter.submit({
      type: "intent", intent: { type: "downloadOperation", operation: "start", url: "https://youtu.be/shared" },
    });
    submitter.disconnect();
    await waitFor(() => observer.snapshot.state.downloads.activeBatch?.sourceUrl === "https://youtu.be/shared");
    release();
    await waitFor(() => observer.snapshot.state.downloads.summaries.length === 1);
    expect(observer.snapshot.state.downloads.summaries[0]).toMatchObject({ downloaded: 1 });
    observer.disconnect();
    await server.close();
  });

  test("rejects malformed Shared Commands without ending the connection", async () => {
    const { paths, server } = await foregroundDaemon();
    const client = await UnixDaemonClient.connect(paths.socketPath);
    const playlistCount = client.snapshot.state.playlists.playlists.length;
    await expect(client.submit({ type: "createPlaylist", name: 42 } as never)).rejects.toThrow("Invalid daemon message");
    await expect(client.submit({ type: "intent", intent: { type: "playSelected", identity: { providerId: "youtube-cache" } } } as never))
      .rejects.toThrow("Invalid daemon message");
    await expect(client.submit({ type: "intent", intent: { type: "clearPlaylist", unexpected: true } } as never))
      .rejects.toThrow("Invalid daemon message");
    expect(client.snapshot.state.playlists.playlists).toHaveLength(playlistCount);
    await expect(client.submit({ type: "adjustVolume", delta: -5 })).resolves.toMatchObject({ status: "success" });
    client.disconnect();
    await server.close();
  });

  test("creates private runtime and socket paths", async () => {
    const { paths, server } = await foregroundDaemon();
    expect((await lstat(paths.runtimeDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.socketPath)).mode & 0o777).toBe(0o600);
    await server.close();
  });

  test("does not trust an unsafe XDG runtime directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmu-unsafe-runtime-test-")); roots.push(root);
    const unsafe = join(root, "unsafe"); await mkdir(unsafe, { mode: 0o777 }); await chmod(unsafe, 0o777);
    const paths = await resolveDaemonPaths({ XDG_RUNTIME_DIR: unsafe, XDG_STATE_HOME: join(root, "state") });
    expect(paths.runtimeDirectory.startsWith(unsafe)).toBe(false);
  });

  test("refuses to replace a non-socket runtime entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmu-unsafe-socket-test-")); roots.push(root);
    await mkdir(join(root, "run"), { mode: 0o700 });
    const paths = await resolveDaemonPaths({ XDG_RUNTIME_DIR: join(root, "run"), XDG_STATE_HOME: join(root, "state") });
    await writeFile(paths.socketPath, "do not replace");
    const { coordinator } = createTmuApp();
    const application = new InProcessDaemonApplication(coordinator); await application.start();
    const server = new UnixDaemonServer(application, paths);
    await expect(server.listen()).rejects.toThrow("unsafe TMU socket");
    await application.teardown();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
