import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createTmuApp } from "../src/app";
import { InProcessDaemonApplication } from "../src/daemon-client";
import { DAEMON_PROTOCOL_VERSION } from "../src/daemon-protocol";
import { resolveDaemonPaths, UnixDaemonClient, UnixDaemonServer } from "../src/daemon-runtime";
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
      .rejects.toThrow("protocol mismatch");
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
