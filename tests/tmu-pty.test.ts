import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";

const decoder = new TextDecoder();

async function waitForOutput(read: () => string, expected: string, timeoutMs = 3_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (read().includes(expected)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)} in ${JSON.stringify(read().slice(-500))}`);
}

async function waitForNewOutput(read: () => string, from: number, expected: string): Promise<void> {
  await waitForOutput(() => read().slice(from), expected);
}

async function spawnTmu(
  onData: (text: string) => void,
  args: readonly string[] = [],
  options: { playbackTrack?: boolean } = {},
) {
  const runtimeRoot = `/tmp/tmu-pty-${process.pid}-${crypto.randomUUID()}`;
  if (options.playbackTrack) await seedPlaybackSnapshot(runtimeRoot);
  const terminal = new Bun.Terminal({
    cols: 120,
    rows: 24,
    data: (_terminal, data) => onData(decoder.decode(data)),
  });
  const subprocess = Bun.spawn(["bun", "src/main.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      NO_COLOR: "1",
      XDG_CONFIG_HOME: `${runtimeRoot}/config`,
      XDG_STATE_HOME: `${runtimeRoot}/state`,
      XDG_CACHE_HOME: `${runtimeRoot}/cache`,
    },
    terminal,
  });
  return { terminal, subprocess, runtimeRoot };
}

async function seedPlaybackSnapshot(runtimeRoot: string): Promise<void> {
  const mediaPath = `${runtimeRoot}/media/pty-track.wav`;
  const stateDir = `${runtimeRoot}/state/tmu`;
  await mkdir(`${runtimeRoot}/media`, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(mediaPath, createWavSample(8));
  await writeFile(`${stateDir}/last-queue.json`, JSON.stringify({
    version: 1,
    entries: [{
      track: {
        identity: { providerId: "local", stableId: mediaPath },
        title: "PTY Track",
        providerLabel: "Local",
        durationSeconds: 8,
      },
      availability: { status: "unknown" },
    }],
    currentIndex: 0,
    shuffle: false,
    repeatAll: false,
    volume: { percent: 70, ready: true },
  }));
}

function createWavSample(durationSeconds: number): Buffer {
  const sampleRate = 8_000;
  const samples = durationSeconds * sampleRate;
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
  return buffer;
}

const realPlaybackTest = Bun.which("mpv") ? test : test.skip;

describe("production tmu real PTY", () => {
  test("publishes only semantic frames, handles resize and graceful Ctrl-C, and restores the terminal", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess } = await spawnTmu((text) => { output += text; }, ["/music/must-not-seed.flac"]);

    try {
      await waitForOutput(read, "Queue · 0 Tracks");
      await Bun.sleep(100);
      const idleBytes = output.length;
      await Bun.sleep(150);
      expect(output).toHaveLength(idleBytes);

      let nextFrame = output.length;
      expect(output).not.toContain("must-not-seed.flac");

      terminal.write("o");
      await waitForOutput(read, "Picker Overlay · music-picker");
      nextFrame = output.length;
      terminal.resize(70, 24);
      await Bun.sleep(20);
      subprocess.kill("SIGWINCH");
      await waitForNewOutput(read, nextFrame, "Current: No Current Track");
      nextFrame = output.length;
      terminal.resize(50, 14);
      await Bun.sleep(20);
      subprocess.kill("SIGWINCH");
      await waitForNewOutput(read, nextFrame, "Terminal too small");
      nextFrame = output.length;
      terminal.resize(130, 30);
      await Bun.sleep(20);
      subprocess.kill("SIGWINCH");
      await waitForNewOutput(read, nextFrame, "Playing Track");
      expect(output.slice(nextFrame)).toContain("Picker Overlay · music-picker");

      nextFrame = output.length;
      terminal.write("q");
      await waitForNewOutput(read, nextFrame, "Playing Track");
      expect(output.slice(nextFrame)).not.toContain("Picker Overlay · music-picker");
      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);

      expect(output).toContain("\x1b[?1049h");
      expect(output).toContain("\x1b[?1049l");
      expect(output).toContain("\x1b[?25h");

      const beforeStty = output.length;
      const stty = Bun.spawn(["sh", "-c", "stty -a; printf __AFTER_TRACER__"], { terminal });
      expect(await stty.exited).toBe(0);
      await waitForOutput(read, "__AFTER_TRACER__");
      const restoredState = output.slice(beforeStty).replaceAll("\r", " ").replaceAll("\n", " ");
      expect(restoredState).toMatch(/(?:^|[ ;])icanon(?:[ ;]|$)/);
      expect(restoredState).toMatch(/(?:^|[ ;])echo(?:[ ;]|$)/);
    } finally {
      if (subprocess.exitCode === null) subprocess.kill();
      terminal.close();
    }
  });

  test("restores cursor and alternate screen for operating-system termination signals", async () => {
    for (const [signal, exitCode] of [
      ["SIGINT", 130],
      ["SIGHUP", 129],
      ["SIGTERM", 143],
    ] as const) {
      let output = "";
      const read = () => output;
      const { terminal, subprocess } = await spawnTmu((text) => { output += text; });

      try {
        await waitForOutput(read, "Queue · 0 Tracks");
        subprocess.kill(signal);
        expect(await subprocess.exited).toBe(exitCode);
        await waitForOutput(read, "\x1b[?1049l");
        expect(subprocess.signalCode).toBeNull();
        expect(output).toContain("\x1b[?25h");
      } finally {
        if (subprocess.exitCode === null) subprocess.kill();
        terminal.close();
      }
    }
  });

  realPlaybackTest("routes Current Track controls through real production PTY key input", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; },
      [],
      { playbackTrack: true },
    );

    try {
      await waitForOutput(read, "Queue · 1 Tracks");
      let nextFrame = output.length;
      terminal.write(" ");
      await waitForNewOutput(read, nextFrame, "Playing · PTY Track");

      nextFrame = output.length;
      terminal.write("s");
      await waitForNewOutput(read, nextFrame, "Stopped · starts from beginning");

      nextFrame = output.length;
      terminal.write("p");
      await waitForNewOutput(read, nextFrame, "Playing · PTY Track");

      nextFrame = output.length;
      terminal.write("z");
      await waitForNewOutput(read, nextFrame, "Shuffle On");
      nextFrame = output.length;
      terminal.write("r");
      await waitForNewOutput(read, nextFrame, "Repeat All");

      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      if (subprocess.exitCode === null) subprocess.kill();
      terminal.close();
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  });
});
