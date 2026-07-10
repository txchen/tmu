import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import net from "node:net";
import type { PlaybackLocator, Player, PlayerPlaybackState } from "./domain";

const OBSERVED_MPV_PROPERTIES = ["duration", "pause", "idle-active", "eof-reached"] as const;
const DEFAULT_POSITION_POLL_MS = 1000;
const LOCAL_FILE_PLAYBACK_OPTIONS = {
  "demuxer-thread": "no",
  "audio-pitch-correction": "no",
} as const;

export type MpvProcessHandle = {
  readonly exited: Promise<number | null>;
  kill(): void;
};

export type MpvIpcClient = {
  writeLine(line: string): void;
  close(): void;
  onLine(listener: (line: string) => void): void;
  onError(listener: (error: Error) => void): void;
};

export type MpvProcessAdapter = {
  startMpv(command: string, args: string[], options: { cwd: string }): MpvProcessHandle;
  waitForIpc(path: string, timeoutMs?: number): Promise<void>;
  connectIpc(path: string): Promise<MpvIpcClient>;
  cleanupIpc(path: string): Promise<void>;
};

export type MpvPlayerOptions = {
  command: string;
  ipcPath: string;
  workDir: string;
  adapter?: MpvProcessAdapter;
  commandTimeoutMs?: number;
  startTimeoutMs?: number;
  positionPollMs?: number;
};

type PendingCommand = {
  commandText: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  recordErrors: boolean;
  updateOnReply: boolean;
};

export class NoopPlayer implements Player {
  private state: PlayerPlaybackState = {
    status: "idle",
  };
  private readonly listeners = new Set<(state: PlayerPlaybackState) => void>();

  get playback(): PlayerPlaybackState {
    return this.state;
  }

  async start(): Promise<PlayerPlaybackState> {
    return this.state;
  }

  async load(_locator: PlaybackLocator): Promise<void> {
    this.updateState({
      status: "playing",
    });
  }

  async togglePause(): Promise<PlayerPlaybackState> {
    this.updateState({
      ...this.state,
      status: this.state.status === "playing" ? "paused" : "playing",
    });
    return this.state;
  }

  async setPaused(paused: boolean): Promise<PlayerPlaybackState> {
    this.updateState({
      ...this.state,
      status: paused ? "paused" : "playing",
      paused,
    });
    return this.state;
  }

  async stop(): Promise<PlayerPlaybackState> {
    this.updateState({
      status: "stopped",
    });
    return this.state;
  }

  async seekBy(_seconds: number): Promise<PlayerPlaybackState> {
    return this.state;
  }

  async setVolume(percent: number): Promise<PlayerPlaybackState> {
    this.updateState({
      ...this.state,
      volumePercent: Math.max(0, Math.min(100, Math.round(percent))),
    });
    return this.state;
  }

  async teardown(): Promise<void> {
    return undefined;
  }

  onPlaybackStateChange(_listener: (state: PlayerPlaybackState) => void): () => void {
    this.listeners.add(_listener);
    return () => this.listeners.delete(_listener);
  }

  protected updateState(state: PlayerPlaybackState): void {
    this.state = state;
    for (const listener of this.listeners) listener(this.state);
  }
}

export class MpvPlayer implements Player {
  private state: PlayerPlaybackState = {
    status: "idle",
    positionSeconds: null,
    durationSeconds: null,
    paused: null,
    idle: true,
    eof: false,
    volumePercent: null,
  };

  private readonly adapter: MpvProcessAdapter;
  private readonly commandTimeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly positionPollMs: number;
  private readonly listeners = new Set<(state: PlayerPlaybackState) => void>();
  private process: MpvProcessHandle | null = null;
  private ipc: MpvIpcClient | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingCommand>();
  private positionPollTimer: ReturnType<typeof setTimeout> | null = null;
  private tearingDown = false;

  constructor(private readonly options: MpvPlayerOptions) {
    this.adapter = options.adapter ?? new BunMpvProcessAdapter();
    this.commandTimeoutMs = options.commandTimeoutMs ?? 2500;
    this.startTimeoutMs = options.startTimeoutMs ?? 2500;
    this.positionPollMs = normalizePositionPollMs(options.positionPollMs);
  }

  get playback(): PlayerPlaybackState {
    return this.state;
  }

  async start(): Promise<PlayerPlaybackState> {
    if (this.process || this.ipc) return this.state;

    this.tearingDown = false;
    this.process = this.adapter.startMpv(this.options.command, this.mpvArgs(), {
      cwd: this.options.workDir,
    });
    this.process.exited.then((code) => this.onProcessExit(code)).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.updateState({
        status: "error",
        message,
      });
    });

    await this.adapter.waitForIpc(this.options.ipcPath, this.startTimeoutMs);
    this.ipc = await this.adapter.connectIpc(this.options.ipcPath);
    this.ipc.onLine((line) => this.onLine(line));
    this.ipc.onError((error) => this.onIpcError(error));

    for (let index = 0; index < OBSERVED_MPV_PROPERTIES.length; index += 1) {
      await this.command(["observe_property", index + 1, OBSERVED_MPV_PROPERTIES[index]]);
    }
    const volume = await this.command(["get_property", "volume"]);
    this.updateState({
      status: "idle",
      idle: true,
      volumePercent: typeof volume === "number" ? volume : null,
    });
    return this.state;
  }

  async load(locator: PlaybackLocator): Promise<void> {
    if (!this.process || !this.ipc) {
      const volume = this.state.volumePercent;
      try {
        await this.start();
      } catch (error) {
        await this.teardown().catch(() => undefined);
        throw error;
      }
      if (volume !== null && volume !== this.state.volumePercent) {
        await this.command(["set_property", "volume", volume]);
        this.updateState({ volumePercent: volume });
      }
    }
    await this.command(this.loadCommand(locator));
    this.updateState({
      status: "playing",
      positionSeconds: null,
      durationSeconds: null,
      paused: false,
      idle: false,
      eof: false,
      message: undefined,
      failureKind: undefined,
    });
    this.reschedulePositionPoll(0);
  }

  async togglePause(): Promise<PlayerPlaybackState> {
    await this.command(["cycle", "pause"]);
    const paused = this.state.status === "playing";
    this.updateState({
      status: paused ? "paused" : "playing",
      paused,
      idle: false,
      eof: false,
    });
    if (!paused) this.reschedulePositionPoll(0);
    return this.state;
  }

  async setPaused(paused: boolean): Promise<PlayerPlaybackState> {
    await this.command(["set_property", "pause", paused]);
    this.updateState({
      status: paused ? "paused" : "playing",
      paused,
      idle: false,
      eof: false,
    });
    if (!paused) this.reschedulePositionPoll(0);
    return this.state;
  }

  async stop(): Promise<PlayerPlaybackState> {
    await this.command(["stop"]);
    this.updateState({
      status: "stopped",
      positionSeconds: null,
      durationSeconds: null,
      paused: null,
      idle: true,
      eof: false,
    });
    this.clearPositionPoll();
    return this.state;
  }

  async seekBy(seconds: number): Promise<PlayerPlaybackState> {
    await this.command(["seek", seconds, "relative"]);
    return this.state;
  }

  async setVolume(percent: number): Promise<PlayerPlaybackState> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (!this.process || !this.ipc) {
      this.updateState({ volumePercent: clamped });
      return this.state;
    }
    await this.command(["set_property", "volume", clamped]);
    this.updateState({
      volumePercent: clamped,
    });
    return this.state;
  }

  async teardown(): Promise<void> {
    this.tearingDown = true;
    this.clearPositionPoll();
    const process = this.process;
    try {
      if (this.ipc) {
        await this.command(["quit"], Math.min(1000, this.commandTimeoutMs)).catch(() => undefined);
      }
    } finally {
      this.rejectPending(new Error("mpv player teardown"));
      this.ipc?.close();
      this.ipc = null;
      if (process) {
        const exited = await this.waitForProcessExit(process, Math.min(1000, this.commandTimeoutMs));
        if (!exited) {
          process.kill();
          await process.exited.catch(() => undefined);
        }
      }
      this.process = null;
      await this.adapter.cleanupIpc(this.options.ipcPath).catch(() => undefined);
      this.updateState({
        status: "idle",
        idle: true,
        paused: null,
      });
    }
  }

  onPlaybackStateChange(listener: (state: PlayerPlaybackState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private mpvArgs(): string[] {
    return [
      "--no-config",
      "--idle=yes",
      "--terminal=no",
      "--vid=no",
      "--audio-display=no",
      "--no-resume-playback",
      "--really-quiet",
      "--load-scripts=no",
      "--ytdl=no",
      "--osc=no",
      "--input-default-bindings=no",
      "--input-builtin-bindings=no",
      `--input-ipc-server=${this.options.ipcPath}`,
    ];
  }

  private loadCommand(locator: PlaybackLocator): unknown[] {
    return ["loadfile", locator.path, "replace", -1, LOCAL_FILE_PLAYBACK_OPTIONS];
  }

  private async command(command: unknown[], timeoutMs = this.commandTimeoutMs): Promise<unknown> {
    return await this.sendCommand(command, timeoutMs, {
      recordErrors: true,
      updateOnReply: true,
    });
  }

  private async query(command: unknown[], timeoutMs = this.commandTimeoutMs): Promise<unknown> {
    return await this.sendCommand(command, timeoutMs, {
      recordErrors: false,
      updateOnReply: false,
    });
  }

  private async sendCommand(
    command: unknown[],
    timeoutMs: number,
    options: Pick<PendingCommand, "recordErrors" | "updateOnReply">,
  ): Promise<unknown> {
    if (!this.ipc) {
      const error = new Error("mpv IPC socket is not connected");
      if (options.recordErrors) this.recordCommandError(command, error);
      throw error;
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const commandText = command.map(formatCommandPart).join(" ");
    const payload = JSON.stringify({ command, request_id: requestId });
    this.ipc.writeLine(payload);

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`mpv command timed out: ${commandText}`);
        if (options.recordErrors) this.recordCommandError(command, error);
        reject(error);
      }, timeoutMs);
      this.pending.set(requestId, {
        commandText,
        resolve,
        reject,
        timeout,
        recordErrors: options.recordErrors,
        updateOnReply: options.updateOnReply,
      });
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      this.onMessage(JSON.parse(trimmed) as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateState({ status: "error", message });
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    if (typeof message.request_id === "number") {
      this.onCommandReply(message);
      return;
    }

    if (message.event === "property-change" && typeof message.name === "string") {
      this.applyProperty(message.name, message.data);
      return;
    }

    if (message.event === "end-file") {
      this.clearPositionPoll();
      const playbackFailed = message.reason === "error";
      this.updateState({
        status: playbackFailed ? "error" : "idle",
        positionSeconds: null,
        durationSeconds: null,
        idle: true,
        paused: false,
        eof: message.reason === "eof" || message.reason === undefined,
        failureKind: playbackFailed ? "playback" : undefined,
        message: playbackFailed
          ? `mpv playback failed${typeof message.error === "string" ? `: ${message.error}` : ""}`
          : undefined,
      });
    }
  }

  private onCommandReply(message: Record<string, unknown>): void {
    const requestId = message.request_id as number;
    const pending = this.pending.get(requestId);
    if (!pending) return;

    this.pending.delete(requestId);
    clearTimeout(pending.timeout);

    if (message.error && message.error !== "success") {
      const error = new Error(`mpv error: ${String(message.error)}`);
      if (pending.recordErrors) this.recordCommandError(pending.commandText, error);
      pending.reject(error);
      return;
    }

    if (pending.updateOnReply) {
      this.updateState({
        commandError: undefined,
        message: undefined,
      });
    }
    pending.resolve(message.data);
  }

  private applyProperty(name: string, value: unknown): void {
    if (name === "time-pos") {
      this.updatePlaybackPosition(typeof value === "number" ? value : null);
      return;
    }
    if (name === "duration") {
      this.updateState({ durationSeconds: typeof value === "number" ? value : null });
      return;
    }
    if (name === "pause") {
      if (typeof value === "boolean") {
        this.updateState({
          paused: value,
          status: this.statusForObservedState({ paused: value }),
        });
      } else {
        this.updateState({ paused: null });
      }
      return;
    }
    if (name === "idle-active") {
      if (typeof value === "boolean") {
        this.updateState({
          idle: value,
          status: this.statusForObservedState({ idle: value }),
        });
      } else {
        this.updateState({ idle: null });
      }
      return;
    }
    if (name === "eof-reached") {
      this.updateState({ eof: typeof value === "boolean" ? value : false });
    }
  }

  private updatePlaybackPosition(positionSeconds: number | null): void {
    const previous = this.state.positionSeconds;
    if (
      typeof positionSeconds === "number"
      && typeof previous === "number"
      && Math.floor(positionSeconds) === Math.floor(previous)
    ) {
      return;
    }

    if (positionSeconds === null && previous === null) return;
    this.updateState({ positionSeconds });
  }

  private shouldPollPosition(): boolean {
    return this.state.status === "playing" && Boolean(this.ipc) && !this.tearingDown;
  }

  private schedulePositionPoll(delayMs = this.positionPollMs): void {
    if (!this.shouldPollPosition() || this.positionPollTimer) return;

    this.positionPollTimer = setTimeout(() => {
      this.positionPollTimer = null;
      void this.pollPlaybackPosition();
    }, Math.max(0, delayMs));
  }

  private reschedulePositionPoll(delayMs = this.positionPollMs): void {
    this.clearPositionPoll();
    this.schedulePositionPoll(delayMs);
  }

  private clearPositionPoll(): void {
    if (!this.positionPollTimer) return;
    clearTimeout(this.positionPollTimer);
    this.positionPollTimer = null;
  }

  private syncPositionPolling(): void {
    if (this.shouldPollPosition()) {
      this.schedulePositionPoll();
      return;
    }

    this.clearPositionPoll();
  }

  private async pollPlaybackPosition(): Promise<void> {
    if (!this.shouldPollPosition()) return;

    try {
      const position = await this.query(["get_property", "time-pos"]);
      this.updatePlaybackPosition(typeof position === "number" ? position : null);
    } catch {
      return;
    } finally {
      this.schedulePositionPoll();
    }
  }

  private onIpcError(error: Error): void {
    this.updateState({
      status: "error",
      message: error.message,
    });
    this.rejectPending(error);
  }

  private onProcessExit(code: number | null): void {
    if (this.tearingDown) return;

    this.clearPositionPoll();
    const error = new Error(`mpv exited before teardown, code ${code ?? "unknown"}`);
    this.updateState({
      status: "error",
      message: error.message,
    });
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private recordCommandError(command: unknown[] | string, error: Error): void {
    const commandText = Array.isArray(command) ? command.map(formatCommandPart).join(" ") : command;
    this.updateState({
      status: "error",
      commandError: {
        command: commandText,
        message: error.message,
        recoverable: true,
      },
      message: error.message,
    });
  }

  private statusForObservedState(observed: Pick<PlayerPlaybackState, "idle" | "paused">): PlayerPlaybackState["status"] {
    const idle = observed.idle ?? this.state.idle;
    const paused = observed.paused ?? this.state.paused;
    if (idle) return "idle";
    if (paused) return "paused";
    return "playing";
  }

  private updateState(patch: Partial<PlayerPlaybackState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
    this.syncPositionPolling();
    for (const listener of this.listeners) listener(this.state);
  }

  private async waitForProcessExit(process: MpvProcessHandle, timeoutMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        process.exited.then(() => true).catch(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

function formatCommandPart(part: unknown): string {
  if (typeof part === "string") return part;
  if (typeof part === "number" || typeof part === "boolean" || part === null) return String(part);
  return JSON.stringify(part);
}

function normalizePositionPollMs(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.max(500, Math.round(value))
    : DEFAULT_POSITION_POLL_MS;
}

export class BunMpvProcessAdapter implements MpvProcessAdapter {
  startMpv(command: string, args: string[], options: { cwd: string }): MpvProcessHandle {
    const subprocess = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      stdout: "ignore",
      stderr: "ignore",
    });

    return {
      exited: subprocess.exited,
      kill: () => {
        subprocess.kill();
      },
    };
  }

  async waitForIpc(path: string, timeoutMs = 2500): Promise<void> {
    const startedAt = performance.now();
    while (!existsSync(path)) {
      if (performance.now() - startedAt > timeoutMs) {
        throw new Error(`mpv did not create IPC socket at ${path}`);
      }
      await Bun.sleep(25);
    }
  }

  async connectIpc(path: string): Promise<MpvIpcClient> {
    const socket = net.createConnection(path);
    socket.setEncoding("utf8");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return new NetMpvIpcClient(socket);
  }

  async cleanupIpc(path: string): Promise<void> {
    await rm(path, { force: true });
  }
}

class NetMpvIpcClient implements MpvIpcClient {
  private lineListener: ((line: string) => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;
  private buffer = "";

  constructor(private readonly socket: net.Socket) {
    this.socket.on("data", (chunk) => this.onData(String(chunk)));
    this.socket.on("error", (error) => this.errorListener?.(error));
  }

  writeLine(line: string): void {
    this.socket.write(`${line}\n`);
  }

  close(): void {
    this.socket.destroy();
  }

  onLine(listener: (line: string) => void): void {
    this.lineListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const newline = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, newline + 1);
      this.buffer = this.buffer.slice(newline + 1);
      this.lineListener?.(line);
    }
  }
}
