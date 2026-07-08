import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import {
  BunMpvProcessAdapter,
  MpvPlayer,
  type MpvIpcClient,
  type MpvProcessAdapter,
  type MpvProcessHandle,
} from "../src/index";

const mpvSmokeTest = await helperAvailable("mpv") ? test : test.skip;

class FakeProcessHandle implements MpvProcessHandle {
  killCalls = 0;
  private resolveExited!: (code: number | null) => void;
  readonly exited = new Promise<number | null>((resolve) => {
    this.resolveExited = resolve;
  });

  kill(): void {
    this.killCalls += 1;
    this.resolveExited(0);
  }

  exit(code: number | null): void {
    this.resolveExited(code);
  }
}

class FakeIpcClient implements MpvIpcClient {
  readonly sent: unknown[] = [];
  closed = false;
  autoReply = true;
  nextError: string | null = null;
  onCommand: ((command: unknown[]) => void) | null = null;
  private lineListener: ((line: string) => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  writeLine(line: string): void {
    const message = JSON.parse(line) as { request_id?: number; command?: unknown[] };
    this.sent.push(message);
    this.onCommand?.(message.command ?? []);
    if (!this.autoReply || typeof message.request_id !== "number") return;

    const error = this.nextError ?? "success";
    this.nextError = null;
    const data = error === "success" ? this.dataForCommand(message.command ?? []) : undefined;
    queueMicrotask(() => this.emit({ request_id: message.request_id, error, data }));
  }

  close(): void {
    this.closed = true;
  }

  onLine(listener: (line: string) => void): void {
    this.lineListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  emit(message: unknown): void {
    this.lineListener?.(`${JSON.stringify(message)}\n`);
  }

  emitError(error: Error): void {
    this.errorListener?.(error);
  }

  private dataForCommand(command: unknown[]): unknown {
    if (command[0] === "get_property" && command[1] === "volume") return 88;
    return null;
  }
}

class FakeProcessAdapter implements MpvProcessAdapter {
  readonly ipc = new FakeIpcClient();
  readonly process = new FakeProcessHandle();
  readonly started: { command: string; args: string[]; cwd: string }[] = [];
  waitedForIpc: string[] = [];
  connectedToIpc: string[] = [];
  cleanedUpIpc: string[] = [];

  startMpv(command: string, args: string[], options: { cwd: string }): MpvProcessHandle {
    this.started.push({ command, args, cwd: options.cwd });
    return this.process;
  }

  async waitForIpc(path: string): Promise<void> {
    this.waitedForIpc.push(path);
  }

  async connectIpc(path: string): Promise<MpvIpcClient> {
    this.connectedToIpc.push(path);
    return this.ipc;
  }

  async cleanupIpc(path: string): Promise<void> {
    this.cleanedUpIpc.push(path);
  }
}

describe("MpvPlayer", () => {
  test("starts one long-lived audio-only idle mpv process and observes properties", async () => {
    const adapter = new FakeProcessAdapter();
    const player = new MpvPlayer({
      command: "/usr/bin/mpv",
      ipcPath: "/tmp/tmu-test.sock",
      workDir: "/tmp",
      adapter,
    });

    await player.start();

    expect(adapter.started).toEqual([{
      command: "/usr/bin/mpv",
      args: [
        "--idle=yes",
        "--terminal=no",
        "--vid=no",
        "--audio-display=no",
        "--no-resume-playback",
        "--really-quiet",
        "--input-ipc-server=/tmp/tmu-test.sock",
      ],
      cwd: "/tmp",
    }]);
    expect(adapter.waitedForIpc).toEqual(["/tmp/tmu-test.sock"]);
    expect(adapter.connectedToIpc).toEqual(["/tmp/tmu-test.sock"]);
    expect(adapter.ipc.sent).toEqual([
      { command: ["observe_property", 1, "time-pos"], request_id: 1 },
      { command: ["observe_property", 2, "duration"], request_id: 2 },
      { command: ["observe_property", 3, "pause"], request_id: 3 },
      { command: ["observe_property", 4, "idle-active"], request_id: 4 },
      { command: ["observe_property", 5, "eof-reached"], request_id: 5 },
      { command: ["get_property", "volume"], request_id: 6 },
    ]);
    expect(player.playback).toMatchObject({
      status: "idle",
      volumePercent: 88,
    });
  });

  test("sends playback commands with request IDs and updates observed state", async () => {
    const adapter = new FakeProcessAdapter();
    const player = new MpvPlayer({
      command: "mpv",
      ipcPath: "/tmp/tmu-test.sock",
      workDir: "/tmp",
      adapter,
    });

    await player.start();
    await player.load({ kind: "file", path: "/music/amber.flac" });
    await player.togglePause();
    await player.setPaused(false);
    await player.seekBy(12.5);
    await player.setVolume(42);
    await player.stop();

    expect(adapter.ipc.sent.slice(6)).toEqual([
      { command: ["loadfile", "/music/amber.flac", "replace"], request_id: 7 },
      { command: ["cycle", "pause"], request_id: 8 },
      { command: ["set_property", "pause", false], request_id: 9 },
      { command: ["seek", 12.5, "relative"], request_id: 10 },
      { command: ["set_property", "volume", 42], request_id: 11 },
      { command: ["stop"], request_id: 12 },
    ]);
    expect(player.playback.status).toBe("stopped");
    expect(player.playback.volumePercent).toBe(42);

    adapter.ipc.emit({ event: "property-change", name: "duration", data: 180.25 });
    adapter.ipc.emit({ event: "property-change", name: "time-pos", data: 12.5 });
    adapter.ipc.emit({ event: "property-change", name: "pause", data: true });
    adapter.ipc.emit({ event: "property-change", name: "idle-active", data: false });

    expect(player.playback).toMatchObject({
      status: "paused",
      durationSeconds: 180.25,
      positionSeconds: 12.5,
      paused: true,
      idle: false,
    });
  });

  test("does not report playing when pause changes while mpv is idle", async () => {
    const adapter = new FakeProcessAdapter();
    const player = new MpvPlayer({
      command: "mpv",
      ipcPath: "/tmp/tmu-test.sock",
      workDir: "/tmp",
      adapter,
    });

    await player.start();
    adapter.ipc.emit({ event: "property-change", name: "idle-active", data: true });
    adapter.ipc.emit({ event: "property-change", name: "pause", data: false });

    expect(player.playback).toMatchObject({
      status: "idle",
      idle: true,
      paused: false,
    });
  });

  test("records end-of-file transitions from mpv events", async () => {
    const adapter = new FakeProcessAdapter();
    const player = new MpvPlayer({
      command: "mpv",
      ipcPath: "/tmp/tmu-test.sock",
      workDir: "/tmp",
      adapter,
    });

    await player.start();
    await player.load({ kind: "url", url: "https://example.test/song.flac" });

    adapter.ipc.emit({ event: "end-file", reason: "eof" });

    expect(player.playback).toMatchObject({
      status: "idle",
      eof: true,
      idle: true,
    });
  });

  test("clears observed position and duration when playback boundaries change", async () => {
    const adapter = new FakeProcessAdapter();
    const player = new MpvPlayer({
      command: "mpv",
      ipcPath: "/tmp/tmu-test.sock",
      workDir: "/tmp",
      adapter,
    });

    await player.start();
    await player.load({ kind: "file", path: "/music/amber.flac" });
    adapter.ipc.emit({ event: "property-change", name: "duration", data: 180.25 });
    adapter.ipc.emit({ event: "property-change", name: "time-pos", data: 12.5 });

    await player.load({ kind: "file", path: "/music/cinder.flac" });

    expect(player.playback.positionSeconds).toBeNull();
    expect(player.playback.durationSeconds).toBeNull();

    adapter.ipc.emit({ event: "property-change", name: "duration", data: 240 });
    adapter.ipc.emit({ event: "property-change", name: "time-pos", data: 33 });
    await player.stop();

    expect(player.playback.positionSeconds).toBeNull();
    expect(player.playback.durationSeconds).toBeNull();

    await player.load({ kind: "file", path: "/music/drift.flac" });
    adapter.ipc.emit({ event: "property-change", name: "duration", data: 300 });
    adapter.ipc.emit({ event: "property-change", name: "time-pos", data: 44 });
    adapter.ipc.emit({ event: "end-file", reason: "eof" });

    expect(player.playback.positionSeconds).toBeNull();
    expect(player.playback.durationSeconds).toBeNull();
  });

  test("keeps command errors recoverable and allows later commands and teardown", async () => {
    const adapter = new FakeProcessAdapter();
    const player = new MpvPlayer({
      command: "mpv",
      ipcPath: "/tmp/tmu-test.sock",
      workDir: "/tmp",
      adapter,
      commandTimeoutMs: 10,
    });

    await player.start();
    adapter.ipc.nextError = "property unavailable";

    await expect(player.setVolume(51)).rejects.toThrow("mpv error: property unavailable");

    expect(player.playback.commandError).toEqual({
      command: "set_property volume 51",
      message: "mpv error: property unavailable",
      recoverable: true,
    });

    await player.stop();

    expect(player.playback.commandError).toBeUndefined();
    expect(player.playback.message).toBeUndefined();

    await player.teardown();

    expect(adapter.ipc.sent.at(-2)).toEqual({ command: ["stop"], request_id: 8 });
    expect(adapter.ipc.sent.at(-1)).toEqual({ command: ["quit"], request_id: 9 });
    expect(adapter.ipc.closed).toBe(true);
    expect(adapter.process.killCalls).toBe(1);
    expect(adapter.cleanedUpIpc).toEqual(["/tmp/tmu-test.sock"]);
  });

  test("does not kill mpv when quit cleanly reaps the process", async () => {
    const adapter = new FakeProcessAdapter();
    const player = new MpvPlayer({
      command: "mpv",
      ipcPath: "/tmp/tmu-test.sock",
      workDir: "/tmp",
      adapter,
      commandTimeoutMs: 10,
    });

    adapter.ipc.onCommand = (command) => {
      if (command[0] === "quit") adapter.process.exit(0);
    };

    await player.start();
    await player.teardown();

    expect(adapter.ipc.sent.at(-1)).toEqual({ command: ["quit"], request_id: 7 });
    expect(adapter.process.killCalls).toBe(0);
    expect(adapter.cleanedUpIpc).toEqual(["/tmp/tmu-test.sock"]);
  });

  test("times out commands without poisoning later commands", async () => {
    const adapter = new FakeProcessAdapter();
    const player = new MpvPlayer({
      command: "mpv",
      ipcPath: "/tmp/tmu-test.sock",
      workDir: "/tmp",
      adapter,
      commandTimeoutMs: 10,
    });

    await player.start();
    adapter.ipc.autoReply = false;

    await expect(player.load({ kind: "file", path: "/music/amber.flac" })).rejects.toThrow("mpv command timed out");

    expect(player.playback.commandError).toMatchObject({
      command: "loadfile /music/amber.flac replace",
      recoverable: true,
    });

    adapter.ipc.autoReply = true;
    await player.stop();

    expect(player.playback.commandError).toBeUndefined();
    expect(player.playback.status).toBe("stopped");
  });
});

describe("MpvPlayer smoke", () => {
  let workspace: string | null = null;

  afterEach(async () => {
    if (workspace) await rm(workspace, { recursive: true, force: true });
    workspace = null;
  });

  mpvSmokeTest("loads a generated wav through real mpv when the helper is available", async () => {
    workspace = await mkdtemp(join(tmpdir(), "tmu-mpv-smoke-"));
    const samplePath = join(workspace, "sample.wav");
    await writeFile(samplePath, createWavSample(0.4, 440));
    const player = new MpvPlayer({
      command: "mpv",
      ipcPath: join(workspace, "mpv.sock"),
      workDir: workspace,
      adapter: new BunMpvProcessAdapter(),
      commandTimeoutMs: 2500,
    });

    try {
      await player.start();
      await player.load({ kind: "file", path: samplePath });
      await waitUntil(() => player.playback.durationSeconds !== null, 2500);
      await player.setPaused(true);
      await waitUntil(() => player.playback.paused === true, 2500);
      await player.setVolume(35);
      await player.stop();
      await waitUntil(() => player.playback.idle === true || player.playback.status === "stopped", 2500);

      expect(player.playback.volumePercent).toBe(35);
      expect(player.playback.commandError).toBeUndefined();
    } finally {
      await player.teardown();
    }
  });
});

async function helperAvailable(command: string): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile(command, ["--version"], { timeout: 1000 }, (error) => resolve(!error));
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) throw new Error("timed out waiting for playback state");
    await Bun.sleep(25);
  }
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
