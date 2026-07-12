import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawn } from "node-pty";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const exec = promisify(execFile);
let root = "";
let tarball = "";
let packageFiles: string[] = [];

beforeAll(async () => {
  if (process.platform === "darwin") {
    await chmod(join("node_modules", "node-pty", "prebuilds", `darwin-${process.arch}`, "spawn-helper"), 0o755);
  }
  root = await mkdtemp(join(tmpdir(), "tmu-package-contract-"));
  const configDir = join(root, "config", "tmu");
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.json"), JSON.stringify({
    helpers: {
      mpv: join(root, "missing-external-tools", "mpv"),
      ytDlp: join(root, "missing-external-tools", "yt-dlp"),
    },
  }));
  const { stdout } = await exec("npm", ["pack", "--silent", "--pack-destination", root]);
  tarball = join(root, stdout.trim().split("\n").at(-1) ?? "");
  const listing = await exec("tar", ["-tzf", tarball]);
  packageFiles = listing.stdout.trim().split("\n");
}, 30_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("Node npm package", () => {
  test("builds one executable ESM CLI bundle with a source map", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      name: string;
      bin: Record<string, string>; engines: Record<string, string>;
      publishConfig: { access: string };
      dependencies: Record<string, string>; devDependencies: Record<string, string>;
    };
    expect(pkg.name).toBe("@txchen/tmu");
    expect(pkg.bin).toEqual({ tmu: "dist/cli.js" });
    expect(pkg.engines).toEqual({ node: ">=24.0.0" });
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.dependencies).toMatchObject({ "@vue-tui/runtime": "0.0.3", vue: "3.5.39" });
    expect(pkg.devDependencies).toHaveProperty("tsdown");
    expect(packageFiles).toContain("package/dist/cli.js");
    expect(packageFiles).toContain("package/dist/cli.js.map");
    expect((await readFile("dist/cli.js", "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
    await access("dist/cli.js.map");
  });

  test("packs only distribution output and user documentation", () => {
    expect(packageFiles).toContain("package/README.md");
    expect(packageFiles).toContain("package/CONTEXT.md");
    expect(packageFiles.some((file) => file.startsWith("package/src/"))).toBe(false);
    expect(packageFiles.some((file) => file.startsWith("package/tests/"))).toBe(false);
  });

  test("contains no Bun runtime, tooling dependency, or artifact", async () => {
    expect(packageFiles.some((file) => /(?:^|\/)bun(?:\.lock|fig|$)/i.test(file))).toBe(false);
    const packedPackage = await exec("tar", ["-xOf", tarball, "package/package.json"]);
    const manifest = JSON.parse(packedPackage.stdout) as Record<string, unknown>;
    const dependencyNames = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]
      .flatMap((section) => Object.keys((manifest[section] as Record<string, string> | undefined) ?? {}));
    expect(dependencyNames.filter((name) => name.toLowerCase().includes("bun"))).toEqual([]);
  });

  test("rejects unsupported Node before application initialization", async () => {
    const preload = join(process.cwd(), "tests/fixtures/unsupported-node.cjs");
    await expect(exec(process.execPath, ["--require", preload, "dist/cli.js"], {
      env: { ...process.env, TMU_APPLICATION_INITIALIZATION_SENTINEL: "1" },
    })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("TMU requires Node.js 24 or newer"),
    });
  });

  test("runs the packed CLI through npx and an isolated global installation without External Tools", async () => {
    const globalPrefix = join(root, "global");
    await exec("npm", ["install", "--global", "--prefix", globalPrefix, tarball]);

    const env = isolatedRuntimeEnv();
    await expectPackedTerminal(join(globalPrefix, "bin", "tmu"), [], env);
    await expectPackedTerminal("npx", ["--yes", "--package", tarball, "tmu"], env);
  }, 30_000);

  test("public source surface contains no removed provider or legacy input-router modules", async () => {
    const sourceFiles = await readdir("src");
    const indexSource = await readFile("src/index.ts", "utf8");
    expect(sourceFiles).not.toContain("input-router.ts");
    expect(sourceFiles.some((name) => /navidrome|local-provider|offline-youtube/i.test(name))).toBe(false);
    expect(indexSource).not.toContain("input-router");
  });
});

function isolatedRuntimeEnv(): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    TERM: "xterm-256color",
    NO_COLOR: "1",
    PATH: `${join(root, "missing-external-tools")}:${process.env.PATH ?? ""}`,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
  };
}

async function expectPackedTerminal(command: string, args: string[], env: Record<string, string>): Promise<void> {
  let output = "";
  const terminal = spawn(command, args, { cols: 100, rows: 24, cwd: root, env });
  terminal.onData((data) => { output += data; });
  let exited = false;
  const exitPromise = new Promise<{ exitCode: number; signal?: number }>((resolve) => terminal.onExit((event) => {
    exited = true;
    resolve(event);
  }));

  try {
    await waitFor(() => output.includes("Player") && output.includes("Library") && output.includes("Downloads"));
    expect(output).toContain("prev · next");
    output = "";
    terminal.write("]");
    await waitFor(() => output.includes("▸ Library ◂"));
    output = "";
    terminal.write("]");
    await waitFor(() => output.includes("▸ Downloads ◂"));
    output = "";
    terminal.write("[");
    await waitFor(() => output.includes("▸ Library ◂"));
    terminal.write("q");
    const exit = await withTimeout(exitPromise, 10_000, "Timed out waiting for packed terminal exit");
    expect(exit.exitCode).toBe(0);
  } finally {
    if (!exited) terminal.kill();
    await withTimeout(exitPromise, 2_000, "Timed out cleaning up packed terminal process");
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for packed terminal output");
}
