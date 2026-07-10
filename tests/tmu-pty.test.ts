import { describe, expect, test } from "bun:test";

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

function spawnTmu(onData: (text: string) => void, args: readonly string[] = []) {
  const runtimeRoot = `/tmp/tmu-pty-${process.pid}-${crypto.randomUUID()}`;
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
  return { terminal, subprocess };
}

describe("production tmu real PTY", () => {
  test("publishes only semantic frames, handles resize and graceful Ctrl-C, and restores the terminal", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess } = spawnTmu((text) => { output += text; }, ["/music/must-not-seed.flac"]);

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
      const { terminal, subprocess } = spawnTmu((text) => { output += text; });

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
});
