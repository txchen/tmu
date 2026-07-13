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

  test.each([
    ["framework-load", "HearingUtilities.framework could not be loaded"],
    ["contract-mismatch", "Required Background Sounds contract is unavailable"],
    ["unavailable", "Background Sounds is disabled by macOS"],
  ] as const)("preserves the helper's bounded %s failure", async (code, message) => {
    const control = new JxaBackgroundSoundsControl({
      run: async () => ({
        stdout: JSON.stringify({ protocolVersion: 1, ok: false, code, message }),
        stderr: "private framework diagnostics that must not escape",
      }),
      helperPath: "/helper",
    });

    await expect(control.probe()).rejects.toMatchObject({ code, message });
  });

  test("rejects an unknown failure code and an unbounded helper message", async () => {
    const control = new JxaBackgroundSoundsControl({
      run: async () => ({
        stdout: JSON.stringify({ protocolVersion: 1, ok: false, code: "private-error", message: "x".repeat(501) }),
        stderr: "",
      }),
      helperPath: "/helper",
    });

    await expect(control.read()).rejects.toMatchObject({
      code: "helper-exit",
      message: "macOS Background Sounds is unavailable.",
    });
  });

  test("maps AbortSignal cancellation without exposing the child error", async () => {
    const controller = new AbortController();
    const control = new JxaBackgroundSoundsControl({
      run: async (_executable, _args, options) => new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
      helperPath: "/helper",
    });

    const pending = control.read(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
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

  test("serializes refreshes and keeps the last confirmed snapshot after a later failure", async () => {
    let activeReads = 0;
    let maximumActiveReads = 0;
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    const control = {
      probe: vi.fn(async () => snapshot),
      read: vi.fn(async () => {
        activeReads += 1;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);
        try {
          if (control.read.mock.calls.length === 1) await firstRead;
          else throw new BackgroundSoundsError("helper-exit", "macOS stopped responding");
          return snapshot;
        } finally {
          activeReads -= 1;
        }
      }),
    };
    const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });
    await coordinator.enterBackgroundSounds();

    const first = coordinator.refreshBackgroundSounds();
    const second = coordinator.refreshBackgroundSounds();
    await vi.waitFor(() => expect(control.read).toHaveBeenCalledTimes(1));
    releaseFirstRead();
    await Promise.all([first, second]);

    expect(maximumActiveReads).toBe(1);
    expect(coordinator.appState.backgroundSounds).toEqual({
      status: "degraded",
      snapshot,
      error: "macOS stopped responding",
    });
    expect(coordinator.appState.appErrors).toEqual([]);
  });

  test("teardown cancels and waits for an in-flight Background Sounds read", async () => {
    let aborted = false;
    const control = {
      probe: vi.fn(async () => snapshot),
      read: vi.fn(async (signal?: AbortSignal) => new Promise<typeof snapshot>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new BackgroundSoundsError("cancelled", "cancelled"));
        }, { once: true });
      })),
    };
    const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });
    await coordinator.enterBackgroundSounds();
    const refresh = coordinator.refreshBackgroundSounds();
    await vi.waitFor(() => expect(control.read).toHaveBeenCalledOnce());

    await coordinator.teardown();
    await refresh;

    expect(aborted).toBe(true);
    expect(coordinator.appState.appErrors).toEqual([]);
  });
});
