#!/usr/bin/env bun
// PROTOTYPE - wipe after the Bun/mpv controller decision is captured.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

type ObservedProperty = "time-pos" | "duration" | "pause" | "idle-active" | "eof-reached";

type PlayerState = {
  connected: boolean;
  mpvExited: boolean;
  loaded: boolean;
  timePos: number | null;
  duration: number | null;
  pause: boolean | null;
  idleActive: boolean | null;
  eofReached: boolean | null;
  volume: number | null;
  lastEvent: string;
  lastError: string | null;
};

type Pending = {
  resolve(value: unknown): void;
  reject(reason: Error): void;
};

const observed: ObservedProperty[] = ["time-pos", "duration", "pause", "idle-active", "eof-reached"];

class MpvController {
  readonly state: PlayerState = {
    connected: false,
    mpvExited: false,
    loaded: false,
    timePos: null,
    duration: null,
    pause: null,
    idleActive: null,
    eofReached: null,
    volume: null,
    lastEvent: "created",
    lastError: null,
  };

  private socket: net.Socket | null = null;
  private mpv: ReturnType<typeof Bun.spawn> | null = null;
  private nextRequestId = 1;
  private buffer = "";
  private pending = new Map<number, Pending>();

  constructor(
    private readonly socketPath: string,
    private readonly workDir: string,
  ) {}

  async start(): Promise<void> {
    this.mpv = Bun.spawn([
      "mpv",
      "--idle=yes",
      "--terminal=no",
      "--vid=no",
      "--audio-display=no",
      `--input-ipc-server=${this.socketPath}`,
    ], {
      cwd: this.workDir,
      stdout: "pipe",
      stderr: "pipe",
    });

    this.mpv.exited.then((code) => {
      this.state.mpvExited = true;
      this.state.lastEvent = `mpv exited ${code}`;
      for (const request of this.pending.values()) {
        request.reject(new Error(`mpv exited before replying, code ${code}`));
      }
      this.pending.clear();
    });

    await this.waitForSocket();
    this.socket = await this.connectSocket();
    this.state.connected = true;
    this.state.lastEvent = "connected";

    for (let index = 0; index < observed.length; index += 1) {
      await this.command(["observe_property", index + 1, observed[index]]);
    }
    this.state.volume = await this.getNumber("volume");
  }

  async load(filePath: string): Promise<void> {
    await this.command(["loadfile", filePath, "replace"]);
    this.state.loaded = true;
    this.state.lastEvent = `loaded ${filePath}`;
  }

  async pauseResume(): Promise<void> {
    await this.command(["cycle", "pause"]);
    this.state.lastEvent = "cycled pause";
  }

  async setPause(paused: boolean): Promise<void> {
    await this.command(["set_property", "pause", paused]);
    this.state.pause = paused;
    this.state.lastEvent = paused ? "paused" : "resumed";
  }

  async stop(): Promise<void> {
    await this.command(["stop"]);
    this.state.loaded = false;
    this.state.lastEvent = "stopped";
  }

  async seek(seconds: number): Promise<void> {
    await this.command(["seek", seconds, "relative"]);
    this.state.lastEvent = `seek ${seconds}s`;
  }

  async setVolume(volume: number): Promise<void> {
    await this.command(["set_property", "volume", volume]);
    this.state.volume = volume;
    this.state.lastEvent = `volume ${volume}`;
  }

  async teardown(): Promise<void> {
    this.state.lastEvent = "teardown";
    try {
      if (this.socket && !this.socket.destroyed) {
        await this.command(["quit"], 1000).catch(() => undefined);
      }
    } finally {
      this.socket?.destroy();
      this.socket = null;
      this.mpv?.kill();
      await this.mpv?.exited.catch(() => undefined);
      this.mpv = null;
      await rm(this.socketPath, { force: true }).catch(() => undefined);
    }
  }

  async command(command: unknown[], timeoutMs = 2500): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) throw new Error("mpv IPC socket is not connected");
    const requestId = this.nextRequestId++;
    const payload = JSON.stringify({ command, request_id: requestId });
    this.socket.write(`${payload}\n`);
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        const error = new Error(`mpv command timed out: ${command.join(" ")}`);
        this.state.lastError = error.message;
        reject(error);
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  private async getNumber(property: string): Promise<number | null> {
    const value = await this.command(["get_property", property]);
    return typeof value === "number" ? value : null;
  }

  private async waitForSocket(): Promise<void> {
    const startedAt = performance.now();
    while (!existsSync(this.socketPath)) {
      if (performance.now() - startedAt > 2500) {
        throw new Error(`mpv did not create IPC socket at ${this.socketPath}`);
      }
      await Bun.sleep(25);
    }
  }

  private async connectSocket(): Promise<net.Socket> {
    const socket = net.createConnection(this.socketPath);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (error) => {
      this.state.lastError = error.message;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return socket;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    while (this.buffer.includes("\n")) {
      const newline = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.onMessage(JSON.parse(line));
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    if (typeof message.request_id === "number") {
      const pending = this.pending.get(message.request_id);
      if (!pending) return;
      this.pending.delete(message.request_id);
      if (message.error && message.error !== "success") {
        const error = new Error(`mpv error: ${message.error}`);
        this.state.lastError = error.message;
        pending.reject(error);
      } else {
        pending.resolve(message.data);
      }
      return;
    }

    if (message.event === "property-change" && typeof message.name === "string") {
      this.applyProperty(message.name, message.data);
    } else if (message.event === "end-file") {
      this.state.eofReached = message.reason === "eof" || message.reason === undefined;
      this.state.lastEvent = `end-file:${String(message.reason ?? "unknown")}`;
    } else if (typeof message.event === "string") {
      this.state.lastEvent = message.event;
    }
  }

  private applyProperty(name: string, value: unknown): void {
    if (name === "time-pos") this.state.timePos = typeof value === "number" ? value : null;
    if (name === "duration") this.state.duration = typeof value === "number" ? value : null;
    if (name === "pause") this.state.pause = typeof value === "boolean" ? value : null;
    if (name === "idle-active") this.state.idleActive = typeof value === "boolean" ? value : null;
    if (name === "eof-reached") this.state.eofReached = typeof value === "boolean" ? value : null;
    this.state.lastEvent = `${name}=${JSON.stringify(value)}`;
  }
}

async function makeWorkspace(): Promise<{ dir: string; socketPath: string; samplePath: string }> {
  const dir = join(tmpdir(), `tmu-mpv-prototype-${process.pid}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const samplePath = join(dir, "sample.wav");
  await writeFile(samplePath, createWavSample(2.5, 440));
  return {
    dir,
    socketPath: join(dir, "mpv.sock"),
    samplePath,
  };
}

function createWavSample(durationSeconds: number, frequency: number): Buffer {
  const sampleRate = 44100;
  const samples = Math.floor(durationSeconds * sampleRate);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / 2000, (samples - index) / 2000);
    const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.22 * envelope * 32767);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  return buffer;
}

function frame(controller: MpvController): string {
  const state = controller.state;
  return [
    "\x1b[2J\x1b[H",
    "TMU Bun mpv controller prototype",
    "",
    `connected: ${state.connected}`,
    `mpvExited: ${state.mpvExited}`,
    `loaded: ${state.loaded}`,
    `time-pos: ${fmt(state.timePos)}`,
    `duration: ${fmt(state.duration)}`,
    `pause: ${fmt(state.pause)}`,
    `idle-active: ${fmt(state.idleActive)}`,
    `eof-reached: ${fmt(state.eofReached)}`,
    `volume: ${fmt(state.volume)}`,
    `lastEvent: ${state.lastEvent}`,
    `lastError: ${state.lastError ?? "none"}`,
    "",
    "[l] load  [p] pause/resume  [s] stop  [[] seek -2  []] seek +2  [-/+] volume  [q] quit",
  ].join("\n");
}

function fmt(value: unknown): string {
  if (typeof value === "number") return value.toFixed(3);
  return value === null || value === undefined ? "null" : String(value);
}

async function runSmoke(): Promise<void> {
  const workspace = await makeWorkspace();
  const controller = new MpvController(workspace.socketPath, workspace.dir);
  try {
    console.log(`workspace ${workspace.dir}`);
    await controller.start();
    await controller.load(workspace.samplePath);
    await waitUntil(() => controller.state.duration !== null, 2500, "duration observed");
    const observedDuration = controller.state.duration;
    await Bun.sleep(350);
    await waitUntil(() => (controller.state.timePos ?? 0) > 0, 2500, "time-pos advanced");
    const observedTimePos = controller.state.timePos;
    await controller.setPause(true);
    await waitUntil(() => controller.state.pause === true, 1500, "pause true observed");
    await controller.setPause(false);
    await waitUntil(() => controller.state.pause === false, 1500, "pause false observed");
    await controller.seek(0.5);
    await Bun.sleep(150);
    await controller.setVolume(35);
    await controller.stop();
    await waitUntil(() => controller.state.idleActive === true, 2500, "idle active observed");
    await controller.load(workspace.samplePath);
    await waitUntil(() => controller.state.idleActive === false, 2500, "playback left idle");
    await waitUntil(() => controller.state.eofReached === true || controller.state.idleActive === true, 5000, "eof or idle observed");
    const observedEof = controller.state.eofReached;
    console.table({
      connected: controller.state.connected,
      observedDuration: observedDuration?.toFixed(3),
      observedTimePos: observedTimePos?.toFixed(3),
      pause: controller.state.pause,
      idleActive: controller.state.idleActive,
      eofReached: observedEof,
      volume: controller.state.volume,
      lastEvent: controller.state.lastEvent,
      lastError: controller.state.lastError ?? "none",
    });
  } finally {
    await controller.teardown();
    await rm(workspace.dir, { recursive: true, force: true });
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

async function runInteractive(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Interactive mode needs a TTY. Run without --interactive for a scripted smoke test.");
    process.exit(1);
  }
  const workspace = await makeWorkspace();
  const controller = new MpvController(workspace.socketPath, workspace.dir);
  await controller.start();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const draw = () => process.stdout.write(frame(controller));
  const ticker = setInterval(draw, 250);
  process.stdout.write("\x1b[?25l");
  draw();
  process.stdin.on("data", async (data) => {
    for (const key of [...data.toString("utf8")]) {
      try {
        if (key === "q" || key === "\u0003") {
          clearInterval(ticker);
          await controller.teardown();
          await rm(workspace.dir, { recursive: true, force: true });
          process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
          process.stdin.setRawMode(false);
          process.exit(0);
        }
        if (key === "l") await controller.load(workspace.samplePath);
        if (key === "p") await controller.pauseResume();
        if (key === "s") await controller.stop();
        if (key === "[") await controller.seek(-2);
        if (key === "]") await controller.seek(2);
        if (key === "-") await controller.setVolume(Math.max(0, (controller.state.volume ?? 50) - 5));
        if (key === "+") await controller.setVolume(Math.min(100, (controller.state.volume ?? 50) + 5));
      } catch (error) {
        controller.state.lastError = error instanceof Error ? error.message : String(error);
      }
    }
    draw();
  });
}

if (Bun.argv.includes("--interactive")) {
  await runInteractive();
} else {
  await runSmoke();
}
