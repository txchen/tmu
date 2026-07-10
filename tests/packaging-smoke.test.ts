import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Bun npm executable", () => {
  test("publishes tmu as a Bun-backed npm executable without compiled artifact scripts", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      private?: boolean;
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.private).not.toBe(true);
    expect(pkg.bin).toEqual({ tmu: "src/main.ts" });
    expect(pkg.scripts?.["build:linux-x64"]).toBeUndefined();
    expect(pkg.scripts?.["smoke:linux-x64"]).toBeUndefined();
    expect(Object.keys(pkg.scripts ?? {}).every((name) => !name.includes("prototype"))).toBe(true);
    expect(pkg.dependencies?.["@vue-tui/runtime"]).toBe("0.0.3");
    expect(pkg.dependencies?.vue).toBe("3.5.39");
    expect(pkg.devDependencies?.["@vue-tui/runtime"]).toBeUndefined();
    expect(pkg.devDependencies?.vue).toBeUndefined();
  });

  test("runs the packed executable through bunx and a Bun global install", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmu-package-smoke-"));
    const packDir = join(root, "pack");
    const installDir = join(root, "bun-install");

    try {
      await Bun.$`mkdir -p ${packDir}`.quiet();
      const packed = await Bun.$`npm pack --silent --pack-destination ${packDir}`.text();
      const tarball = join(packDir, packed.trim().split("\n").at(-1) ?? "");
      const installed = Bun.spawn(["bun", "install", "--global", tarball], {
        env: { ...process.env, BUN_INSTALL: installDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await installed.exited).toBe(0);

      await expectTmuExecutable(["tmu"], {
        ...isolatedRuntimeEnv(root, installDir),
        PATH: `${join(installDir, "bin")}:${process.env.PATH ?? ""}`,
      });
      await expectTmuExecutable(["bunx", "--package", tarball, "tmu"], isolatedRuntimeEnv(root, installDir));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});

function isolatedRuntimeEnv(root: string, installDir: string): Record<string, string | undefined> {
  return {
    ...process.env,
    BUN_INSTALL: installDir,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
}

async function expectTmuExecutable(command: string[], env: Record<string, string | undefined>): Promise<void> {
  let output = "";
  const terminal = new Bun.Terminal({
    cols: 100,
    rows: 24,
    data: (_terminal, data) => { output += new TextDecoder().decode(data); },
  });
  const executable = Bun.spawn(command, {
    env: { ...env, TERM: "xterm-256color", NO_COLOR: "1" },
    terminal,
  });

  try {
    const startedAt = Date.now();
    while (!output.includes("[1 Playback]") && Date.now() - startedAt < 10_000) {
      await Bun.sleep(10);
    }
    expect(output).toContain("[1 Playback]");
    expect(output).toContain("2 Library");
    expect(output).toContain("3 YouTube Downloader");
    terminal.write("q");
    expect(await executable.exited).toBe(0);
  } finally {
    if (executable.exitCode === null) executable.kill();
    terminal.close();
  }
}
