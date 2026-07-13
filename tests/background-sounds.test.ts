import { describe, expect, test, vi } from "vitest";
import { createTmuApp } from "../src/app";
import {
  BackgroundSoundsError,
  JxaBackgroundSoundsControl,
  isBackgroundSoundsCandidate,
} from "../src/background-sounds";

describe("Background Sounds runtime boundary", () => {
  test.each([
    ["linux", "25.5.0", false],
    ["darwin", "24.9.0", false],
    ["darwin", "25.4.0", false],
    ["darwin", "25.5.0", true],
    ["darwin", "26.0.0", true],
    ["darwin", "not-a-version", false],
  ])("gates %s %s without probing", (platform, release, expected) => {
    expect(isBackgroundSoundsCandidate(platform, release)).toBe(expected);
  });

  test("invokes the bundled helper with fixed arguments and validates a snapshot", async () => {
    const run = vi.fn(async () => ({ stdout: JSON.stringify({
      protocolVersion: 1,
      ok: true,
      snapshot: {
        enabled: true,
        sound: { id: "Rain", label: "Rain" },
        sounds: [{ id: "Rain", label: "Rain" }, { id: "Ocean", label: "Ocean" }],
        volumePercent: 60,
      },
    }), stderr: "" }));
    const control = new JxaBackgroundSoundsControl({ run, helperPath: "/package/dist/background-sounds.jxa" });

    await expect(control.probe()).resolves.toMatchObject({ enabled: true, volumePercent: 60 });
    expect(run).toHaveBeenCalledWith(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "/package/dist/background-sounds.jxa", "probe"],
      expect.objectContaining({ timeout: expect.any(Number), maxBuffer: expect.any(Number), shell: false }),
    );
  });

  test.each([
    [{ protocolVersion: 2, ok: true, snapshot: {} }, "malformed-response"],
    [{ protocolVersion: 1, ok: true, snapshot: { enabled: true, sound: { id: "Rain", label: "Rain" }, sounds: [], volumePercent: 60 } }, "invalid-snapshot"],
    [{ protocolVersion: 1, ok: true, snapshot: { enabled: true, sound: { id: "Rain", label: "Rain" }, sounds: [{ id: "Rain", label: "Rain" }, { id: "Rain", label: "Other" }], volumePercent: 60 } }, "invalid-snapshot"],
  ])("rejects invalid helper protocol", async (envelope, code) => {
    const control = new JxaBackgroundSoundsControl({
      run: async () => ({ stdout: JSON.stringify(envelope), stderr: "" }),
      helperPath: "/helper",
    });
    await expect(control.read()).rejects.toMatchObject({ code });
  });

  test("maps bounded execution failures without leaking them globally", async () => {
    const error = Object.assign(new Error("timed out"), { killed: true });
    const control = new JxaBackgroundSoundsControl({ run: async () => { throw error; }, helperPath: "/helper" });
    await expect(control.probe()).rejects.toEqual(expect.any(BackgroundSoundsError));
    await expect(control.probe()).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("Background Sounds session lifecycle", () => {
  const snapshot = {
    enabled: false,
    sound: { id: "Rain", label: "Rain" },
    sounds: [{ id: "Rain", label: "Rain" }],
    volumePercent: 45,
  } as const;

  test("does no work at startup, probes on first entry, and reads on refresh and re-entry", async () => {
    const control = { probe: vi.fn(async () => snapshot), read: vi.fn(async () => snapshot) };
    const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });

    await coordinator.start();
    expect(control.probe).not.toHaveBeenCalled();
    expect(coordinator.appState.backgroundSounds.status).toBe("candidate");
    await coordinator.enterBackgroundSounds();
    expect(control.probe).toHaveBeenCalledOnce();
    expect(coordinator.appState.backgroundSounds).toMatchObject({ status: "ready", snapshot });
    await coordinator.refreshBackgroundSounds();
    await coordinator.enterBackgroundSounds();
    expect(control.read).toHaveBeenCalledTimes(2);
  });

  test("contains initial failure and allows retry without creating an app error", async () => {
    const control = {
      probe: vi.fn()
        .mockRejectedValueOnce(new BackgroundSoundsError("contract-mismatch", "macOS contract changed"))
        .mockResolvedValueOnce(snapshot),
      read: vi.fn(async () => snapshot),
    };
    const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });

    await coordinator.enterBackgroundSounds();
    expect(coordinator.appState.backgroundSounds).toMatchObject({ status: "unavailable", error: "macOS contract changed" });
    expect(coordinator.appState.appErrors).toEqual([]);
    await coordinator.retryBackgroundSounds();
    expect(coordinator.appState.backgroundSounds.status).toBe("ready");
  });
});
