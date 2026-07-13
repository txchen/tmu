import { describe, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createTmuApp } from "../src/app";
import {
  BackgroundSoundsError,
  JxaBackgroundSoundsControl,
  isBackgroundSoundsCandidate,
  type BackgroundSoundsSnapshot,
} from "../src/background-sounds";

describe("Background Sounds runtime boundary", () => {
  test.each([
    "comfortSoundsAvailable", "comfortSoundsEnabled", "setComfortSoundsEnabled:",
    "selectedComfortSound", "setSelectedComfortSound:", "relativeVolume", "setRelativeVolume:",
  ])("bundled helper rejects a missing %s selector", async (missingSelector) => {
    const response = await runBundledHelper({ missingSelector });
    expect(response).toMatchObject({ protocolVersion: 1, ok: false, code: "contract-mismatch" });
  });

  test("bundled helper rejects macOS when Background Sounds is unavailable", async () => {
    const response = await runBundledHelper({ available: false });
    expect(response).toMatchObject({ protocolVersion: 1, ok: false, code: "unavailable" });
  });

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

  test("setters pass validated fixed arguments and return the authoritative confirmed snapshot", async () => {
    const confirmed = {
      enabled: false,
      sound: { id: "Ocean", label: "Ocean" },
      sounds: [{ id: "Rain", label: "Rain" }, { id: "Ocean", label: "Ocean" }],
      volumePercent: 55,
    };
    const run = vi.fn(async () => ({ stdout: JSON.stringify({ protocolVersion: 1, ok: true, snapshot: confirmed }), stderr: "" }));
    const control = new JxaBackgroundSoundsControl({ run, helperPath: "/helper" });

    await expect(control.setSound("Ocean")).resolves.toEqual(confirmed);
    expect(run).toHaveBeenLastCalledWith("/usr/bin/osascript",
      ["-l", "JavaScript", "/helper", "set-sound", JSON.stringify("Ocean")], expect.any(Object));
    await expect(control.setVolume(55)).resolves.toEqual(confirmed);
    await expect(control.setEnabled(false)).resolves.toEqual(confirmed);
  });

  test("rejects an authoritative apply mismatch", async () => {
    const snapshot = { enabled: false, sound: { id: "Rain", label: "Rain" }, sounds: [{ id: "Rain", label: "Rain" }], volumePercent: 45 };
    const control = new JxaBackgroundSoundsControl({
      run: async () => ({ stdout: JSON.stringify({ protocolVersion: 1, ok: true, snapshot }), stderr: "" }),
      helperPath: "/helper",
    });
    await expect(control.setEnabled(true)).rejects.toMatchObject({ code: "apply-mismatch" });
    await expect(control.setSound("Ocean")).rejects.toMatchObject({ code: "apply-mismatch" });
    await expect(control.setVolume(50)).rejects.toMatchObject({ code: "apply-mismatch" });
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

async function runBundledHelper(options: { missingSelector?: string; available?: boolean }): Promise<Record<string, unknown>> {
  const source = await readFile(new URL("../src/background-sounds.jxa", import.meta.url), "utf8");
  const required = new Set([
    "comfortSoundsAvailable", "comfortSoundsEnabled", "setComfortSoundsEnabled:",
    "selectedComfortSound", "setSelectedComfortSound:", "relativeVolume", "setRelativeVolume:",
  ]);
  const settings = {
    comfortSoundsAvailable: options.available ?? true,
    respondsToSelector: (selector: string) => required.has(selector) && selector !== options.missingSelector,
  };
  const dollar = Object.assign((_value: unknown) => ({}), {
    NSSelectorFromString: (selector: string) => selector,
    NSBundle: { bundleWithPath: () => ({ load: true }) },
    NSClassFromString: (name: string) => name === "HUComfortSoundsSettings" ? { sharedInstance: settings } : null,
  });
  const context: {
    ObjC: { import: () => undefined; unwrap: (value: unknown) => unknown };
    $: typeof dollar;
    __result?: string;
  } = {
    ObjC: { import: () => undefined, unwrap: (value: unknown) => value },
    $: dollar,
  };
  runInNewContext(`${source}\nglobalThis.__result = run(["probe"]);`, context);
  return JSON.parse(context.__result!) as Record<string, unknown>;
}

describe("Background Sounds session lifecycle", () => {
  const snapshot: BackgroundSoundsSnapshot = {
    enabled: false,
    sound: { id: "Rain", label: "Rain" },
    sounds: [{ id: "Rain", label: "Rain" }],
    volumePercent: 45,
  };

  test("does no work at startup, probes on first entry, and reads on refresh and re-entry", async () => {
    const control = mutableControl(snapshot);
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
      setEnabled: vi.fn(async () => snapshot), setSound: vi.fn(async () => snapshot), setVolume: vi.fn(async () => snapshot),
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
      setEnabled: vi.fn(async () => snapshot), setSound: vi.fn(async () => snapshot), setVolume: vi.fn(async () => snapshot),
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
      setEnabled: vi.fn(async () => snapshot), setSound: vi.fn(async () => snapshot), setVolume: vi.fn(async () => snapshot),
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

  test("serializes authoritative enabled and sound mutations without changing unrelated values", async () => {
    const ocean = { ...snapshot, sound: { id: "Ocean", label: "Ocean" }, sounds: [...snapshot.sounds, { id: "Ocean", label: "Ocean" }] };
    const enabled = { ...ocean, enabled: true };
    const calls: string[] = [];
    const control = {
      ...mutableControl(ocean),
      setEnabled: vi.fn(async (value: boolean) => { calls.push(`enabled:${value}`); return enabled; }),
      setSound: vi.fn(async (id: string) => { calls.push(`sound:${id}`); return { ...enabled, sound: ocean.sounds[0]! }; }),
    };
    const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });
    const playerAndPersistenceState = JSON.stringify({ playback: coordinator.appState.playback, volume: coordinator.appState.volume, playlists: coordinator.appState.playlists });
    await coordinator.enterBackgroundSounds();
    await coordinator.setBackgroundSoundsEnabled(true);
    await coordinator.cycleBackgroundSound(1);

    expect(calls).toEqual(["enabled:true", "sound:Rain"]);
    expect(coordinator.appState.backgroundSounds).toMatchObject({ status: "ready", snapshot: { enabled: true, volumePercent: 45 } });
    expect(JSON.stringify({ playback: coordinator.appState.playback, volume: coordinator.appState.volume, playlists: coordinator.appState.playlists })).toBe(playerAndPersistenceState);
  });

  test("orders a refresh after a mutation and recovers from a failed write with the last confirmed snapshot", async () => {
    let releaseMutation!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const calls: string[] = [];
    const control = {
      ...mutableControl(snapshot),
      setEnabled: vi.fn(async () => { calls.push("set:start"); await blocked; calls.push("set:end"); throw new BackgroundSoundsError("helper-exit", "write failed"); }),
      read: vi.fn(async () => { calls.push("read"); return snapshot; }),
    };
    const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });
    await coordinator.enterBackgroundSounds();

    const mutation = coordinator.setBackgroundSoundsEnabled(true);
    const refresh = coordinator.refreshBackgroundSounds();
    await vi.waitFor(() => expect(calls).toEqual(["set:start"]));
    releaseMutation();
    await Promise.all([mutation, refresh]);

    expect(calls).toEqual(["set:start", "set:end", "read"]);
    expect(coordinator.appState.backgroundSounds).toEqual({ status: "ready", snapshot });
  });

  test("failed volume write discards its pending draft and leaves confirmed state stale until retry", async () => {
    vi.useFakeTimers();
    try {
      const control = mutableControl(snapshot);
      control.setVolume.mockRejectedValue(new BackgroundSoundsError("helper-exit", "volume write failed"));
      const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });
      await coordinator.enterBackgroundSounds();
      coordinator.adjustBackgroundSoundsVolume(1);
      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() => expect(coordinator.uiState.background.pendingVolumePercent).toBeNull());
      expect(coordinator.appState.backgroundSounds).toEqual({ status: "degraded", snapshot, error: "volume write failed" });
      await coordinator.retryBackgroundSounds();
      expect(coordinator.appState.backgroundSounds).toEqual({ status: "ready", snapshot });
    } finally {
      vi.useRealTimers();
    }
  });

  test("coalesces rapid five-point volume changes into one final authoritative write", async () => {
    vi.useFakeTimers();
    try {
      const control = mutableControl(snapshot);
      control.setVolume.mockImplementation(async (percent) => ({ ...snapshot, volumePercent: percent }));
      const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });
      await coordinator.enterBackgroundSounds();

      coordinator.adjustBackgroundSoundsVolume(1);
      coordinator.adjustBackgroundSoundsVolume(1);
      coordinator.adjustBackgroundSoundsVolume(-1);
      expect(coordinator.uiState.background.pendingVolumePercent).toBe(50);
      await vi.advanceTimersByTimeAsync(150);
      await vi.waitFor(() => expect(control.setVolume).toHaveBeenCalledOnce());

      expect(control.setVolume).toHaveBeenCalledWith(50, expect.any(AbortSignal));
      expect(coordinator.appState.backgroundSounds).toMatchObject({ status: "ready", snapshot: { volumePercent: 50 } });
      expect(coordinator.uiState.background.pendingVolumePercent).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  function mutableControl(value: BackgroundSoundsSnapshot) {
    return {
      probe: vi.fn(async () => value), read: vi.fn(async () => value),
      setEnabled: vi.fn(async (_enabled: boolean) => value),
      setSound: vi.fn(async (_id: string) => value),
      setVolume: vi.fn(async (_percent: number) => value),
    };
  }
});
