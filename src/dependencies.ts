import { execFile } from "node:child_process";
import type { TmuConfig } from "./config";

export type HelperName = "mpv" | "ffprobe" | "yt-dlp";

export type DependencyCommandRequest = {
  helper: HelperName;
  command: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
};

export type DependencyCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorMessage?: string;
};

export type DependencyCommandRunner = (request: DependencyCommandRequest) => Promise<DependencyCommandResult>;

export type HelperDependencyHealth = {
  name: HelperName;
  command: string;
  status: "present" | "missing";
  version?: string;
  message?: string;
};

export type DependencyHealthState = {
  helpers: Record<HelperName, HelperDependencyHealth>;
  playback: {
    enabled: boolean;
    message?: string;
  };
  metadata: {
    degraded: boolean;
    message?: string;
  };
  youtubeUrlDownload: {
    enabled: boolean;
    message?: string;
  };
};

export type DependencyCheckConfig = Pick<TmuConfig, "helpers" | "dependencyPolicy">;

type DependencyHealthInput = PartialDeep<DependencyHealthState>;

type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends object ? PartialDeep<T[K]> : T[K];
};

export function createDefaultDependencyHealth(overrides: DependencyHealthInput = {}): DependencyHealthState {
  const base: DependencyHealthState = {
    helpers: {
      mpv: { name: "mpv", command: "mpv", status: "present" },
      ffprobe: { name: "ffprobe", command: "ffprobe", status: "present" },
      "yt-dlp": { name: "yt-dlp", command: "yt-dlp", status: "present" },
    },
    playback: {
      enabled: true,
    },
    metadata: {
      degraded: false,
    },
    youtubeUrlDownload: {
      enabled: true,
    },
  };

  return {
    helpers: {
      mpv: {
        ...base.helpers.mpv,
        ...overrides.helpers?.mpv,
      },
      ffprobe: {
        ...base.helpers.ffprobe,
        ...overrides.helpers?.ffprobe,
      },
      "yt-dlp": {
        ...base.helpers["yt-dlp"],
        ...overrides.helpers?.["yt-dlp"],
      },
    },
    playback: {
      ...base.playback,
      ...overrides.playback,
    },
    metadata: {
      ...base.metadata,
      ...overrides.metadata,
    },
    youtubeUrlDownload: {
      ...base.youtubeUrlDownload,
      ...overrides.youtubeUrlDownload,
    },
  };
}

export async function checkDependencyHealth(
  config: DependencyCheckConfig,
  options: { runner?: DependencyCommandRunner } = {},
): Promise<DependencyHealthState> {
  const runner = options.runner ?? nodeDependencyCommandRunner;
  const timeoutMs = config.dependencyPolicy.checkTimeoutMs;

  const [mpv, ffprobe, ytDlp] = await Promise.all([
    checkHelper("mpv", helperCommand(config, "mpv"), helperVersionArgs("mpv"), timeoutMs, runner),
    checkHelper("ffprobe", helperCommand(config, "ffprobe"), helperVersionArgs("ffprobe"), timeoutMs, runner),
    checkHelper("yt-dlp", helperCommand(config, "yt-dlp"), helperVersionArgs("yt-dlp"), timeoutMs, runner),
  ]);

  return dependencyHealthFromHelpers({
    mpv,
    ffprobe,
    "yt-dlp": ytDlp,
  });
}

export async function checkHelperDependencyHealth(
  config: DependencyCheckConfig,
  helper: HelperName,
  currentHealth: DependencyHealthState,
  options: { runner?: DependencyCommandRunner } = {},
): Promise<DependencyHealthState> {
  const runner = options.runner ?? nodeDependencyCommandRunner;
  const checked = await checkHelper(
    helper,
    helperCommand(config, helper),
    helperVersionArgs(helper),
    config.dependencyPolicy.checkTimeoutMs,
    runner,
  );

  return dependencyHealthFromHelpers({
    ...currentHealth.helpers,
    [helper]: checked,
  });
}

export function playbackHealthMessage(health: DependencyHealthState): string | undefined {
  return health.playback.enabled ? undefined : health.playback.message;
}

export function youtubeDownloadHealthMessage(health: DependencyHealthState): string | undefined {
  return health.youtubeUrlDownload.enabled ? undefined : health.youtubeUrlDownload.message;
}

async function checkHelper(
  name: HelperName,
  command: string,
  args: string[],
  timeoutMs: number,
  runner: DependencyCommandRunner,
): Promise<HelperDependencyHealth> {
  try {
    const result = await runner({ helper: name, command, args, timeoutMs });
    if (result.exitCode === 0) {
      return {
        name,
        command,
        status: "present",
        version: detectVersion(name, result.stdout, result.stderr),
      };
    }

    return {
      name,
      command,
      status: "missing",
      message: result.errorMessage,
    };
  } catch (error) {
    return {
      name,
      command,
      status: "missing",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function dependencyHealthFromHelpers(
  helpers: Record<HelperName, HelperDependencyHealth>,
): DependencyHealthState {
  const mpvMissing = helpers.mpv.status === "missing";
  const ffprobeMissing = helpers.ffprobe.status === "missing";
  const ytDlpMissing = helpers["yt-dlp"].status === "missing";

  return {
    helpers,
    playback: {
      enabled: !mpvMissing,
      message: mpvMissing ? `Playback disabled: mpv missing at ${helpers.mpv.command}` : undefined,
    },
    metadata: {
      degraded: ffprobeMissing,
      message: ffprobeMissing ? `Metadata degraded: ffprobe missing at ${helpers.ffprobe.command}` : undefined,
    },
    youtubeUrlDownload: {
      enabled: !ytDlpMissing,
      message: ytDlpMissing
        ? `YouTube URL Download disabled: yt-dlp missing at ${helpers["yt-dlp"].command}`
        : undefined,
    },
  };
}

function detectVersion(name: HelperName, stdout: string, stderr: string): string | undefined {
  const text = `${stdout}\n${stderr}`;
  if (name === "mpv") return text.match(/\bmpv\s+([^\s]+)/i)?.[1];
  if (name === "ffprobe") return text.match(/\bffprobe version\s+([^\s]+)/i)?.[1];

  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return firstLine;
}

function helperCommand(config: DependencyCheckConfig, helper: HelperName): string {
  if (helper === "yt-dlp") return config.helpers.ytDlp;
  return config.helpers[helper];
}

function helperVersionArgs(helper: HelperName): string[] {
  return helper === "ffprobe" ? ["-version"] : ["--version"];
}

export const nodeDependencyCommandRunner: DependencyCommandRunner = ({ command, args, timeoutMs, signal }) => {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, signal }, (error, stdout, stderr) => {
      const errorCode = (error as (Error & { code?: string | number }) | null)?.code;
      const timedOut = Boolean(
        error
          && "killed" in error
          && (error as Error & { killed?: boolean; signal?: string }).killed
          && (error as Error & { killed?: boolean; signal?: string }).signal === "SIGTERM"
          && !signal?.aborted,
      );
      const exitCode = typeof errorCode === "number"
        ? errorCode
        : error
          ? null
          : 0;

      resolve({
        exitCode,
        stdout: String(stdout),
        stderr: String(stderr),
        errorMessage: timedOut
          ? `Command timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : undefined,
      });
    });
  });
};
