import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

const decoder = new TextDecoder();

describe("production TMU PTY", () => {
  test("shows and navigates the three top-level tabs", async () => {
    let output = "";
    const runtimeRoot = `/tmp/tmu-tabs-${process.pid}-${crypto.randomUUID()}`;
    const terminal = new Bun.Terminal({
      cols: 100,
      rows: 24,
      data: (_terminal, data) => { output += decoder.decode(data); },
    });
    const subprocess = Bun.spawn(["bun", "src/main.ts"], {
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

    try {
      await waitFor(() => output.includes("[1 Playback]"));
      expect(output).toContain("2 Library");
      expect(output).toContain("3 YouTube Downloader");

      terminal.write("2");
      await waitFor(() => output.includes("[2 Library]"));

      terminal.write("\x1b");
      await Bun.sleep(50);
      terminal.write("3");
      await waitFor(() => output.includes("[3 YouTube Downloader]"));

      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      if (subprocess.exitCode === null) {
        subprocess.kill("SIGKILL");
        await subprocess.exited;
      }
      terminal.close();
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);
});

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("Timed out waiting for PTY output");
}
