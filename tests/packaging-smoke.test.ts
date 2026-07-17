import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { spawn } from "node-pty";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const exec = promisify(execFile);
let root = "";
let tarball = "";
let packageFiles: string[] = [];
let packedRoot = "";

beforeAll(async () => {
  if (process.platform === "darwin") {
    await chmod(join("node_modules", "node-pty", "prebuilds", `darwin-${process.arch}`, "spawn-helper"), 0o755);
  }
  root = await mkdtemp(join(tmpdir(), "tmu-package-contract-"));
  await mkdir(join(root, "runtime"), { mode: 0o700 });
  const configDir = join(root, "config", "tmu");
  await mkdir(configDir, { recursive: true });
  const fakeMpv = join(process.cwd(), "tests", "fixtures", "fake-mpv.mjs");
  await chmod(fakeMpv, 0o755);
  await writeFile(join(configDir, "config.json"), JSON.stringify({
    helpers: {
      mpv: fakeMpv,
      ytDlp: join(root, "missing-external-tools", "yt-dlp"),
    },
  }));
  const cacheDir = join(root, "cache", "tmu", "youtube-cache");
  const stateDir = join(root, "state", "tmu");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const videoId = "package0001";
  await writeFile(join(cacheDir, `${videoId}.opus`), "packaged playback fixture");
  await writeFile(join(cacheDir, `${videoId}.json`), JSON.stringify({
    videoId, title: "Packaged Playback", uploader: "TMU", durationSeconds: 600,
    cachedAt: "2026-07-16T00:00:00.000Z", mediaFileName: `${videoId}.opus`, container: "opus",
  }));
  const playlistId = "00000000-0000-4000-8000-000000000114";
  await writeFile(join(stateDir, "last-playlists.json"), JSON.stringify({
    version: 2, playingPlaylistId: playlistId,
    playlists: [{ id: playlistId, name: "Default", trackIdentities: [{ providerId: "youtube-cache", stableId: videoId }],
      currentTrackIdentity: null, positionSeconds: 0, playbackStatus: "stopped", repeatAll: false }],
    tracks: [{ identity: { providerId: "youtube-cache", stableId: videoId }, title: "Packaged Playback", artist: "TMU",
      durationSeconds: 600, providerLabel: "YouTube Cache" }], volume: { percent: 100, ready: true },
  }));
  const { stdout } = await exec("npm", ["pack", "--silent", "--pack-destination", root]);
  tarball = join(root, stdout.trim().split("\n").at(-1) ?? "");
  const listing = await exec("tar", ["-tzf", tarball]);
  packageFiles = listing.stdout.trim().split("\n");
  packedRoot = join(root, "unpacked", "package");
  await mkdir(join(root, "unpacked"));
  await exec("tar", ["-xzf", tarball, "-C", join(root, "unpacked")]);
}, 30_000);

afterAll(async () => {
  if (root) {
    try {
      const ready = JSON.parse(await readFile(join(root, "runtime", "tmu", "ready.json"), "utf8")) as { pid?: number };
      if (ready.pid) {
        process.kill(ready.pid, "SIGTERM");
        await waitFor(() => {
          try { process.kill(ready.pid!, 0); return false; } catch { return true; }
        }, 2_000);
      }
    } catch { /* daemon was not started or already exited */ }
  }
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
    expect(packageFiles).toContain("package/dist/daemon-process.js");
    expect(packageFiles).toContain("package/dist/daemon-process.js.map");
    expect(packageFiles).toContain("package/dist/background-sounds.js");
    expect(packageFiles).toContain("package/dist/background-sounds.jxa");
    const packagedHelper = join(packedRoot, "dist", "background-sounds.jxa");
    expect(await readFile(packagedHelper, "utf8")).toContain("HUComfortSoundsSettings");
    await access(join(packedRoot, "dist", "cli.js"));
    const packagedAdapter = await import(pathToFileURL(join(packedRoot, "dist", "background-sounds.js")).href);
    const control = new packagedAdapter.JxaBackgroundSoundsControl() as { helperPath: string };
    expect(await realpath(control.helperPath)).toBe(await realpath(packagedHelper));
    await access(control.helperPath);
    expect((await readFile("dist/cli.js", "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
    await access("dist/cli.js.map");
  });

  test("packs only distribution output and user documentation", () => {
    expect(packageFiles).toContain("package/README.md");
    expect(packageFiles).toContain("package/CONTEXT.md");
    expect(packageFiles).toContain("package/RELEASE_NOTES.md");
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

  test("exposes only the normal launch and status/stop operational commands", async () => {
    for (const args of [["daemon", "start"], ["--tmu-daemon-process"], ["legacy"], ["daemon", "status", "extra"], ["daemon", "stop", "--kill"]]) {
      await expect(exec(process.execPath, ["dist/cli.js", ...args])).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining("Usage: tmu"),
      });
    }
  });

  test("runs daemon-owned playback through npx and an isolated global packaged installation", async () => {
    const globalPrefix = join(root, "global");
    await exec("npm", ["install", "--global", "--prefix", globalPrefix, tarball]);

    const env = isolatedRuntimeEnv();
    const installedTmu = join(globalPrefix, "bin", "tmu");
    await expectPackedTerminal(installedTmu, [], env, "q");
    await expectPackedTerminal("npx", ["--yes", "--package", tarball, "tmu"], env, "ctrl-c");
    await expectPackagedConnectionLoss(installedTmu, env);
    await expectPackagedTuiShutdown(installedTmu, env);
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
    XDG_RUNTIME_DIR: join(root, "runtime"),
  };
}

async function expectPackedTerminal(command: string, args: string[], env: Record<string, string>, quit: "q" | "ctrl-c"): Promise<void> {
  let output = "";
  const osascriptSentinel = join(root, `osascript-${Math.random()}.called`);
  const terminal = spawn(command, args, { cols: 100, rows: 24, cwd: root, env: {
    ...env,
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require ${join(process.cwd(), "tests/fixtures/observe-osascript.cjs")}`.trim(),
    TMU_OSASCRIPT_SENTINEL: osascriptSentinel,
  } });
  terminal.onData((data) => { output += data; });
  let exited = false;
  const exitPromise = new Promise<{ exitCode: number; signal?: number }>((resolve) => terminal.onExit((event) => {
    exited = true;
    resolve(event);
  }));

  try {
    await waitFor(() => output.includes("Player") && output.includes("Library") && output.includes("Downloads"));
    expect(stripAnsi(output)).toContain("[ prev ] next");
    expect(await exists(osascriptSentinel)).toBe(false);
    if (process.platform === "linux") expect(stripAnsi(output)).not.toContain("Background");
    expect(output).toContain("\x1b[?1049h");
    expect(stripAnsi(output)).toContain("Packaged Playback");
    output = "";
    terminal.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 500));
    output = "";
    terminal.write("]");
    await waitFor(() => output.includes("▸ Library ◂"));
    output = "";
    terminal.write("]");
    await waitFor(() => output.includes("▸ Downloads ◂"));
    output = "";
    terminal.write("[");
    await waitFor(() => output.includes("▸ Library ◂"));
    output = "";
    terminal.write("\x11");
    await waitFor(() => stripAnsi(output).includes("Shut down TMU Daemon?") && stripAnsi(output).includes("connected clients"));
    output = "";
    terminal.write("n");
    await waitFor(() => stripAnsi(output).includes("▸ Library ◂") && !stripAnsi(output).includes("Shut down TMU Daemon?"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    terminal.write(quit === "q" ? "q" : "\x03");
    const exit = await withTimeout(exitPromise, 10_000, "Timed out waiting for packed terminal exit");
    expect(exit.exitCode, stripAnsi(output)).toBe(0);
    expect(output).toContain("\x1b[?1049l");
    const status = await exec(command, [...args, "daemon", "status"], { cwd: root, env });
    expect(status.stdout).toContain("TMU Daemon: ready");
    expect(status.stdout).toContain("Playing Playlist: Default");
    expect(status.stdout).toContain("Current Track: Packaged Playback");
    expect(status.stdout).toContain("Playback: playing");
    await expect(exec(command, [...args, "daemon", "stop"], { cwd: root, env })).rejects.toMatchObject({
      code: 2, stderr: expect.stringContaining("Refusing non-interactive daemon stop"),
    });
    const stopTerminal = spawn(command, [...args, "daemon", "stop"], { cols: 100, rows: 24, cwd: root, env });
    let stopOutput = ""; stopTerminal.onData((data) => { stopOutput += data; });
    const stopExit = new Promise<{ exitCode: number }>((resolve) => stopTerminal.onExit(resolve));
    await waitFor(() => stopOutput.includes("Shut down TMU Daemon? [y/N]"));
    stopTerminal.write("n\r");
    expect((await withTimeout(stopExit, 5_000, "Timed out cancelling interactive stop")).exitCode).toBe(0);
    expect(stopOutput).toContain("Shutdown cancelled");
    const forced = await exec(command, [...args, "daemon", "stop", "--force"], { cwd: root, env });
    expect(forced.stdout).toContain("Graceful daemon shutdown requested");
  } finally {
    if (!exited) terminal.kill();
    await withTimeout(exitPromise, 2_000, "Timed out cleaning up packed terminal process");
  }
}

async function expectPackagedConnectionLoss(command: string, env: Record<string, string>): Promise<void> {
  let output = "";
  const terminal = spawn(command, [], { cols: 100, rows: 24, cwd: root, env });
  terminal.onData((data) => { output += data; });
  const exitPromise = new Promise<{ exitCode: number }>((resolve) => terminal.onExit(resolve));
  try {
    await waitFor(() => stripAnsi(output).includes("Packaged Playback"));
    const ready = JSON.parse(await readFile(join(root, "runtime", "tmu", "ready.json"), "utf8")) as { pid: number };
    process.kill(ready.pid, "SIGKILL");
    await waitFor(() => stripAnsi(output).includes("TMU Daemon connection lost"));
    expect(stripAnsi(output)).toContain("Press q or Ctrl-C to exit");
    terminal.write("q");
    expect((await withTimeout(exitPromise, 5_000, "Timed out exiting connection-lost TUI")).exitCode).toBe(0);
    expect(output).toContain("\x1b[?1049l");
    await expect(exec(command, ["daemon", "status"], { cwd: root, env })).rejects.toMatchObject({ code: 1 });

    const recovery = spawn(command, [], { cols: 100, rows: 24, cwd: root, env });
    let recoveryOutput = ""; recovery.onData((data) => { recoveryOutput += data; });
    const recoveryExit = new Promise<{ exitCode: number }>((resolve) => recovery.onExit(resolve));
    await waitFor(() => stripAnsi(recoveryOutput).includes("Packaged Playback"));
    recovery.write("q");
    expect((await withTimeout(recoveryExit, 5_000, "Timed out exiting recovered TUI")).exitCode).toBe(0);
    await exec(command, ["daemon", "stop", "--force"], { cwd: root, env });
  } finally {
    terminal.kill();
  }
}

async function expectPackagedTuiShutdown(command: string, env: Record<string, string>): Promise<void> {
  let output = "";
  const terminal = spawn(command, [], { cols: 100, rows: 24, cwd: root, env });
  terminal.onData((data) => { output += data; });
  let exited = false;
  const exitPromise = new Promise<{ exitCode: number }>((resolve) => terminal.onExit((event) => {
    exited = true;
    resolve(event);
  }));
  try {
    await waitFor(() => stripAnsi(output).includes("Packaged Playback"));
    output = "";
    terminal.write("\x11");
    await waitFor(() => stripAnsi(output).includes("Shut down TMU Daemon?"));
    terminal.write("y");
    expect(
      (await withTimeout(exitPromise, 10_000, "Timed out waiting for TUI shutdown exit")).exitCode,
      stripAnsi(output),
    ).toBe(0);
    expect(output).toContain("\x1b[?1049l");
    expect(stripAnsi(output)).toContain("TMU Daemon is shutting down.");
  } finally {
    if (!exited) terminal.kill();
    await withTimeout(exitPromise, 2_000, "Timed out cleaning up shutdown terminal");
  }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

function stripAnsi(value: string): string {
  return value.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
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
