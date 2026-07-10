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
  options: { playbackTrack?: boolean; searchTrack?: boolean } = {},
) {
  const runtimeRoot = `/tmp/tmu-pty-${process.pid}-${crypto.randomUUID()}`;
  if (options.playbackTrack) await seedPlaybackSnapshot(runtimeRoot);
  if (options.searchTrack) await seedSearchTrack(runtimeRoot);
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

async function stopTmu(
  terminal: Bun.Terminal,
  subprocess: {
    readonly exitCode: number | null;
    readonly exited: Promise<number>;
    kill(signal?: NodeJS.Signals | number): void;
  },
): Promise<void> {
  if (subprocess.exitCode === null) {
    terminal.write("\u0003");
    const graceful = await Promise.race([
      subprocess.exited.then(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    if (!graceful) {
      subprocess.kill("SIGKILL");
      await subprocess.exited;
    }
  }
  terminal.close();
}

async function seedPlaybackSnapshot(runtimeRoot: string): Promise<void> {
  const mediaPath = `${runtimeRoot}/media/pty-track.wav`;
  const lastMediaPath = `${runtimeRoot}/media/pty-last.wav`;
  const missingPath = `${runtimeRoot}/media/missing.wav`;
  const stateDir = `${runtimeRoot}/state/tmu`;
  await mkdir(`${runtimeRoot}/media`, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(mediaPath, createWavSample(60));
  await writeFile(lastMediaPath, createWavSample(60));
  await writeFile(`${stateDir}/last-queue.json`, JSON.stringify({
    version: 1,
    entries: [
      {
        track: {
          identity: { providerId: "local", stableId: mediaPath },
          title: "PTY Track",
          providerLabel: "Local",
          durationSeconds: 60,
        },
        availability: { status: "unknown" },
      },
      {
        track: {
          identity: { providerId: "local", stableId: missingPath },
          title: "PTY Missing",
          providerLabel: "Local",
        },
        availability: { status: "unknown" },
      },
      {
        track: {
          identity: { providerId: "local", stableId: lastMediaPath },
          title: "PTY Last",
          providerLabel: "Local",
          durationSeconds: 60,
        },
        availability: { status: "unknown" },
      },
    ],
    currentIndex: 0,
    shuffle: false,
    repeatAll: false,
    volume: { percent: 70, ready: true },
  }));
}

async function seedSearchTrack(runtimeRoot: string): Promise<void> {
  const entryDir = `${runtimeRoot}/cache/tmu/offline-youtube-cache/youtube/pty-search`;
  await mkdir(`${entryDir}/media`, { recursive: true });
  await writeFile(`${entryDir}/metadata.json`, JSON.stringify({
    version: 1,
    extractor: "youtube",
    id: "pty-search",
    title: "PTY Search Track",
    mediaFileName: "audio.webm",
    artist: "PTY Artist",
  }));
  await writeFile(`${entryDir}/media/audio.webm`, "audio");
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
  test("submits Global Search text and filters, then clears back to Provider context", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess } = await spawnTmu((text) => { output += text; }, [], { searchTrack: true });

    try {
      await waitForOutput(read, "Queue · 0 Tracks");
      terminal.write("/");
      await waitForOutput(read, "Search:");
      terminal.write("\t");
      await Bun.sleep(30);
      terminal.write("p");
      await waitForOutput(read, "Filters: Provider local · Type all");
      terminal.write("p");
      await waitForOutput(read, "Filters: Provider offline-youtube-cache · Type all");
      terminal.write("t");
      await waitForOutput(read, "Filters: Provider offline-youtube-cache · Type track");
      terminal.write("\t");
      await Bun.sleep(30);
      terminal.write("PTY Search");
      await waitForOutput(read, "PTY Search");
      terminal.write("\r");
      await waitForOutput(read, "PTY Search Track");
      expect(output).toContain("Offline YouTube Cache");

      const nextFrame = output.length;
      terminal.write("/");
      await Bun.sleep(30);
      terminal.write("\x15");
      await waitForNewOutput(read, nextFrame, "Providers");
    } finally {
      await stopTmu(terminal, subprocess);
    }
  }, 15_000);

  test("keeps Provider navigation aliases, location memory, and short-list context across PTY resize", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess } = await spawnTmu((text) => { output += text; });

    try {
      await waitForOutput(read, "Queue · 0 Tracks");
      terminal.write("o");
      await waitForOutput(read, "Providers");
      await waitForOutput(read, "Offline YouTube Cache");
      expect(output).toContain("Local · files and folders");
      expect(output).toContain("Offline YouTube Cache · downloaded YouTube audio");
      expect(output).not.toContain("Navidrome ·");

      let nextFrame = output.length;
      terminal.write("G");
      await Bun.sleep(30);
      terminal.write("\r");
      await waitForNewOutput(read, nextFrame, "offline-youtube-cache");
      nextFrame = output.length;
      terminal.write("q");
      await Bun.sleep(30);
      terminal.write("o");
      await waitForNewOutput(read, nextFrame, "offline-youtube-cache");

      nextFrame = output.length;
      terminal.resize(70, 24);
      await Bun.sleep(20);
      subprocess.kill("SIGWINCH");
      await waitForNewOutput(read, nextFrame, "offline-youtube-cache");
      expect(output.slice(nextFrame)).toContain("No Tracks or navigation entries");

      nextFrame = output.length;
      terminal.write("h");
      await waitForNewOutput(read, nextFrame, "Providers");
      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      await stopTmu(terminal, subprocess);
    }
  });

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
      await waitForNewOutput(read, nextFrame, "Picker Overlay · music-picker");
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
      await stopTmu(terminal, subprocess);
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
        await waitForOutput(read, "\x1b[?1049l");
        expect(await subprocess.exited).toBe(exitCode);
        expect(subprocess.signalCode).toBeNull();
        expect(output).toContain("\x1b[?25h");
      } finally {
        await stopTmu(terminal, subprocess);
      }
    }
  }, 15_000);

  test("routes Queue reorder, removal, and Cancel-first Clear Queue through the production PTY", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; },
      [],
      { playbackTrack: true },
    );

    try {
      await waitForOutput(read, "Queue · 3 Tracks");
      const writeAndWait = async (key: string, expected: string) => {
        const nextFrame = output.length;
        terminal.write(key);
        await waitForNewOutput(read, nextFrame, expected);
      };

      terminal.write("j");
      await Bun.sleep(100);
      terminal.write("J");
      await Bun.sleep(100);
      await writeAndWait("x", "Queue · 2 Tracks");
      terminal.write("g");
      await Bun.sleep(100);
      terminal.write("g");
      await Bun.sleep(100);
      await writeAndWait("x", "No Current Track");

      await writeAndWait("c", "Clear Queue?");
      await writeAndWait("\r", "Queue · 1 Tracks");
      await writeAndWait("c", "[Cancel]");
      await writeAndWait("y", "Queue · 0 Tracks");

      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("routes Queue-row Enter to Play Next through the production PTY", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; },
      [],
      { playbackTrack: true },
    );

    try {
      await waitForOutput(read, "Queue · 3 Tracks");
      terminal.write("j");
      await Bun.sleep(100);
      terminal.write("j");
      await Bun.sleep(100);
      const nextFrame = output.length;
      terminal.write("\r");
      await waitForNewOutput(read, nextFrame, "PTY Last");
      const frame = output.slice(nextFrame);
      expect(frame.indexOf("PTY Track")).toBeLessThan(frame.indexOf("PTY Last"));
      expect(frame.indexOf("PTY Last")).toBeLessThan(frame.indexOf("PTY Missing"));

      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);

  realPlaybackTest("routes Queue-row Shift+Enter to Play Now through the production PTY", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; },
      [],
      { playbackTrack: true },
    );

    try {
      await waitForOutput(read, "Queue · 3 Tracks");
      terminal.write("j");
      await Bun.sleep(100);
      terminal.write("j");
      await Bun.sleep(100);
      const nextFrame = output.length;
      terminal.write("\x1b[13;2u");
      await waitForNewOutput(read, nextFrame, "Playing · PTY Last");
      const frame = output.slice(nextFrame);
      expect(frame.indexOf("PTY Track")).toBeLessThan(frame.indexOf("PTY Last"));

      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);

  realPlaybackTest("routes Current Track controls through real production PTY key input", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; },
      [],
      { playbackTrack: true },
    );

    try {
      await waitForOutput(read, "Queue · 3 Tracks");
      const writeAndWait = async (key: string, expected: string) => {
        const nextFrame = output.length;
        terminal.write(key);
        await waitForNewOutput(read, nextFrame, expected);
        await Bun.sleep(250);
      };
      await writeAndWait(" ", "Playing · PTY Track");

      await writeAndWait(" ", "Paused · Space to Resume");
      await writeAndWait("j", "Paused · Space to Resume");
      await writeAndWait(" ", "Playing · PTY Track");
      await writeAndWait("s", "Stopped · starts from beginning");
      await writeAndWait(" ", "Playing · PTY Track");

      await writeAndWait("+", "Vol 75%");

      await writeAndWait("n", "Playing · PTY Last");
      await writeAndWait("r", "Repeat All");
      await writeAndWait("z", "Shuffle On");

      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
