import { describe, expect, test, vi } from "vitest";
import { OwnedChildRegistry } from "../src/child-ownership";
import { completeBoundedShutdown, validateOperationalStatus } from "../src/daemon-runtime";

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
});

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
