import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import net from "node:net";
import type { PlaybackLocator, Player, PlayerPlaybackState } from "./domain";

const OBSERVED_MPV_PROPERTIES = ["time-pos", "duration", "pause", "idle-active", "eof-reached"] as const;

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
};

type PendingCommand = {
  commandText: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
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

  private updateState(state: PlayerPlaybackState): void {
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
  private readonly listeners = new Set<(state: PlayerPlaybackState) => void>();
  private process: MpvProcessHandle | null = null;
  private ipc: MpvIpcClient | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingCommand>();
  private tearingDown = false;

  constructor(private readonly options: MpvPlayerOptions) {
    this.adapter = options.adapter ?? new BunMpvProcessAdapter();
    this.commandTimeoutMs = options.commandTimeoutMs ?? 2500;
    this.startTimeoutMs = options.startTimeoutMs ?? 2500;
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
    const target = locator.kind === "file" ? locator.path : locator.url;
    await this.command(["loadfile", target, "replace"]);
    this.updateState({
      status: "playing",
      positionSeconds: null,
      durationSeconds: null,
      paused: false,
      idle: false,
      eof: false,
      message: undefined,
    });
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
    return this.state;
  }

  async seekBy(seconds: number): Promise<PlayerPlaybackState> {
    await this.command(["seek", seconds, "relative"]);
    return this.state;
  }

  async setVolume(percent: number): Promise<PlayerPlaybackState> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    await this.command(["set_property", "volume", clamped]);
    this.updateState({
      volumePercent: clamped,
    });
    return this.state;
  }

  async teardown(): Promise<void> {
    this.tearingDown = true;
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
      "--idle=yes",
      "--terminal=no",
      "--vid=no",
      "--audio-display=no",
      "--no-resume-playback",
      "--really-quiet",
      `--input-ipc-server=${this.options.ipcPath}`,
    ];
  }

  private async command(command: unknown[], timeoutMs = this.commandTimeoutMs): Promise<unknown> {
    if (!this.ipc) {
      const error = new Error("mpv IPC socket is not connected");
      this.recordCommandError(command, error);
      throw error;
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const commandText = command.map(String).join(" ");
    const payload = JSON.stringify({ command, request_id: requestId });
    this.ipc.writeLine(payload);

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`mpv command timed out: ${commandText}`);
        this.recordCommandError(command, error);
        reject(error);
      }, timeoutMs);
      this.pending.set(requestId, {
        commandText,
        resolve,
        reject,
        timeout,
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
      this.updateState({
        status: "idle",
        positionSeconds: null,
        durationSeconds: null,
        idle: true,
        paused: false,
        eof: message.reason === "eof" || message.reason === undefined,
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
      this.recordCommandError(pending.commandText, error);
      pending.reject(error);
      return;
    }

    this.updateState({
      commandError: undefined,
      message: undefined,
    });
    pending.resolve(message.data);
  }

  private applyProperty(name: string, value: unknown): void {
    if (name === "time-pos") {
      this.updateState({ positionSeconds: typeof value === "number" ? value : null });
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

  private onIpcError(error: Error): void {
    this.updateState({
      status: "error",
      message: error.message,
    });
    this.rejectPending(error);
  }

  private onProcessExit(code: number | null): void {
    if (this.tearingDown) return;

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
    const commandText = Array.isArray(command) ? command.map(String).join(" ") : command;
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
    for (const listener of this.listeners) listener(this.state);
  }

  private async waitForProcessExit(process: MpvProcessHandle, timeoutMs: number): Promise<boolean> {
    return await Promise.race([
      process.exited.then(() => true).catch(() => true),
      Bun.sleep(timeoutMs).then(() => false),
    ]);
  }
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
