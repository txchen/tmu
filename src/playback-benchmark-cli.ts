import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { MpvPlayer, NodeMpvProcessAdapter, type MpvProcessHandle } from "./player";
import { parsePlaybackBenchmarkInput } from "./playback-benchmark";

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const powerModeIndex = process.argv.indexOf("--power-mode");
  const powerMode = powerModeIndex >= 0 ? process.argv[powerModeIndex + 1] : undefined;
  if (!inputPath || !powerMode) {
    throw new Error("usage: npm run benchmark:playback -- <track-input.json> --power-mode <description>");
  }

  const input = parsePlaybackBenchmarkInput(await readFile(inputPath, "utf8"));
  const identifier = randomUUID();
  const ipcPath = join(tmpdir(), `tmu-playback-${identifier}.sock`);
  let mpvProcess: MpvProcessHandle | undefined;
  const nodeAdapter = new NodeMpvProcessAdapter();
  const adapter = {
    startMpv(command: string, args: string[], options: { cwd: string }) {
      mpvProcess = nodeAdapter.startMpv(command, args, options);
      return mpvProcess;
    },
    waitForIpc: nodeAdapter.waitForIpc.bind(nodeAdapter),
    connectIpc: nodeAdapter.connectIpc.bind(nodeAdapter),
    cleanupIpc: nodeAdapter.cleanupIpc.bind(nodeAdapter),
  };
  const player = new MpvPlayer({
    command: "mpv",
    ipcPath,
    workDir: dirname(input.playbackLocator.path),
    adapter,
    positionPollMs: 1000,
    audioOutput: "null",
  });
  const cpuBefore = process.cpuUsage();
  const resourcesBefore = process.resourceUsage();
  const started = process.hrtime.bigint();
  let playbackCompleted = false;
  let child: ReturnType<typeof readLinuxProcessMetrics> | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = player.onPlaybackStateChange((state) => {
        if (state.eof) {
          playbackCompleted = true;
          unsubscribe();
          resolve();
        } else if (state.failureKind === "playback" || state.status === "error") {
          unsubscribe();
          reject(new Error(state.message ?? "mpv playback failed"));
        }
      });
      player.load(input.playbackLocator).catch(reject);
    });
    if (!mpvProcess?.pid) throw new Error("mpv process ID is unavailable");
    child = readLinuxProcessMetrics(mpvProcess.pid);
  } finally {
    await player.teardown();
  }

  const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
  const cpu = process.cpuUsage(cpuBefore);
  const resources = process.resourceUsage();
  if (!child) throw new Error("mpv resource metrics are unavailable");
  const controllerCpuSeconds = (cpu.user + cpu.system) / 1e6;
  const childCpuSeconds = child.userCpuSeconds + child.systemCpuSeconds;
  const output = {
    schemaVersion: 1,
    track: input.track,
    environment: {
      runtime: `Node.js ${process.version}`,
      mpv: firstLine(execFileSync("mpv", ["--version"], { encoding: "utf8" })),
      machine: hostname(),
      powerMode,
      positionPollMs: 1000,
      audioOutput: "null",
    },
    metrics: {
      controller: {
        cpuSeconds: controllerCpuSeconds,
        userCpuSeconds: cpu.user / 1e6,
        systemCpuSeconds: cpu.system / 1e6,
        peakRssKib: resources.maxRSS,
        voluntaryContextSwitches: resources.voluntaryContextSwitches - resourcesBefore.voluntaryContextSwitches,
        involuntaryContextSwitches: resources.involuntaryContextSwitches - resourcesBefore.involuntaryContextSwitches,
      },
      child: {
        cpuSeconds: childCpuSeconds,
        userCpuSeconds: child.userCpuSeconds,
        systemCpuSeconds: child.systemCpuSeconds,
        peakRssKib: child.peakRssKib,
        voluntaryContextSwitches: child.voluntary,
        involuntaryContextSwitches: child.involuntary,
      },
      childInclusive: { cpuSeconds: controllerCpuSeconds + childCpuSeconds },
      elapsedSeconds,
      playbackCompleted,
    },
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function readLinuxProcessMetrics(pid: number): {
  userCpuSeconds: number; systemCpuSeconds: number; peakRssKib: number; voluntary: number; involuntary: number;
} {
  const stat = execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
  const ticksPerSecond = Number(stat.trim());
  const processStat = execFileSync("sed", ["-n", "1p", `/proc/${pid}/stat`], { encoding: "utf8" });
  const closeName = processStat.lastIndexOf(")");
  const fields = processStat.slice(closeName + 2).split(" ");
  const status = execFileSync("sed", ["-n", "/^VmHWM:\\|^voluntary_ctxt_switches:\\|^nonvoluntary_ctxt_switches:/p", `/proc/${pid}/status`], { encoding: "utf8" });
  const values = Object.fromEntries(status.trim().split("\n").map((line) => {
    const [key, value] = line.split(/:\s+/, 2);
    return [key, Number(value?.split(/\s+/, 1)[0])];
  }));
  return {
    userCpuSeconds: Number(fields[11]) / ticksPerSecond,
    systemCpuSeconds: Number(fields[12]) / ticksPerSecond,
    peakRssKib: values.VmHWM ?? 0,
    voluntary: values.voluntary_ctxt_switches ?? 0,
    involuntary: values.nonvoluntary_ctxt_switches ?? 0,
  };
}

function firstLine(value: string): string {
  return value.split("\n", 1)[0] ?? value;
}

const isEntrypoint = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
