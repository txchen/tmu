import { describe, expect, test } from "bun:test";
import { access, chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";

const decoder = new TextDecoder();

async function waitForOutput(read: () => string, expected: string, timeoutMs = 8_000): Promise<void> {
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

async function waitForJsonFile<T>(
  path: string,
  predicate: (value: T) => boolean,
  timeoutMs = 8_000,
): Promise<T> {
  const startedAt = Date.now();
  let latest: T | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      latest = JSON.parse(await Bun.file(path).text()) as T;
      if (predicate(latest)) return latest;
    } catch {
      // The snapshot may not exist yet or may be between atomic writes.
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for JSON state in ${path}: ${JSON.stringify(latest)}`);
}

async function waitForStableFile(path: string, stableMs = 500, timeoutMs = 8_000): Promise<string> {
  const startedAt = Date.now();
  let latest = "";
  let stableSince = startedAt;
  while (Date.now() - startedAt < timeoutMs) {
    const next = await Bun.file(path).text();
    if (next !== latest) {
      latest = next;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return latest;
    }
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for stable file ${path}`);
}

async function resizeAndWait(
  terminal: Bun.Terminal,
  subprocess: { kill(signal?: NodeJS.Signals | number): void },
  read: () => string,
  from: number,
  columns: number,
  rows: number,
  expected: string,
): Promise<void> {
  terminal.resize(columns, rows);
  await Bun.sleep(20);
  subprocess.kill("SIGWINCH");
  await waitForNewOutput(read, from, expected);
}

async function expectTerminalRestored(terminal: Bun.Terminal, read: () => string): Promise<void> {
  const from = read().length;
  const stty = Bun.spawn(["sh", "-c", "stty -a; printf __AFTER_TMU__"], { terminal });
  expect(await stty.exited).toBe(0);
  await waitForOutput(read, "__AFTER_TMU__");
  const restoredState = read().slice(from).replaceAll("\r", " ").replaceAll("\n", " ");
  expect(restoredState).toMatch(/(?:^|[ ;])icanon(?:[ ;]|$)/);
  expect(restoredState).toMatch(/(?:^|[ ;])echo(?:[ ;]|$)/);
}

type PtyFixtureOptions = {
  playbackTrack?: boolean;
  corruptSnapshot?: boolean;
  searchTrack?: boolean;
  activeDownload?: boolean;
  navidromeUrl?: string;
  playbackProgressMs?: number;
  env?: Record<string, string>;
};

async function spawnTmu(
  onData: (text: string) => void,
  args: readonly string[] = [],
  options: PtyFixtureOptions = {},
) {
  return spawnFixtureEntrypoint(onData, "src/main.ts", args, options);
}

async function spawnFixtureEntrypoint(
  onData: (text: string) => void,
  entrypoint: string,
  args: readonly string[] = [],
  options: PtyFixtureOptions = {},
) {
  const runtimeRoot = `/tmp/tmu-pty-${process.pid}-${crypto.randomUUID()}`;
  if (options.playbackTrack) await seedPlaybackSnapshot(runtimeRoot);
  if (options.corruptSnapshot) await seedCorruptSnapshot(runtimeRoot);
  if (options.searchTrack) await seedSearchTrack(runtimeRoot);
  if (options.activeDownload) await seedDownloadFixture(runtimeRoot);
  if (options.navidromeUrl) await seedNavidromeConfig(runtimeRoot, options.navidromeUrl);
  if (options.playbackProgressMs !== undefined) await seedPlaybackCadence(runtimeRoot, options.playbackProgressMs);
  const terminal = new Bun.Terminal({
    cols: 120,
    rows: 24,
    data: (_terminal, data) => onData(decoder.decode(data)),
  });
  const subprocess = Bun.spawn(["bun", entrypoint, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      NO_COLOR: "1",
      XDG_CONFIG_HOME: `${runtimeRoot}/config`,
      XDG_STATE_HOME: `${runtimeRoot}/state`,
      XDG_CACHE_HOME: `${runtimeRoot}/cache`,
      ...options.env,
    },
    terminal,
  });
  return { terminal, subprocess, runtimeRoot };
}

async function seedNavidromeConfig(runtimeRoot: string, serverUrl: string): Promise<void> {
  await writeConfigFixture(runtimeRoot, JSON.stringify({
    providers: {
      navidrome: {
        enabled: true,
        serverUrl,
        username: "pty-user",
        password: "pty-password",
      },
    },
    dependencyPolicy: { checkTimeoutMs: 2_000 },
    lowPower: { providerProgressThrottleMs: 500 },
  }));
}

async function seedPlaybackCadence(runtimeRoot: string, playbackProgressMs: number): Promise<void> {
  await writeConfigFixture(runtimeRoot, JSON.stringify({
    lowPower: { playbackTickMs: 100, playbackProgressMs },
  }));
}

async function writeConfigFixture(runtimeRoot: string, contents: string): Promise<void> {
  await mkdir(`${runtimeRoot}/config/tmu`, { recursive: true });
  await writeFile(`${runtimeRoot}/config/tmu/config.json`, contents);
}

async function seedCorruptSnapshot(runtimeRoot: string): Promise<void> {
  const stateDir = `${runtimeRoot}/state/tmu`;
  await mkdir(stateDir, { recursive: true });
  await writeFile(`${stateDir}/last-queue.json`, "{invalid");
}

async function seedDownloadFixture(runtimeRoot: string): Promise<void> {
  const helper = `${runtimeRoot}/fake-yt-dlp.ts`;
  await mkdir(`${runtimeRoot}/config/tmu`, { recursive: true });
  await writeFile(helper, `#!/usr/bin/env bun
const args = Bun.argv.slice(2);
if (args.includes("--version")) { console.log("2026.07.09"); process.exit(0); }
if (args.includes("--dump-single-json")) {
  console.log(JSON.stringify({ extractor_key: "YouTube", id: "PtyDownload", title: "PTY Download" }));
  process.exit(0);
}
process.on("SIGTERM", () => process.exit(143));
console.log("[download] 5.0% of 10.00MiB at 1.00MiB/s ETA 00:10");
setInterval(() => console.log("[download] 25.0% of 10.00MiB at 1.00MiB/s ETA 00:08"), 100);
`);
  await chmod(helper, 0o755);
  await writeFile(`${runtimeRoot}/config/tmu/config.json`, JSON.stringify({
    helpers: { ytDlp: helper },
    lowPower: { downloadProgressThrottleMs: 500 },
  }));
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
          playbackLocator: { kind: "url", url: "https://example.test/secret-token" },
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
    positionSeconds: 12,
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

function subsonicOk(extra: Record<string, unknown> = {}) {
  return { "subsonic-response": { status: "ok", version: "1.16.1", ...extra } };
}

const realPlaybackTest = Bun.which("mpv") ? test : test.skip;

describe("production tmu real PTY", () => {
  test("restores a resumable Current Track without autoplay and retries a failed snapshot save", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; },
      [],
      { playbackTrack: true },
    );
    const stateDir = `${runtimeRoot}/state/tmu`;

    try {
      await waitForOutput(read, "Restored · Resume from 0:12");
      const idleFrame = output.length;
      await Bun.sleep(100);
      expect(output.slice(idleFrame)).not.toContain("Playing · PTY Track");

      await chmod(stateDir, 0o555);
      terminal.write("z");
      await waitForOutput(read, "Could not save Last Queue");
      expect(subprocess.exitCode).toBeNull();

      await chmod(stateDir, 0o755);
      terminal.write("+");
      await waitForOutput(read, "Vol 75%");
      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
      const saved = JSON.parse(await Bun.file(`${stateDir}/last-queue.json`).text());
      expect(saved).toMatchObject({ positionSeconds: 12, shuffle: true, repeatAll: false, volume: { percent: 75 } });
      expect(JSON.stringify(saved)).not.toContain("secret-token");
    } finally {
      await chmod(stateDir, 0o755).catch(() => undefined);
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("quarantines an invalid production snapshot once and does not replace it on quit", async () => {
    let output = "";
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; },
      [],
      { corruptSnapshot: true },
    );
    const stateDir = `${runtimeRoot}/state/tmu`;
    try {
      await waitForOutput(() => output, "Last Queue Snapshot was corrupted");
      expect((await readdir(stateDir)).filter((name) => name.includes(".corrupt-"))).toHaveLength(1);
      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
      expect(await Bun.file(`${stateDir}/last-queue.json`).exists()).toBe(false);
      expect((await readdir(stateDir)).filter((name) => name.includes(".corrupt-"))).toHaveLength(1);
    } finally {
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("searches Contextual Shortcut Help and invokes the Command Palette through the real PTY", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; },
      [],
      { playbackTrack: true },
    );

    try {
      await waitForOutput(read, "Queue · 3 Tracks", 10_000);
      expect(output).toContain("Enter Play Next");
      expect(output).toContain("? Help");
      expect(output).toContain(": Commands");
      terminal.write("?");
      await waitForOutput(read, "Picker Overlay · shortcut-help");
      expect(output).toContain("Play Next · Enter");
      terminal.write("/");
      terminal.write("immediately");
      await waitForOutput(read, "Play Now · Shift+Enter");

      terminal.write("\x1b");
      terminal.write("q");
      await Bun.sleep(50);
      const paletteFrame = output.length;
      terminal.write(":");
      await waitForNewOutput(read, paletteFrame, "Picker Overlay · command-palette");
      terminal.write("toggle shuffle");
      await waitForNewOutput(read, paletteFrame, "Toggle Shuffle");
      expect(output.slice(paletteFrame)).toContain("z");
      terminal.write("\r");
      await waitForNewOutput(read, paletteFrame, "Shuffle On");
      expect(output.slice(paletteFrame)).not.toContain("No matching actions");

      await Bun.sleep(50);
      const textPaletteFrame = output.length;
      terminal.write(":");
      await waitForNewOutput(read, textPaletteFrame, "Picker Overlay · command-palette");
      terminal.write("q");
      await waitForNewOutput(read, textPaletteFrame, "Search: q");
      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);

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
      let selectionFrame = output.length;
      terminal.write("j");
      await waitForNewOutput(read, selectionFrame, "› Offline YouTube Cache");
      selectionFrame = output.length;
      terminal.write("j");
      await waitForNewOutput(read, selectionFrame, "› PTY Search Track");
      terminal.write("\r");
      await waitForOutput(read, "Queue · 1 Tracks");

      const nextFrame = output.length;
      terminal.write("/");
      await Bun.sleep(30);
      terminal.write("\x15");
      await waitForNewOutput(read, nextFrame, "Providers");
    } finally {
      await stopTmu(terminal, subprocess);
    }
  }, 15_000);

  test("keeps successful Global Search results usable when Navidrome fails", async () => {
    let output = "";
    const read = () => output;
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          "subsonic-response": {
            status: "failed",
            error: { code: 40, message: "Wrong username or password" },
          },
        });
      },
    });
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; },
      [],
      { searchTrack: true, navidromeUrl: `http://${server.hostname}:${server.port}` },
    );

    try {
      await waitForOutput(read, "Queue · 0 Tracks");
      terminal.write("/");
      await waitForOutput(read, "Search:");
      terminal.write("PTY Search");
      await waitForOutput(read, "Search: PTY Search");
      terminal.write("\r");
      await waitForOutput(read, "Navidrome · Loading");
      await waitForOutput(read, "PTY Search Track");
      await waitForOutput(read, "Navidrome · Authentication failed", 10_000);
      const failureFrame = output.slice(output.lastIndexOf("PTY Search Track"));
      expect(failureFrame).toContain("Offline YouTube Cache");
      expect(failureFrame).toContain("Navidrome · Authentication failed");

      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      await stopTmu(terminal, subprocess);
      server.stop(true);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("coalesces configured Provider progress and publishes the latest metadata", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnFixtureEntrypoint(
      (text) => { output += text; }, "tests/fixtures/provider-cadence.ts",
    );

    try {
      await waitForOutput(read, "Provider metadata 0");
      const progressFrame = output.length;
      await waitForNewOutput(read, progressFrame, "Provider metadata 1");
      const firstProgressAt = Date.now();
      await Bun.sleep(300);
      expect(output.slice(progressFrame)).not.toContain("Provider metadata 2");

      await waitForNewOutput(read, progressFrame, "Provider metadata 2");
      const coalescedElapsed = Date.now() - firstProgressAt;
      expect(coalescedElapsed).toBeGreaterThanOrEqual(400);
      expect(coalescedElapsed).toBeLessThan(900);

      await waitForNewOutput(read, progressFrame, "Provider metadata 3");
      expect(Date.now() - firstProgressAt).toBeGreaterThanOrEqual(850);
      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);

  realPlaybackTest("resolves Music Collections atomically for Play Next and Play Now", async () => {
    let output = "";
    const read = () => output;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/search3.view")) {
          return Response.json(subsonicOk({ searchResult3: { song: [] } }));
        }
        if (url.pathname.endsWith("/getArtists.view")) {
          return Response.json(subsonicOk({ artists: { index: [{ artist: [
            { id: "pty-artist", name: "PTY Artist" },
          ] }] } }));
        }
        if (url.pathname.endsWith("/getArtist.view")) {
          return Response.json(subsonicOk({ artist: { album: [
                { id: "album-ok", name: "PTY Album", artist: "PTY Artist" },
                { id: "album-broken", name: "Broken Album", artist: "PTY Artist" },
          ] } }));
        }
        if (url.pathname.endsWith("/getAlbum.view")) {
          if (url.searchParams.get("id") === "album-broken") {
            return Response.json({
              "subsonic-response": {
                status: "failed",
                error: { code: 70, message: "Album temporarily unavailable" },
              },
            });
          }
          return Response.json(subsonicOk({
            album: {
              id: "album-ok",
              name: "PTY Album",
              artist: "PTY Artist",
              song: [
                { id: "collection-one", title: "Collection One", artist: "PTY Artist", duration: 60 },
                { id: "collection-two", title: "Collection Two", artist: "PTY Artist", duration: 60 },
              ],
            },
          }));
        }
        if (url.pathname.endsWith("/stream.view")) {
          return new Response(new Uint8Array(createWavSample(60)), { headers: { "content-type": "audio/wav" } });
        }
        return Response.json(subsonicOk());
      },
    });
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; }, [],
      { playbackTrack: true, navidromeUrl: `http://127.0.0.1:${server.port}` },
    );

    try {
      await waitForOutput(read, "Queue · 3 Tracks", 10_000);
      terminal.write("/");
      await waitForOutput(read, "Search:");
      terminal.write("Album");
      await waitForOutput(read, "Search: Album");
      terminal.write("\r");
      await waitForOutput(read, "PTY Album");
      let selectionFrame = output.length;
      terminal.write("G");
      await waitForNewOutput(read, selectionFrame, "› Offline YouTube Cache · No results");
      selectionFrame = output.length;
      terminal.write("k");
      await waitForNewOutput(read, selectionFrame, "› Local · No results");
      selectionFrame = output.length;
      terminal.write("k");
      await waitForNewOutput(read, selectionFrame, "› PTY Album · Navidrome · PTY Artist");

      terminal.write("\r");
      await waitForOutput(read, "Queue · 5 Tracks", 10_000);
      const snapshotPath = `${runtimeRoot}/state/tmu/last-queue.json`;
      type Snapshot = { entries: Array<{ track: { title: string } }>; currentIndex: number };
      let snapshot = await waitForJsonFile<Snapshot>(snapshotPath, (value) =>
        value.entries.length === 5 && value.entries[value.currentIndex]?.track.title === "PTY Track");
      expect(snapshot.entries[snapshot.currentIndex].track.title).toBe("PTY Track");

      terminal.write("\x1b[13;2u");
      snapshot = await waitForJsonFile<Snapshot>(snapshotPath, (value) =>
        value.entries[value.currentIndex]?.track.title === "Collection One");
      expect(snapshot.entries[snapshot.currentIndex].track.title).toBe("Collection One");

      const beforeFailure = await waitForStableFile(snapshotPath);
      selectionFrame = output.length;
      terminal.write("k");
      await waitForNewOutput(read, selectionFrame, "› Broken Album · Navidrome · PTY Artist");
      terminal.write("\r");
      await waitForOutput(read, "Could not load Music Collection: Album temporarily unavailable");
      expect(await Bun.file(snapshotPath).text()).toBe(beforeFailure);

      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      await stopTmu(terminal, subprocess);
      server.stop(true);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 20_000);

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
      await resizeAndWait(terminal, subprocess, read, nextFrame, 100, 24, "Playing Track");
      expect(output.slice(nextFrame)).not.toContain("Current:");
      nextFrame = output.length;
      await resizeAndWait(terminal, subprocess, read, nextFrame, 70, 24, "Picker Overlay · music-picker");
      expect(output.slice(nextFrame)).toContain("No Current Track");
      nextFrame = output.length;
      await resizeAndWait(terminal, subprocess, read, nextFrame, 50, 14, "Terminal too small");
      nextFrame = output.length;
      await resizeAndWait(terminal, subprocess, read, nextFrame, 130, 30, "Playing Track");
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

      await expectTerminalRestored(terminal, read);
    } finally {
      await stopTmu(terminal, subprocess);
    }
  });

  realPlaybackTest("bounds configured playback-position redraws without an idle loop", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; }, [],
      { playbackTrack: true, playbackProgressMs: 500 },
    );

    try {
      await waitForOutput(read, "Restored · Resume from 0:12");
      terminal.write(" ");
      await waitForOutput(read, "Playing · PTY Track");
      await Bun.sleep(150);
      const cadenceFrame = output.length;
      const cadenceStartedAt = Date.now();
      await Bun.sleep(300);
      expect(output).toHaveLength(cadenceFrame);
      await waitForNewOutput(read, cadenceFrame, "Playing · PTY Track · 0:13");
      expect(Date.now() - cadenceStartedAt).toBeLessThan(2_000);

      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);

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

  test("uses the complete ASCII marker set for a non-Unicode runtime locale", async () => {
    let output = "";
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; },
      [],
      { playbackTrack: true, env: { LC_ALL: "C", LANG: "C" } },
    );

    try {
      await waitForOutput(() => output, "Queue · 3 Tracks");
      expect(output).toContain("> *");
      expect(output).not.toContain("›");
      expect(output).not.toContain("●");
      expect(output).not.toMatch(/\x1b\[(?:3[0-7]|9[0-7])m/);
      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("restores the active TUI after a fatal process error", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnFixtureEntrypoint(
      (text) => { output += text; }, "tests/fixtures/fatal-after-mount.ts",
    );

    try {
      await waitForOutput(read, "Queue · 0 Tracks");
      expect(output).toContain("\x1b[?1049h");
      expect(await subprocess.exited).toBe(1);
      expect(output).toContain("Fatal error: Error: injected fatal error after terminal takeover");
      expect(output).toContain("\x1b[?1049l");
      expect(output).toContain("\x1b[?25h");

      await expectTerminalRestored(terminal, read);
    } finally {
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("keeps YouTube downloads running behind overlays and confirms cancellation and graceful quit", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; }, [], { activeDownload: true },
    );

    try {
      await waitForOutput(read, "Queue · 0 Tracks");
      terminal.write("u");
      await waitForOutput(read, "URL:");
      terminal.write("https://youtu.be/PtyDownload");
      await waitForOutput(read, "https://youtu.be/PtyDownload");
      terminal.write("\r");
      await waitForOutput(read, "download 5.0%");
      const initialProgress = output.length;
      const progressStartedAt = Date.now();
      await Bun.sleep(300);
      expect(output.slice(initialProgress)).not.toContain("download 25.0%");
      await waitForNewOutput(read, initialProgress, "download 25.0%");
      expect(Date.now() - progressStartedAt).toBeLessThan(1_500);

      let nextFrame = output.length;
      terminal.write("\x1b");
      await waitForNewOutput(read, nextFrame, "Queue · 0 Tracks");
      nextFrame = output.length;
      terminal.write("u");
      await waitForNewOutput(read, nextFrame, "download 5.0%");

      terminal.write("x");
      await waitForOutput(read, "Cancel YouTube download?");
      nextFrame = output.length;
      terminal.write("\r");
      await waitForNewOutput(read, nextFrame, "Download in progress");
      expect(subprocess.exitCode).toBeNull();
      expect(output).toContain("Download in progress");

      nextFrame = output.length;
      terminal.write("q");
      await waitForNewOutput(read, nextFrame, "Queue · 0 Tracks");
      nextFrame = output.length;
      terminal.write("q");
      await waitForNewOutput(read, nextFrame, "Quit during YouTube download?");
      nextFrame = output.length;
      terminal.write("\r");
      await waitForNewOutput(read, nextFrame, "Queue · 0 Tracks");
      expect(subprocess.exitCode).toBeNull();

      nextFrame = output.length;
      terminal.write("q");
      await waitForNewOutput(read, nextFrame, "Quit during YouTube download?");
      nextFrame = output.length;
      terminal.write("l");
      await waitForNewOutput(read, nextFrame, "[Quit]");
      terminal.write("\r");
      expect(await subprocess.exited).toBe(0);
      await expect(access(`${runtimeRoot}/cache/tmu/offline-youtube-cache/youtube/PtyDownload`)).rejects.toThrow();
      expect(output).toContain("\x1b[?1049l");
      expect(output).toContain("\x1b[?25h");
    } finally {
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);

  test("restores the terminal on an operating-system signal even when download cleanup fails", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; }, [], { activeDownload: true },
    );

    try {
      await waitForOutput(read, "Queue · 0 Tracks");
      terminal.write("u");
      await waitForOutput(read, "URL:");
      terminal.write("https://youtu.be/PtyDownload");
      await waitForOutput(read, "https://youtu.be/PtyDownload");
      terminal.write("\r");
      await waitForOutput(read, "download 5.0%");

      const youtubeCache = `${runtimeRoot}/cache/tmu/offline-youtube-cache/youtube`;
      await chmod(youtubeCache, 0o555);
      subprocess.kill("SIGTERM");
      expect(await subprocess.exited).toBe(143);
      await expect(access(`${youtubeCache}/PtyDownload`)).resolves.toBeNull();
      expect(output).toContain("\x1b[?1049l");
      expect(output).toContain("\x1b[?25h");
    } finally {
      await stopTmu(terminal, subprocess);
      await chmod(`${runtimeRoot}/cache/tmu/offline-youtube-cache/youtube`, 0o755).catch(() => undefined);
      await rm(runtimeRoot, { recursive: true, force: true });
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

  realPlaybackTest("routes explicit Resume and Current Track controls through real production PTY key input", async () => {
    let output = "";
    const read = () => output;
    const { terminal, subprocess, runtimeRoot } = await spawnTmu(
      (text) => { output += text; },
      [],
      { playbackTrack: true },
    );

    try {
      await waitForOutput(read, "Restored · Resume from 0:12");
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

      const unavailableTraversal = output.length;
      await writeAndWait("n", "Playing · PTY Last");
      expect(output.slice(unavailableTraversal)).not.toContain("Playing · PTY Missing");
      await writeAndWait(":", "Picker Overlay · command-palette");
      await writeAndWait("toggle repeat all", "Toggle Repeat All");
      await writeAndWait("\r", "Repeat All");
      await writeAndWait("z", "Shuffle On");

      terminal.write("\u0003");
      expect(await subprocess.exited).toBe(0);
    } finally {
      await stopTmu(terminal, subprocess);
      await rm(runtimeRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
