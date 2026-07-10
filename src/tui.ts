import {
  NAVIGATION_TARGETS,
  type LegacyAppIntent,
  type AppState,
  type NavigationTargetId,
  type UiState,
} from "./domain";
import { RootInputRouter, createActionRegistry } from "./action-registry";
import { renderPlaybackProgressLine, renderShellText } from "./renderer";
import { AppCoordinator, type AppStateChangeReason, type LegacyTuiController } from "./coordinator";

export type RuntimeApp = {
  coordinator: LegacyTuiController;
  appCoordinator?: AppCoordinator;
};

export type RenderSchedulerCadence = AppState["config"]["lowPower"];

export type RenderSchedulerTimers = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
};

export type RenderSchedulerOptions = {
  render: (reason?: RenderReason) => void;
  readState: () => { appState: AppState; uiState: UiState };
  cadence: RenderSchedulerCadence;
  timers?: Partial<RenderSchedulerTimers>;
};

type SchedulerSnapshot = {
  full: string;
  withoutPlaybackPosition: string;
  playbackPosition: string;
  playbackStatus: AppState["playback"]["status"];
  withoutDownloadProgress: string;
  downloadProgress: string;
  downloadLines: string;
  withoutProviderProgress: string;
  providerProgress: string;
  providerDisplayMetadata: string;
};
type PlaybackSchedulerSnapshot = {
  withoutPosition: string;
  position: string;
  status: AppState["playback"]["status"];
};

type ThrottledProgressKind = "download" | "provider";
export type RenderReason = "playback-event" | ThrottledProgressKind;

type ProgressThrottle = {
  cadenceMs: number;
  timer: unknown | null;
  lastDrawAt: number | null;
};

const PROGRESS_KINDS: readonly ThrottledProgressKind[] = ["download", "provider"];
const MIN_LOW_POWER_REDRAW_MS = 500;
const PLAYBACK_PROGRESS_TERMINAL_ROW = 15;

export class RenderScheduler {
  private readonly render: (reason?: RenderReason) => void;
  private readonly readState: () => { appState: AppState; uiState: UiState };
  private readonly cadence: RenderSchedulerCadence;
  private readonly timers: RenderSchedulerTimers;
  private previousSnapshot: SchedulerSnapshot | null = null;
  private previousPlaybackSnapshot: PlaybackSchedulerSnapshot | null = null;
  private playbackTimer: unknown | null = null;
  private playbackDueAt: number | null = null;
  private lastPlaybackDrawAt: number | null = null;
  private readonly progress: Record<ThrottledProgressKind, ProgressThrottle>;

  constructor(options: RenderSchedulerOptions) {
    const customTimers = options.timers;
    this.render = options.render;
    this.readState = options.readState;
    this.cadence = {
      playbackTickMs: normalizeCadence(options.cadence.playbackTickMs),
      downloadProgressThrottleMs: normalizeCadence(options.cadence.downloadProgressThrottleMs),
      providerProgressThrottleMs: normalizeCadence(options.cadence.providerProgressThrottleMs),
    };
    this.progress = {
      download: {
        cadenceMs: this.cadence.downloadProgressThrottleMs,
        timer: null,
        lastDrawAt: null,
      },
      provider: {
        cadenceMs: this.cadence.providerProgressThrottleMs,
        timer: null,
        lastDrawAt: null,
      },
    };
    this.timers = {
      now: () => customTimers?.now?.() ?? Date.now(),
      setTimeout: (callback, delayMs) => customTimers?.setTimeout
        ? customTimers.setTimeout(callback, delayMs)
        : setTimeout(callback, delayMs),
      clearTimeout: (timer) => {
        if (customTimers?.clearTimeout) {
          customTimers.clearTimeout(timer);
          return;
        }
        clearTimeout(timer as ReturnType<typeof setTimeout>);
      },
    };
  }

  start(): void {
    this.previousSnapshot = this.captureSnapshot();
    this.previousPlaybackSnapshot = this.capturePlaybackSnapshot();
  }

  stop(): void {
    this.clearPlaybackTick();
    for (const kind of PROGRESS_KINDS) this.clearProgressTimer(kind);
  }

  requestImmediateRedraw(): void {
    this.previousSnapshot = this.captureSnapshot();
    this.previousPlaybackSnapshot = this.capturePlaybackSnapshot();
    this.performRender();
  }

  requestInputRedraw(): void {
    this.requestImmediateRedraw();
  }

  requestStateRedraw(reason: AppStateChangeReason = "state"): void {
    if (reason === "playback") {
      this.requestPlaybackStateRedraw();
      return;
    }

    const nextSnapshot = this.captureSnapshot();
    const previousSnapshot = this.previousSnapshot;
    this.previousSnapshot = nextSnapshot;
    this.previousPlaybackSnapshot = this.capturePlaybackSnapshot();

    if (!previousSnapshot) {
      this.performRender();
      return;
    }

    if (previousSnapshot.full === nextSnapshot.full) {
      return;
    }

    if (isPlaybackPositionOnlyChange(previousSnapshot, nextSnapshot)) {
      this.requestPlaybackProgressRedraw();
      return;
    }

    if (isDownloadProgressOnlyChange(previousSnapshot, nextSnapshot)) {
      this.requestDownloadProgressRedraw();
      return;
    }

    if (isProviderProgressOnlyChange(previousSnapshot, nextSnapshot)) {
      this.requestProviderProgressRedraw();
      return;
    }

    this.performRender();
  }

  private requestPlaybackStateRedraw(): void {
    const nextSnapshot = this.capturePlaybackSnapshot();
    const previousSnapshot = this.previousPlaybackSnapshot;
    this.previousPlaybackSnapshot = nextSnapshot;

    if (!previousSnapshot) {
      this.previousSnapshot = this.captureSnapshot();
      this.performRender();
      return;
    }

    if (previousSnapshot.withoutPosition !== nextSnapshot.withoutPosition) {
      this.previousSnapshot = this.captureSnapshot();
      this.performRender();
      return;
    }

    if (previousSnapshot.position === nextSnapshot.position) {
      return;
    }

    this.requestPlaybackProgressRedraw();
  }

  private requestDownloadProgressRedraw(): void {
    this.requestThrottledProgressRedraw("download");
  }

  private requestProviderProgressRedraw(): void {
    this.requestThrottledProgressRedraw("provider");
  }

  private requestPlaybackProgressRedraw(): void {
    if (!this.isPlaying()) {
      this.clearPlaybackTick();
      return;
    }

    const now = this.timers.now();
    const elapsed = this.lastPlaybackDrawAt === null
      ? this.cadence.playbackTickMs
      : now - this.lastPlaybackDrawAt;
    if (elapsed >= this.cadence.playbackTickMs) {
      this.performRender("playback-event");
      return;
    }

    this.schedulePlaybackTimer(this.cadence.playbackTickMs - elapsed, "playback-event");
  }

  private requestThrottledProgressRedraw(kind: ThrottledProgressKind): void {
    const progress = this.progress[kind];
    const now = this.timers.now();
    const elapsed = progress.lastDrawAt === null ? progress.cadenceMs : now - progress.lastDrawAt;

    if (elapsed >= progress.cadenceMs) {
      this.clearProgressTimer(kind);
      this.performRender(kind);
      return;
    }

    if (progress.timer) return;

    progress.timer = this.timers.setTimeout(() => {
      progress.timer = null;
      this.performRender(kind);
    }, progress.cadenceMs - elapsed);
  }

  private performRender(reason?: RenderReason): void {
    this.render(reason);
    const now = this.timers.now();
    const displayedProgressKinds = reason === "download" || reason === "provider"
      ? [reason]
      : PROGRESS_KINDS;
    for (const kind of displayedProgressKinds) {
      this.clearProgressTimer(kind);
      this.progress[kind].lastDrawAt = now;
    }

    if (this.isPlaying()) {
      this.lastPlaybackDrawAt = now;
      this.clearPlaybackTick();
      return;
    }

    this.clearPlaybackTick();
  }

  private schedulePlaybackTimer(
    delayMs: number,
    reason: Extract<RenderReason, "playback-event">,
  ): void {
    if (!this.isPlaying()) {
      this.clearPlaybackTick();
      return;
    }

    const dueAt = this.timers.now() + Math.max(0, delayMs);
    if (
      this.playbackTimer
      && this.playbackDueAt !== null
      && this.playbackDueAt <= dueAt
    ) {
      return;
    }

    this.clearPlaybackTick();
    this.playbackDueAt = dueAt;
    this.playbackTimer = this.timers.setTimeout(() => {
      this.playbackTimer = null;
      this.playbackDueAt = null;
      if (!this.isPlaying()) return;
      this.performRender(reason);
    }, Math.max(0, delayMs));
  }

  private clearPlaybackTick(): void {
    if (!this.playbackTimer) return;

    this.timers.clearTimeout(this.playbackTimer);
    this.playbackTimer = null;
    this.playbackDueAt = null;
  }

  private clearProgressTimer(kind: ThrottledProgressKind): void {
    const progress = this.progress[kind];
    if (!progress.timer) return;

    this.timers.clearTimeout(progress.timer);
    progress.timer = null;
  }

  private isPlaying(): boolean {
    return this.readState().appState.playback.status === "playing";
  }

  private captureSnapshot(): SchedulerSnapshot {
    const { appState, uiState } = this.readState();
    const comparableAppState = comparableAppStateForScheduler(appState);
    const playbackWithoutPosition = {
      ...comparableAppState.playback,
      positionSeconds: undefined,
    };
    const appWithoutPlaybackPosition = {
      ...comparableAppState,
      playback: playbackWithoutPosition,
    };
    const appWithoutDownloadProgress = {
      ...comparableAppState,
      downloads: {
        ...comparableAppState.downloads,
        lines: [],
      },
      lastEvent: undefined,
    };
    const appWithoutProviderProgress = {
      ...comparableAppState,
      providerTracksById: providerTracksWithoutDisplayMetadata(comparableAppState.providerTracksById),
      queue: queueWithoutTrackDisplayMetadata(comparableAppState.queue),
      lastEvent: undefined,
    };

    return {
      full: JSON.stringify({ appState: comparableAppState, uiState }),
      withoutPlaybackPosition: JSON.stringify({ appState: appWithoutPlaybackPosition, uiState }),
      playbackPosition: JSON.stringify({ positionSeconds: comparableAppState.playback.positionSeconds }),
      playbackStatus: comparableAppState.playback.status,
      withoutDownloadProgress: JSON.stringify({ appState: appWithoutDownloadProgress, uiState }),
      downloadProgress: JSON.stringify({
        downloads: comparableAppState.downloads,
        lastEvent: comparableAppState.lastEvent,
      }),
      downloadLines: JSON.stringify(comparableAppState.downloads.lines),
      withoutProviderProgress: JSON.stringify({ appState: appWithoutProviderProgress, uiState }),
      providerProgress: JSON.stringify({
        providerTracksById: providerTrackDisplayMetadata(comparableAppState.providerTracksById),
        queueDisplay: queueDisplayMetadata(comparableAppState.queue),
        lastEvent: comparableAppState.lastEvent,
      }),
      providerDisplayMetadata: JSON.stringify({
        providerTracksById: providerTrackDisplayMetadata(comparableAppState.providerTracksById),
        queueDisplay: queueDisplayMetadata(comparableAppState.queue),
      }),
    };
  }

  private capturePlaybackSnapshot(): PlaybackSchedulerSnapshot {
    const playback = this.readState().appState.playback;
    const playbackWithoutPosition = {
      ...playback,
      positionSeconds: undefined,
    };
    return {
      withoutPosition: JSON.stringify(playbackWithoutPosition),
      position: JSON.stringify({ positionSeconds: playback.positionSeconds }),
      status: playback.status,
    };
  }
}

export class TerminalTui {
  private drewFullFrame = false;

  constructor(
    private readonly app: RuntimeApp,
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
    private readonly timers: Partial<RenderSchedulerTimers> = {},
  ) {}

  run(): void {
    if (!this.input.isTTY || !this.output.isTTY) {
      this.output.write(renderShellText(this.app.coordinator.appState, this.app.coordinator.uiState));
      return;
    }

    this.input.setRawMode(true);
    this.input.resume();
    this.output.write("\x1b[?25l");
    const scheduler = new RenderScheduler({
      render: (reason) => this.render(reason),
      readState: () => ({
        appState: this.app.coordinator.appState,
        uiState: this.app.coordinator.uiState,
      }),
      cadence: this.app.coordinator.appState.config.lowPower,
      timers: this.timers,
    });
    const unsubscribe = this.app.coordinator.onStateChange((reason) => {
      scheduler.requestStateRedraw(reason);
    });
    scheduler.start();
    scheduler.requestImmediateRedraw();
    const coordinator = this.app.coordinator;
    const appCoordinator = this.app.appCoordinator ?? new AppCoordinator(coordinator);
    const rootRouter = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => coordinator.appState,
      uiState: {
        get snapshot() { return coordinator.uiState; },
        dispatch: (action) => coordinator.dispatchUi(action),
      },
      dispatchApp: (intent) => appCoordinator.dispatch(intent),
      now: () => this.now(),
      timers: {
        setTimeout: (callback, delayMs) => this.timers.setTimeout?.(callback, delayMs) ?? setTimeout(callback, delayMs),
        clearTimeout: (timer) => this.timers.clearTimeout?.(timer) ?? clearTimeout(timer as ReturnType<typeof setTimeout>),
      },
    });

    const handleResize = () => {
      const columns = this.output.columns;
      const rows = this.output.rows;
      if (typeof columns !== "number" || typeof rows !== "number") return;
      this.app.coordinator.dispatchUi({
        type: "resize",
        columns,
        rows,
        queueIdentities: this.queueIdentities(),
        visibleQueueRows: Math.max(1, rows - 8),
      });
    };
    const resizeOutput = this.output as NodeJS.WriteStream & {
      on?: (event: "resize", listener: () => void) => unknown;
      removeListener?: (event: "resize", listener: () => void) => unknown;
    };
    resizeOutput.on?.("resize", handleResize);
    handleResize();

    this.input.on("data", async (data) => {
      scheduler.requestInputRedraw();
      for (const key of splitKeys(data)) {
        const uiBefore = coordinator.uiState;
        const requestsQuit = key === "\u0003"
          || (key === "q" && uiBefore.overlays.length === 0 && !uiBefore.activePrompt);
        const handled = await rootRouter.route(key);
        if (handled) {
          if (requestsQuit) {
            unsubscribe();
            scheduler.stop();
            rootRouter.cancelPendingSequence();
            resizeOutput.removeListener?.("resize", handleResize);
            this.output.write("\x1b[?25h\x1b[2J\x1b[H");
            this.input.setRawMode(false);
            process.exit(0);
          }
          continue;
        }

        const intent = intentFromKey(key);
        if (!intent) continue;
        await this.app.coordinator.dispatch(intent);
        if (intent.type === "quit") {
          unsubscribe();
          scheduler.stop();
          rootRouter.cancelPendingSequence();
          resizeOutput.removeListener?.("resize", handleResize);
          this.output.write("\x1b[?25h\x1b[2J\x1b[H");
          this.input.setRawMode(false);
          process.exit(0);
        }
      }
    });
  }

  private now(): number {
    return this.timers.now?.() ?? Date.now();
  }

  private queueIdentities() {
    return this.app.coordinator.queueTrackIdentities();
  }

  private drawPlaybackProgress(): void {
    if (!this.drewFullFrame) {
      this.draw();
      return;
    }

    this.output.write(`\x1b[s\x1b[${PLAYBACK_PROGRESS_TERMINAL_ROW};1H\x1b[2K${renderPlaybackProgressLine(this.app.coordinator.appState)}\x1b[u`);
  }

  private fullFrame(): string {
    return `\x1b[2J\x1b[H${renderShellText(this.app.coordinator.appState, this.app.coordinator.uiState)}`;
  }

  private render(reason?: RenderReason): void {
    if (reason === "playback-event") {
      this.drawPlaybackProgress();
      return;
    }

    this.draw();
  }

  private draw(): void {
    this.output.write(this.fullFrame());
    this.drewFullFrame = true;
  }
}

/** @deprecated The legacy ANSI TUI is replaced by RootInputRouter during the vue-tui cutover. */
export function intentFromKey(key: string): LegacyAppIntent | null {
  if (key === "q" || key === "\u0003") return { type: "quit" };
  if (key === "\x1b") return { type: "cancelLocalOpen" };
  if (key === "\t") return { type: "cycleFocus" };
  if (key === " ") return { type: "togglePlayPause" };
  if (key === "n") return { type: "nextTrack" };
  if (key === "p") return { type: "previousTrack" };
  if (key === "s") return { type: "stop" };
  if (key === "[") return { type: "seekBy", seconds: -5 };
  if (key === "]") return { type: "seekBy", seconds: 5 };
  if (key === "-") return { type: "adjustVolume", delta: -5 };
  if (key === "+") return { type: "adjustVolume", delta: 5 };
  if (key === "z") return { type: "toggleShuffle" };
  if (key === "r") return { type: "toggleRepeatAll" };
  if (key === "S") return { type: "saveLastQueueSnapshot" };
  if (key === "R") return { type: "restoreLastQueueSnapshot" };
  if (key === "f") return { type: "refreshNavidromeLibrary" };
  if (key === "/") return { type: "openNavidromeSearchPrompt" };
  if (key === "o") return { type: "openLocalPathPrompt" };
  if (key === "d") return { type: "cancelYouTubeDownload" };
  if (key === "x") return { type: "removeSelectedQueueEntry" };
  if (key === "c") return { type: "clearQueue" };
  if (key === "J") return { type: "moveSelectedQueueEntry", delta: 1 };
  if (key === "K") return { type: "moveSelectedQueueEntry", delta: -1 };
  if (key === "\x1b[A" || key === "\x1b[D") return { type: "moveSelection", delta: -1 };
  if (key === "\x1b[B" || key === "\x1b[C") return { type: "moveSelection", delta: 1 };
  if (key === "\r") return { type: "activateSelectedContent" };
  if (key === "a") return { type: "enqueueSelectedTrack" };
  if (/^[1-5]$/.test(key)) {
    const target = NAVIGATION_TARGETS[Number(key) - 1];
    if (target) return { type: "selectNavigationTarget", targetId: target.id as NavigationTargetId };
  }
  return null;
}

function splitKeys(data: string | Buffer): string[] {
  const raw = data.toString();
  if (raw.startsWith("\x1b[")) return [raw];
  return [...raw];
}

function normalizeCadence(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.max(MIN_LOW_POWER_REDRAW_MS, Math.round(value))
    : MIN_LOW_POWER_REDRAW_MS;
}

function comparableAppStateForScheduler(appState: AppState) {
  return {
    configPath: appState.configPath,
    configSource: appState.configSource,
    dependencyHealth: appState.dependencyHealth,
    queue: appState.queue,
    playback: appState.playback,
    volume: appState.volume,
    startupMode: appState.startupMode,
    downloads: appState.downloads,
    providerTracksById: Object.fromEntries(
      Object.entries(appState.providers).map(([providerId, provider]) => [providerId, provider.listVisibleTracks()]),
    ),
    appErrors: appState.appErrors,
    lastEvent: appState.lastEvent,
  };
}

function isPlaybackPositionOnlyChange(previous: SchedulerSnapshot, next: SchedulerSnapshot): boolean {
  return next.playbackStatus === "playing"
    && previous.withoutPlaybackPosition === next.withoutPlaybackPosition
    && previous.playbackPosition !== next.playbackPosition;
}

function isDownloadProgressOnlyChange(previous: SchedulerSnapshot, next: SchedulerSnapshot): boolean {
  return previous.withoutDownloadProgress === next.withoutDownloadProgress
    && previous.downloadLines !== next.downloadLines
    && previous.downloadProgress !== next.downloadProgress;
}

function isProviderProgressOnlyChange(previous: SchedulerSnapshot, next: SchedulerSnapshot): boolean {
  return previous.withoutProviderProgress === next.withoutProviderProgress
    && previous.providerDisplayMetadata !== next.providerDisplayMetadata
    && previous.providerProgress !== next.providerProgress;
}

function queueWithoutTrackDisplayMetadata(queue: AppState["queue"]) {
  return {
    currentIndex: queue.currentIndex,
    shuffle: queue.shuffle,
    repeatAll: queue.repeatAll,
    entries: queue.entries.map((entry) => ({
      identity: entry.track.identity,
      availability: entry.availability,
    })),
  };
}

function providerTracksWithoutDisplayMetadata(providerTracksById: Record<string, readonly AppState["queue"]["entries"][number]["track"][]>) {
  return Object.fromEntries(
    Object.entries(providerTracksById).map(([providerId, tracks]) => [
      providerId,
      tracks.map((track) => ({ identity: track.identity })),
    ]),
  );
}

function providerTrackDisplayMetadata(providerTracksById: Record<string, readonly AppState["queue"]["entries"][number]["track"][]>) {
  return Object.fromEntries(
    Object.entries(providerTracksById).map(([providerId, tracks]) => [
      providerId,
      tracks.map(trackDisplayMetadata),
    ]),
  );
}

function queueDisplayMetadata(queue: AppState["queue"]) {
  return queue.entries.map((entry) => trackDisplayMetadata(entry.track));
}

function trackDisplayMetadata(track: AppState["queue"]["entries"][number]["track"]) {
  return {
    identity: track.identity,
    title: track.title,
    providerLabel: track.providerLabel,
    artist: track.artist,
    album: track.album,
    durationSeconds: track.durationSeconds,
  };
}
