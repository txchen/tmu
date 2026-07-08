#!/usr/bin/env bun
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createServer } from "node:http";
import { assertLinuxX64SmokeOutput, writeOfflineYouTubeCacheMetadata } from "../src/index";

type SmokeEnv = {
  root: string;
  configHome: string;
  stateHome: string;
  cacheHome: string;
  offlineCache: string;
  fakeBin: string;
  localSeed: string;
};

type RunResult = {
  stdout: string;
  stderr: string;
};

const executable = resolve(Bun.argv[2] ?? "dist/tmu-linux-x64");

async function main(): Promise<void> {
  const env = await createSmokeEnv();
  const navidrome = await startFakeNavidromeServer();

  try {
    await writeFakeHelpers(env.fakeBin);
    await writeOfflineCacheEntry(env);
    const present = await runPresentHelpersSmoke(env, navidrome.url);
    const missing = await runMissingHelpersSmoke(env);
    assertLinuxX64SmokeOutput({
      startup: present.startup.stdout,
      localSeed: present.localSeed.stdout,
      navidrome: present.navidrome.stdout,
      offlineCache: present.offlineCache.stdout,
      missingYtDlp: missing.youtubeMissing.stdout,
    });
    console.log(`packaged smoke ok: ${basename(executable)}`);
  } finally {
    await navidrome.close();
    await rm(env.root, { recursive: true, force: true });
  }
}

async function createSmokeEnv(): Promise<SmokeEnv> {
  const root = await mkdtemp(join(tmpdir(), "tmu-linux-x64-smoke-"));
  const configHome = join(root, "config");
  const stateHome = join(root, "state");
  const cacheHome = join(root, "cache");
  const offlineCache = join(root, "offline-youtube-cache");
  const fakeBin = join(root, "bin");
  const localSeed = join(root, "seed.mp3");
  await mkdir(join(configHome, "tmu"), { recursive: true });
  await mkdir(stateHome, { recursive: true });
  await mkdir(cacheHome, { recursive: true });
  await mkdir(offlineCache, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(localSeed, "not real audio");
  return { root, configHome, stateHome, cacheHome, offlineCache, fakeBin, localSeed };
}

async function runPresentHelpersSmoke(
  env: SmokeEnv,
  navidromeUrl: string,
): Promise<{
  startup: RunResult;
  localSeed: RunResult;
  navidrome: RunResult;
  offlineCache: RunResult;
}> {
  await writeConfig(env, {
    helpers: {
      mpv: join(env.fakeBin, "mpv"),
      ffprobe: join(env.fakeBin, "ffprobe"),
      ytDlp: join(env.fakeBin, "yt-dlp"),
    },
    providers: {
      navidrome: {
        enabled: true,
        serverUrl: navidromeUrl,
        username: "smoke",
        token: "token",
        salt: "salt",
      },
    },
    dependencyPolicy: {
      checkTimeoutMs: 1000,
    },
    offlineYouTubeCache: {
      cacheDir: env.offlineCache,
      mediaDirName: "media",
      metadataFileName: "metadata.json",
    },
  });

  const startup = await runExecutable(env, ["--snapshot"]);
  assertIncludes(startup.stdout, "TMU");
  assertIncludes(startup.stdout, "> Local");
  assertIncludes(startup.stdout, `mpv: present at ${join(env.fakeBin, "mpv")} (0.41.0)`);
  assertIncludes(startup.stdout, `ffprobe: present at ${join(env.fakeBin, "ffprobe")} (7.1)`);
  assertIncludes(startup.stdout, `yt-dlp: present at ${join(env.fakeBin, "yt-dlp")} (2026.01.02)`);

  const localSeed = await runExecutable(env, ["--snapshot", "--snapshot-target=queue", env.localSeed]);
  assertIncludes(localSeed.stdout, "Expanded Queue");
  assertIncludes(localSeed.stdout, "seed.mp3 - Local - queued");

  const navidromeOutput = await runExecutable(env, ["--snapshot", "--snapshot-target=navidrome"]);
  assertIncludes(navidromeOutput.stdout, "TMU");
  assertIncludes(navidromeOutput.stdout, "> Navidrome");
  assertIncludes(navidromeOutput.stdout, "Navidrome: connected");
  assertIncludes(navidromeOutput.stdout, "Smoke Artist");
  assertIncludes(navidromeOutput.stdout, `mpv: present at ${join(env.fakeBin, "mpv")} (0.41.0)`);
  assertIncludes(navidromeOutput.stdout, `ffprobe: present at ${join(env.fakeBin, "ffprobe")} (7.1)`);
  assertIncludes(navidromeOutput.stdout, `yt-dlp: present at ${join(env.fakeBin, "yt-dlp")} (2026.01.02)`);

  const offlineOutput = await runExecutable(env, ["--snapshot", "--snapshot-target=offline-youtube-cache"]);
  assertIncludes(offlineOutput.stdout, "> Offline YouTube Cache");
  assertIncludes(offlineOutput.stdout, "Cached Smoke Track  Offline YouTube Cache");

  return {
    startup,
    localSeed,
    navidrome: navidromeOutput,
    offlineCache: offlineOutput,
  };
}

async function runMissingHelpersSmoke(env: SmokeEnv): Promise<{ youtubeMissing: RunResult }> {
  await writeConfig(env, {
    helpers: {
      mpv: join(env.root, "missing-mpv"),
      ffprobe: join(env.root, "missing-ffprobe"),
      ytDlp: join(env.root, "missing-yt-dlp"),
    },
    dependencyPolicy: {
      checkTimeoutMs: 200,
    },
    offlineYouTubeCache: {
      cacheDir: env.offlineCache,
      mediaDirName: "media",
      metadataFileName: "metadata.json",
    },
  });

  const output = await runExecutable(env, [
    "--snapshot",
    "--snapshot-target=youtube-url-download",
  ]);

  assertIncludes(output.stdout, "> YouTube URL Download");
  assertIncludes(output.stdout, `mpv: missing at ${join(env.root, "missing-mpv")} - playback disabled`);
  assertIncludes(output.stdout, `ffprobe: missing at ${join(env.root, "missing-ffprobe")} - metadata degraded`);
  assertIncludes(output.stdout, `yt-dlp: missing at ${join(env.root, "missing-yt-dlp")} - YouTube URL Download disabled`);
  assertIncludes(output.stdout, `YouTube URL Download disabled: yt-dlp missing at ${join(env.root, "missing-yt-dlp")}`);

  return { youtubeMissing: output };
}

async function writeOfflineCacheEntry(env: SmokeEnv): Promise<void> {
  await writeOfflineYouTubeCacheMetadata({
    cacheDir: env.offlineCache,
    mediaDirName: "media",
    metadataFileName: "metadata.json",
  }, {
    version: 1,
    extractor: "youtube",
    id: "smoke-cache",
    title: "Cached Smoke Track",
    artist: "Smoke Artist",
    mediaFileName: "cached-smoke.opus",
  });
  await writeFile(join(env.offlineCache, "youtube", "smoke-cache", "media", "cached-smoke.opus"), "audio bytes");
}

async function runExecutable(env: SmokeEnv, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn([executable, ...args], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: env.configHome,
      XDG_STATE_HOME: env.stateHome,
      XDG_CACHE_HOME: env.cacheHome,
      PATH: `${env.fakeBin}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`packaged executable exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return { stdout, stderr };
}

async function writeConfig(env: SmokeEnv, config: unknown): Promise<void> {
  await writeFile(
    join(env.configHome, "tmu", "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

async function writeFakeHelpers(fakeBin: string): Promise<void> {
  await writeExecutable(join(fakeBin, "mpv"), fakeMpvSource());
  await writeExecutable(join(fakeBin, "ffprobe"), shellSource("echo 'ffprobe version 7.1'"));
  await writeExecutable(join(fakeBin, "yt-dlp"), shellSource("echo '2026.01.02'"));
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source, "utf8");
  await chmod(path, 0o755);
}

function shellSource(command: string): string {
  return `#!/usr/bin/env sh\n${command}\n`;
}

function fakeMpvSource(): string {
  return `#!/usr/bin/env bun
import net from "node:net";
import { rm } from "node:fs/promises";

if (process.argv.includes("--version")) {
  console.log("mpv 0.41.0");
  process.exit(0);
}

const ipcArg = process.argv.find((arg) => arg.startsWith("--input-ipc-server="));
const ipcPath = ipcArg?.slice("--input-ipc-server=".length);
if (!ipcPath) process.exit(2);

await rm(ipcPath, { force: true }).catch(() => undefined);
const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += String(chunk);
    while (buffer.includes("\\n")) {
      const index = buffer.indexOf("\\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;

      const message = JSON.parse(line);
      const command = Array.isArray(message.command) ? message.command : [];
      const response = { request_id: message.request_id, error: "success", data: null };
      if (command[0] === "get_property" && command[1] === "volume") response.data = 100;
      socket.write(JSON.stringify(response) + "\\n");
      if (command[0] === "quit") {
        socket.end();
        server.close(() => process.exit(0));
      }
    }
  });
});

server.listen(ipcPath);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
`;
}

function startFakeNavidromeServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.setHeader("content-type", "application/json");
    if (pathname.endsWith("/getArtists.view")) {
      response.end(JSON.stringify({
        "subsonic-response": {
          status: "ok",
          version: "1.16.1",
          artists: {
            index: [
              {
                name: "S",
                artist: [
                  { id: "artist-smoke", name: "Smoke Artist", albumCount: 1 },
                ],
              },
            ],
          },
        },
      }));
      return;
    }

    response.end(JSON.stringify({
      "subsonic-response": {
        status: "ok",
        version: "1.16.1",
      },
    }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("fake Navidrome server did not bind to a TCP port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((error) => error ? closeReject(error) : closeResolve());
        }),
      });
    });
  });
}

function assertIncludes(text: string, expected: string): void {
  if (text.includes(expected)) return;
  throw new Error(`expected smoke output to include ${JSON.stringify(expected)}\n\n${text}`);
}

await main();
