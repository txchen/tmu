import { describe, expect, test } from "bun:test";
import {
  StatePublicationGate,
  createDefaultProviders,
  createInitialAppState,
  createInitialUiState,
  selectPublicationSnapshot,
  type PublicationTimers,
  type Track,
} from "../src/index";

class ManualTimers implements PublicationTimers {
  private time = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  now = () => this.time;

  setTimeout = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextId++;
    this.pending.set(id, { at: this.time + delayMs, callback });
    return id;
  };

  clearTimeout = (timer: unknown): void => {
    if (typeof timer === "number") this.pending.delete(timer);
  };

  advanceBy(ms: number): void {
    const target = this.time + ms;
    while (true) {
      const next = [...this.pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.pending.delete(id);
      this.time = timer.at;
      timer.callback();
    }
    this.time = target;
  }

  get count(): number {
    return this.pending.size;
  }
}

function harness(playbackCadenceMs: number | null = null) {
  const appState = createInitialAppState(createDefaultProviders());
  const uiState = createInitialUiState();
  const timers = new ManualTimers();
  const publications: Array<{ at: number; snapshot: ReturnType<typeof selectPublicationSnapshot> }> = [];
  const gate = new StatePublicationGate({
    readState: () => ({ appState, uiState }),
    cadence: {
      playbackCadenceMs,
      downloadProgressMs: 500,
      providerProgressMs: 700,
    },
    timers,
  });
  gate.subscribe((snapshot) => publications.push({ at: timers.now(), snapshot }));
  gate.publishInitial();
  return { appState, uiState, timers, publications, gate };
}

describe("StatePublicationGate", () => {
  test("publishes semantic input, resize, playback, Queue, Provider, download, and error changes immediately", () => {
    const { appState, uiState, publications, gate } = harness();

    uiState.promptInput = "m";
    gate.notify("input");
    uiState.terminal = { columns: 80, rows: 24, tier: "medium" };
    gate.notify("resize");
    appState.playback = { status: "paused", currentTrackIdentity: null };
    gate.notify("playback");
    appState.queue = { ...appState.queue, repeatAll: true };
    gate.notify("state");
    appState.providers.extra = {
      id: "extra",
      label: "Extra",
      hint: "extra Tracks",
      listVisibleTracks: () => [],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/extra" }),
    };
    gate.notify("state");
    appState.downloads = { active: true, lines: ["starting"] };
    gate.notify("state");
    appState.appErrors.push("network unavailable");
    gate.notify("state");

    expect(publications).toHaveLength(8);
    expect(publications.at(-1)?.snapshot.appState.appErrors).toEqual(["network unavailable"]);
  });

  test("suppresses equivalent snapshots and playback-position-only changes by default without timers", () => {
    const { appState, gate, publications, timers } = harness();

    gate.notify("input");
    appState.playback = { status: "playing", currentTrackIdentity: null, positionSeconds: 0 };
    gate.notify("playback");
    appState.playback = { ...appState.playback, positionSeconds: 1 };
    gate.notify("playback");

    expect(publications).toHaveLength(2);
    expect(timers.count).toBe(0);
    timers.advanceBy(60_000);
    expect(publications).toHaveLength(2);
  });

  test("publishes errors immediately and clears progress work made stale by that snapshot", () => {
    const { appState, gate, publications, timers } = harness();

    appState.downloads = { active: true, lines: ["0%"] };
    gate.notify("state");
    timers.advanceBy(100);
    appState.downloads = { active: true, lines: ["10%"] };
    appState.lastEvent = "downloaded 10%";
    gate.notify("state");
    expect(timers.count).toBe(1);

    appState.lastEvent = "download failed: network unavailable";
    gate.notify("error");

    expect(publications.map(({ at }) => at)).toEqual([0, 0, 100]);
    expect(publications.at(-1)?.snapshot.appState.lastEvent).toContain("network unavailable");
    expect(timers.count).toBe(0);
    timers.advanceBy(10_000);
    expect(publications).toHaveLength(3);
  });

  test("publishes an equivalent initial snapshot only once", () => {
    const { gate, publications } = harness();

    const first = gate.snapshot;
    const second = gate.publishInitial();

    expect(publications).toHaveLength(1);
    expect(first).not.toBeNull();
    expect(second).toBe(first!);
  });

  test("bounds configured playback cadence without adding an autonomous tick", () => {
    const { appState, gate, publications, timers } = harness(100);

    appState.playback = { status: "playing", currentTrackIdentity: null, positionSeconds: 0 };
    gate.notify("playback");
    timers.advanceBy(100);
    appState.playback = { ...appState.playback, positionSeconds: 1 };
    gate.notify("playback");
    appState.playback = { ...appState.playback, positionSeconds: 2 };
    gate.notify("playback");

    expect(publications.map(({ at }) => at)).toEqual([0, 0]);
    expect(timers.count).toBe(1);
    timers.advanceBy(399);
    expect(publications).toHaveLength(2);
    timers.advanceBy(1);
    expect(publications.map(({ at }) => at)).toEqual([0, 0, 500]);
    expect(publications.at(-1)?.snapshot.appState.playback.positionSeconds).toBe(2);
    expect(timers.count).toBe(0);
    timers.advanceBy(10_000);
    expect(publications).toHaveLength(3);
  });

  test("coalesces equivalent download and Provider progress independently", () => {
    const { appState, gate, publications, timers } = harness();
    const providerTracks: Track[] = [];
    appState.providers.local = {
      id: "local",
      label: "Local",
      hint: "files",
      listVisibleTracks: () => providerTracks,
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: identity.stableId }),
    };

    appState.downloads = { active: true, lines: ["0%"] };
    gate.notify("state");
    providerTracks.push({
      identity: { providerId: "local", stableId: "/field.flac" },
      title: "Field",
      providerLabel: "Local",
    });
    gate.notify("state");
    timers.advanceBy(100);
    appState.downloads = { active: true, lines: ["10%"] };
    gate.notify("state");
    gate.notify("state");
    providerTracks[0] = { ...providerTracks[0]!, artist: "Artist" };
    gate.notify("state");

    expect(publications.map(({ at }) => at)).toEqual([0, 0, 0]);
    expect(timers.count).toBe(2);
    timers.advanceBy(400);
    expect(publications.map(({ at }) => at)).toEqual([0, 0, 0, 500]);
    timers.advanceBy(200);
    expect(publications.map(({ at }) => at)).toEqual([0, 0, 0, 500]);
    expect(timers.count).toBe(0);
  });

  test("exposes deeply frozen readonly data snapshots through pure selectors", () => {
    const appState = createInitialAppState(createDefaultProviders());
    const uiState = createInitialUiState();
    const snapshot = selectPublicationSnapshot(appState, uiState);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.appState.queue.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.uiState.overlays)).toBe(true);
    expect(snapshot.appState.providers.local?.visibleTracks).toEqual([]);
    expect("resolvePlaybackLocator" in (snapshot.appState.providers.local ?? {})).toBe(false);

    appState.appErrors.push("later mutation");
    uiState.promptInput = "later mutation";
    expect(snapshot.appState.appErrors).toEqual([]);
    expect(snapshot.uiState.promptInput).toBe("");
  });

  test("stop cancels pending work and idle time schedules nothing", () => {
    const { appState, gate, timers, publications } = harness(500);

    appState.playback = { status: "playing", currentTrackIdentity: null, positionSeconds: 0 };
    gate.notify("playback");
    timers.advanceBy(1);
    appState.playback = { ...appState.playback, positionSeconds: 1 };
    gate.notify("playback");
    expect(timers.count).toBe(1);

    gate.stop();
    expect(timers.count).toBe(0);
    timers.advanceBy(10_000);
    expect(publications).toHaveLength(2);
  });
});
