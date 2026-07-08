import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  AppCoordinator,
  MemoryQueue,
  NoopPlayer,
  RenderScheduler,
  TerminalTui,
  createInitialAppState,
  createInitialUiState,
  createDefaultProviders,
  intentFromKey,
  type RenderSchedulerTimers,
} from "../src/index";

class FakeInput extends EventEmitter {
  isTTY = true;
  rawMode = false;
  resumed = false;

  setRawMode(enabled: boolean) {
    this.rawMode = enabled;
  }

  resume() {
    this.resumed = true;
  }
}

class FakeOutput {
  isTTY = true;
  readonly chunks: string[] = [];

  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
}

class ManualTimers implements RenderSchedulerTimers {
  private nowMs = 0;
  private nextTimerId = 1;
  private readonly timers = new Map<number, { dueAt: number; callback: () => void }>();

  now = (): number => {
    return this.nowMs;
  };

  setTimeout = (callback: () => void, delayMs: number): unknown => {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers.set(id, {
      dueAt: this.nowMs + Math.max(0, delayMs),
      callback,
    });
    return id;
  };

  clearTimeout = (timer: unknown): void => {
    if (typeof timer === "number") this.timers.delete(timer);
  };

  advanceBy(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
      if (!next) break;

      const [id, timer] = next;
      this.nowMs = timer.dueAt;
      this.timers.delete(id);
      timer.callback();
    }
    this.nowMs = target;
  }
}

describe("intentFromKey", () => {
  test("maps playback control keys to App Coordinator intents", () => {
    expect(intentFromKey(" ")).toEqual({ type: "togglePlayPause" });
    expect(intentFromKey("s")).toEqual({ type: "stop" });
    expect(intentFromKey("n")).toEqual({ type: "nextTrack" });
    expect(intentFromKey("p")).toEqual({ type: "previousTrack" });
    expect(intentFromKey("[")).toEqual({ type: "seekBy", seconds: -5 });
    expect(intentFromKey("]")).toEqual({ type: "seekBy", seconds: 5 });
    expect(intentFromKey("-")).toEqual({ type: "adjustVolume", delta: -5 });
    expect(intentFromKey("+")).toEqual({ type: "adjustVolume", delta: 5 });
  });

  test("maps local open key to the Local Provider Browsing Surface prompt", () => {
    expect(intentFromKey("o")).toEqual({ type: "openLocalPathPrompt" });
    expect(intentFromKey("\x1b")).toEqual({ type: "cancelLocalOpen" });
  });

  test("maps Provider Browsing Surface action keys", () => {
    expect(intentFromKey("\r")).toEqual({ type: "activateSelectedContent" });
    expect(intentFromKey("a")).toEqual({ type: "enqueueSelectedTrack" });
    expect(intentFromKey("f")).toEqual({ type: "refreshNavidromeLibrary" });
    expect(intentFromKey("/")).toEqual({ type: "openNavidromeSearchPrompt" });
  });
});

describe("RenderScheduler", () => {
  function createSchedulerHarness(lowPower = {
    playbackTickMs: 500,
    downloadProgressThrottleMs: 500,
    providerProgressThrottleMs: 700,
  }) {
    const appState = createInitialAppState(createDefaultProviders(), {
      config: {
        lowPower,
      },
    });
    const uiState = createInitialUiState();
    const timers = new ManualTimers();
    const renderTimes: number[] = [];
    const scheduler = new RenderScheduler({
      render: () => renderTimes.push(timers.now()),
      readState: () => ({ appState, uiState }),
      cadence: appState.config.lowPower,
      timers,
    });

    scheduler.start();
    return { appState, uiState, timers, renderTimes, scheduler };
  }

  test("requests an immediate redraw for user input", () => {
    const { scheduler, renderTimes } = createSchedulerHarness();

    scheduler.requestInputRedraw();

    expect(renderTimes).toEqual([0]);
  });

  test("requests an immediate redraw for App State and UI State changes", () => {
    const { appState, uiState, scheduler, renderTimes } = createSchedulerHarness();

    appState.lastEvent = "changed App State";
    scheduler.requestStateRedraw();
    uiState.focusedPane = "queue";
    scheduler.requestStateRedraw();

    expect(renderTimes).toEqual([0, 0]);
  });

  test("coalesces playback-position events at the playback cadence", () => {
    const { appState, scheduler, renderTimes, timers } = createSchedulerHarness();

    appState.playback = {
      ...appState.playback,
      status: "playing",
      positionSeconds: 0,
    };
    scheduler.requestStateRedraw();

    timers.advanceBy(100);
    appState.playback = {
      ...appState.playback,
      positionSeconds: 1,
    };
    scheduler.requestStateRedraw();
    timers.advanceBy(398);

    expect(renderTimes).toEqual([0]);

    appState.playback = {
      ...appState.playback,
      positionSeconds: 2,
    };
    scheduler.requestStateRedraw();

    expect(renderTimes).toEqual([0]);

    timers.advanceBy(1);

    expect(renderTimes).toEqual([0]);

    timers.advanceBy(1);

    expect(renderTimes).toEqual([0, 500]);

    timers.advanceBy(499);

    expect(renderTimes).toEqual([0, 500]);

    timers.advanceBy(1);
    appState.playback = {
      ...appState.playback,
      positionSeconds: 3,
    };
    scheduler.requestStateRedraw();

    expect(renderTimes).toEqual([0, 500, 1000]);
  });

  test("resumes fallback playback ticks after position events stop", () => {
    const { appState, scheduler, renderTimes, timers } = createSchedulerHarness();

    appState.playback = {
      ...appState.playback,
      status: "playing",
      positionSeconds: 0,
    };
    scheduler.requestStateRedraw();
    timers.advanceBy(100);
    appState.playback = {
      ...appState.playback,
      positionSeconds: 1,
    };
    scheduler.requestStateRedraw();
    timers.advanceBy(399);

    expect(renderTimes).toEqual([0]);

    timers.advanceBy(1);

    expect(renderTimes).toEqual([0, 500]);

    timers.advanceBy(499);

    expect(renderTimes).toEqual([0, 500]);

    timers.advanceBy(1);

    expect(renderTimes).toEqual([0, 500, 1000]);
  });

  test("clamps configured cadences to the low-power maximum redraw rate", () => {
    const { appState, scheduler, renderTimes, timers } = createSchedulerHarness({
      playbackTickMs: 50,
      downloadProgressThrottleMs: 50,
      providerProgressThrottleMs: 50,
    });

    appState.playback = {
      ...appState.playback,
      status: "playing",
    };
    scheduler.requestStateRedraw();
    timers.advanceBy(499);

    expect(renderTimes).toEqual([0]);

    timers.advanceBy(1);

    expect(renderTimes).toEqual([0, 500]);

    const progressHarness = createSchedulerHarness({
      playbackTickMs: 50,
      downloadProgressThrottleMs: 50,
      providerProgressThrottleMs: 50,
    });

    progressHarness.appState.downloads = {
      active: true,
      lines: ["0%"],
    };
    progressHarness.scheduler.requestStateRedraw();
    progressHarness.timers.advanceBy(100);
    progressHarness.appState.downloads = {
      active: true,
      lines: ["10%"],
    };
    progressHarness.appState.lastEvent = "downloaded 10%";
    progressHarness.scheduler.requestStateRedraw();

    expect(progressHarness.renderTimes).toEqual([0]);

    progressHarness.timers.advanceBy(100);
    progressHarness.appState.downloads = {
      active: true,
      lines: ["20%"],
    };
    progressHarness.appState.lastEvent = "downloaded 20%";
    progressHarness.scheduler.requestStateRedraw();
    progressHarness.timers.advanceBy(399);

    expect(progressHarness.renderTimes).toEqual([0, 500]);

    progressHarness.timers.advanceBy(1);

    expect(progressHarness.renderTimes).toEqual([0, 500]);
  });

  test("does not fire a stale playback tick sooner than the cadence after another redraw", () => {
    const { appState, scheduler, renderTimes, timers } = createSchedulerHarness();

    appState.playback = {
      ...appState.playback,
      status: "playing",
    };
    scheduler.requestStateRedraw();
    timers.advanceBy(400);
    appState.lastEvent = "redrew before the pending playback tick";
    scheduler.requestStateRedraw();
    timers.advanceBy(99);

    expect(renderTimes).toEqual([0, 400]);

    timers.advanceBy(1);

    expect(renderTimes).toEqual([0, 400]);

    timers.advanceBy(400);

    expect(renderTimes).toEqual([0, 400, 900]);
  });

  test("stops playback ticks while paused or idle", () => {
    const { appState, scheduler, renderTimes, timers } = createSchedulerHarness();

    appState.playback = {
      ...appState.playback,
      status: "playing",
    };
    scheduler.requestStateRedraw();
    timers.advanceBy(500);
    appState.playback = {
      ...appState.playback,
      status: "paused",
    };
    scheduler.requestStateRedraw();
    timers.advanceBy(1000);

    expect(renderTimes).toEqual([0, 500, 500]);

    appState.playback = {
      ...appState.playback,
      status: "playing",
    };
    scheduler.requestStateRedraw();
    timers.advanceBy(500);
    appState.playback = {
      ...appState.playback,
      status: "idle",
    };
    scheduler.requestStateRedraw();
    timers.advanceBy(1000);

    expect(renderTimes).toEqual([0, 500, 500, 1500, 2000, 2000]);
  });

  test("throttles download and Provider progress redraws independently", () => {
    const { appState, scheduler, renderTimes, timers } = createSchedulerHarness();
    const queuedTrack = {
      identity: { providerId: "local", stableId: "/music/field.flac" },
      title: "Field",
      providerLabel: "Local",
    };

    appState.downloads = {
      active: true,
      lines: ["0%"],
    };
    scheduler.requestStateRedraw();
    timers.advanceBy(100);
    appState.downloads = {
      active: true,
      lines: ["10%"],
    };
    appState.lastEvent = "downloaded 10%";
    scheduler.requestStateRedraw();
    timers.advanceBy(100);
    appState.downloads = {
      active: true,
      lines: ["20%"],
    };
    appState.lastEvent = "downloaded 20%";
    scheduler.requestStateRedraw();
    timers.advanceBy(99);

    expect(renderTimes).toEqual([0]);

    timers.advanceBy(1);
    appState.lastEvent = "meaningful state change";
    scheduler.requestStateRedraw();
    timers.advanceBy(299);

    expect(renderTimes).toEqual([0, 300]);

    timers.advanceBy(1);
    appState.queue = {
      ...appState.queue,
      entries: [{ track: queuedTrack, availability: { status: "available" } }],
    };
    scheduler.requestStateRedraw();
    timers.advanceBy(100);
    appState.queue = {
      ...appState.queue,
      entries: [{
        track: { ...queuedTrack, title: "Tagged Field" },
        availability: { status: "available" },
      }],
    };
    appState.lastEvent = "updated metadata for Tagged Field";
    scheduler.requestStateRedraw();
    timers.advanceBy(100);
    appState.queue = {
      ...appState.queue,
      entries: [{
        track: { ...queuedTrack, title: "Tagged Field", artist: "Artist" },
        availability: { status: "available" },
      }],
    };
    appState.lastEvent = "updated metadata for Tagged Field";
    scheduler.requestStateRedraw();
    timers.advanceBy(600);

    expect(renderTimes).toEqual([0, 300, 600, 1300]);
  });

  test("redraws download lifecycle and Provider list changes immediately", () => {
    const { appState, scheduler, renderTimes, timers } = createSchedulerHarness();
    const providerTrack = {
      identity: { providerId: "local", stableId: "/music/new.flac" },
      title: "New Track",
      providerLabel: "Local",
    };
    let visibleTracks: typeof providerTrack[] = [];
    appState.providers.local = {
      id: "local",
      label: "Local",
      hint: "files and folders",
      listVisibleTracks: () => visibleTracks,
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: identity.stableId }),
    };

    appState.downloads = {
      active: true,
      lines: ["10%"],
    };
    appState.lastEvent = "downloaded 10%";
    scheduler.requestStateRedraw();
    timers.advanceBy(100);
    appState.downloads = {
      active: false,
      lines: ["complete"],
    };
    appState.lastEvent = "download complete";
    scheduler.requestStateRedraw();

    expect(renderTimes).toEqual([0, 100]);

    timers.advanceBy(100);
    visibleTracks = [providerTrack];
    scheduler.requestStateRedraw();

    expect(renderTimes).toEqual([0, 100, 200]);

    timers.advanceBy(100);
    visibleTracks = [{ ...providerTrack, title: "Tagged New Track" }];
    appState.lastEvent = "updated metadata for Tagged New Track";
    scheduler.requestStateRedraw();
    timers.advanceBy(399);

    expect(renderTimes).toEqual([0, 100, 200]);

    timers.advanceBy(201);

    expect(renderTimes).toEqual([0, 100, 200, 900]);
  });
});

describe("TerminalTui", () => {
  test("redraws when App Coordinator state changes outside key input", async () => {
    const player = new NoopPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });
    const input = new FakeInput();
    const output = new FakeOutput();
    const timers = new ManualTimers();
    const tui = new TerminalTui(
      { coordinator },
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
      timers,
    );

    tui.run();
    const writesAfterInitialDraw = output.chunks.length;

    await player.load({ kind: "file", path: "/music/amber.flac" });

    expect(output.chunks.length).toBeGreaterThan(writesAfterInitialDraw);
    expect(coordinator.appState.playback.status).toBe("playing");
  });

  test("redraws on input even when no intent is mapped", () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });
    const input = new FakeInput();
    const output = new FakeOutput();
    const timers = new ManualTimers();
    const tui = new TerminalTui(
      { coordinator },
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
      timers,
    );

    tui.run();
    const writesAfterInitialDraw = output.chunks.length;
    input.emit("data", "?");

    expect(output.chunks.length).toBeGreaterThan(writesAfterInitialDraw);
  });

  test("redraws immediately on input before awaiting a slow intent", () => {
    let resolveDispatch: () => void = () => undefined;
    const fakeCoordinator = {
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      onStateChange: () => () => undefined,
      dispatch: () => new Promise<void>((resolve) => {
        resolveDispatch = () => resolve();
      }),
    };
    const input = new FakeInput();
    const output = new FakeOutput();
    const tui = new TerminalTui(
      { coordinator: fakeCoordinator as unknown as AppCoordinator },
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
      new ManualTimers(),
    );

    tui.run();
    const writesAfterInitialDraw = output.chunks.length;
    input.emit("data", "n");

    expect(output.chunks.length).toBeGreaterThan(writesAfterInitialDraw);

    resolveDispatch?.();
  });
});
