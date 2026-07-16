import { describe, expect, test, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { OwnedChildRegistry, readProcessIdentity } from "../src/child-ownership";
import { completeBoundedShutdown, recoverUnexpectedDaemonExit, resolveDaemonPaths, validateOperationalStatus } from "../src/daemon-runtime";

function child(pid: number) {
  return { pid, exitCode: null as number | null, kill: vi.fn(() => true), once: vi.fn() };
}

describe("verified daemon child cleanup", () => {
  test("terminates only a still-running owned child with the same process identity", () => {
    const identities = new Map([[10, "start-a"], [11, "start-b"]]);
    const registry = new OwnedChildRegistry((pid) => identities.get(pid) ?? null);
    const owned = child(10); const recycled = child(11);
    registry.register(owned, "mpv"); registry.register(recycled, "yt-dlp");
    identities.set(11, "recycled-start");

    expect(registry.terminateVerified()).toEqual({ terminated: [10], refused: [11] });
    expect(owned.kill).toHaveBeenCalledWith("SIGKILL");
    expect(recycled.kill).not.toHaveBeenCalled();
  });

  test("grace expiry closes client handles before a bounded failed final persistence attempt", async () => {
    const registry = new OwnedChildRegistry(() => null);
    const events: string[] = [];
    const result = await completeBoundedShutdown({
      cleanup: new Promise<void>(() => undefined), ownedChildren: registry, graceMs: 5, finalPersistenceMs: 5,
      forceClose: async () => { events.push("clients-closed"); },
      finalPersistence: async () => new Promise<void>(() => undefined),
    });
    expect(result).toMatchObject({ clean: false, exitCode: 1, timedOut: true, persistenceFailed: true });
    expect(events).toEqual(["clients-closed"]);
  });

  test("reports an explicit persistence rejection as a non-clean shutdown", async () => {
    const result = await completeBoundedShutdown({ cleanup: Promise.reject(new Error("cleanup failed")),
      forceClose: async () => undefined, finalPersistence: async () => { throw new Error("disk full"); } });
    expect(result).toMatchObject({ clean: false, exitCode: 1, timedOut: false, persistenceFailed: true });
  });

  test("recovers only verified orphan children and recognized temporary downloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmu-recovery-test-"));
    try {
      await mkdir(join(root, "run"), { mode: 0o700 });
      const paths = await resolveDaemonPaths({ XDG_RUNTIME_DIR: join(root, "run"), XDG_STATE_HOME: join(root, "state") });
      const cache = join(root, "cache"); await mkdir(cache);
      await mkdir(join(cache, ".partial-track"));
      await writeFile(join(cache, "complete.opus"), "complete");
      await writeFile(join(cache, "complete.json"), "{}");
      await writeFile(paths.metadataPath, JSON.stringify({ version: 1, daemon: { pid: 10, identity: "old-daemon" }, children: [
        { pid: 11, kind: "mpv", identity: "old-mpv" }, { pid: 12, kind: "yt-dlp", identity: "old-download" },
      ] }));
      const identities = new Map([[11, "old-mpv"], [12, "recycled-download"]]); const killed: number[] = [];
      const result = await recoverUnexpectedDaemonExit(paths, { cacheDirectory: cache,
        readIdentity: (pid) => identities.get(pid) ?? null, kill: (pid) => { killed.push(pid); } });
      expect(result).toMatchObject({ recovered: true, terminated: [11], refused: [12], removedTemporaryEntries: 1 });
      expect(killed).toEqual([11]);
      expect(await import("node:fs/promises").then(({ readdir }) => readdir(cache))).toEqual(["complete.json", "complete.opus"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("terminates a real verified orphan helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmu-real-recovery-test-"));
    const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await mkdir(join(root, "run"), { mode: 0o700 });
      const paths = await resolveDaemonPaths({ XDG_RUNTIME_DIR: join(root, "run"), XDG_STATE_HOME: join(root, "state") });
      const identity = await waitForIdentity(helper.pid!);
      await writeFile(paths.metadataPath, JSON.stringify({ version: 1, daemon: { pid: 999_999_999, identity: "gone" },
        children: [{ pid: helper.pid, kind: "yt-dlp", identity }] }));
      const exited = new Promise<void>((resolve) => helper.once("exit", () => resolve()));
      expect(await recoverUnexpectedDaemonExit(paths, { cacheDirectory: join(root, "cache") }))
        .toMatchObject({ terminated: [helper.pid], refused: [] });
      await Promise.race([exited, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("orphan remained alive")), 2_000))]);
    } finally { if (helper.exitCode === null) helper.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
  });
});

async function waitForIdentity(pid: number): Promise<string> {
  for (let index = 0; index < 100; index += 1) {
    const identity = readProcessIdentity(pid); if (identity) return identity;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("real helper identity was unavailable");
}

describe("minimal control response validation", () => {
  const valid = {
    controlProtocolVersion: 1, protocolVersion: 99, daemonVersion: "old-version", pid: 42, uptimeMs: 10,
    lifecycle: "ready", runtimePath: "/run/tmu", logPath: "/state/tmu/daemon.log", clientCount: 1,
    playingPlaylist: "Default", currentTrack: null, playbackStatus: "idle", activeDownloads: 0, pendingDownloads: 0,
    configPath: "/config/tmu/config.json", configSource: "defaults", recoveryState: "normal", latestSevereError: null,
    impact: "no playback",
  } as const;

  test("accepts a status independently of the normal protocol integer", () => {
    expect(validateOperationalStatus(valid)).toMatchObject({ protocolVersion: 99, controlProtocolVersion: 1 });
  });

  test.each([
    [{ ...valid, pid: "42" }, "pid"],
    [{ ...valid, lifecycle: "unknown" }, "lifecycle"],
    [{ ...valid, currentTrack: 7 }, "currentTrack"],
    [{ ...valid, surprise: true }, "surprise"],
  ])("rejects malformed control status %#", (value, field) => {
    expect(() => validateOperationalStatus(value)).toThrow(field);
  });
});
