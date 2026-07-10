import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";

export type TmuConfig = {
  helpers: {
    mpv: string;
    ffprobe: string;
    ytDlp: string;
  };
  lowPower: {
    playbackTickMs: number;
    playbackProgressMs: number | null;
    downloadProgressThrottleMs: number;
    libraryProgressThrottleMs: number;
  };
  youtubeCache: {
    cacheDir: string;
    mediaDirName: string;
    metadataFileName: string;
  };
  youtube: {
    cookiesFromBrowser?: string;
    maxConcurrentDownloads: number;
  };
  dependencyPolicy: {
    checkTimeoutMs: number;
  };
  persistence: {
    lastQueueSnapshotPath: string;
    appPreferencesPath: string;
  };
};

export type RedactedTmuConfig = TmuConfig;
export type TmuConfigInput = PartialDeep<TmuConfig>;

export type LoadedTmuConfig = {
  path: string;
  source: "defaults" | "file";
  config: TmuConfig;
  redactedConfig: RedactedTmuConfig;
};

type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends object ? PartialDeep<T[K]> : T[K];
};

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "tmu", "config.json");
}

export function createDefaultTmuConfig(overrides: TmuConfigInput = {}): TmuConfig {
  const base: TmuConfig = {
    helpers: {
      mpv: "mpv",
      ffprobe: "ffprobe",
      ytDlp: "yt-dlp",
    },
    lowPower: {
      playbackTickMs: 1000,
      playbackProgressMs: null,
      downloadProgressThrottleMs: 1000,
      libraryProgressThrottleMs: 1000,
    },
    youtubeCache: {
      cacheDir: join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "tmu", "youtube-cache"),
      mediaDirName: "media",
      metadataFileName: "metadata.json",
    },
    youtube: {
      maxConcurrentDownloads: 1,
    },
    dependencyPolicy: {
      checkTimeoutMs: 10000,
    },
    persistence: {
      lastQueueSnapshotPath: join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "tmu", "last-queue.json"),
      appPreferencesPath: join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "tmu", "preferences.json"),
    },
  };

  return mergeConfig(base, normalizeConfigInput(overrides));
}

export async function loadTmuConfig(options: { path?: string } = {}): Promise<LoadedTmuConfig> {
  const path = options.path ?? defaultConfigPath();

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as TmuConfigInput;
    const config = createDefaultTmuConfig(parsed);
    return {
      path,
      source: "file",
      config,
      redactedConfig: redactTmuConfig(config),
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      const config = createDefaultTmuConfig();
      return {
        path,
        source: "defaults",
        config,
        redactedConfig: redactTmuConfig(config),
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load TMU config at ${path}: ${message}`);
  }
}

export function redactTmuConfig(config: TmuConfig): RedactedTmuConfig {
  return {
    ...config,
    helpers: { ...config.helpers },
    lowPower: { ...config.lowPower },
    youtubeCache: { ...config.youtubeCache },
    youtube: { ...config.youtube },
    dependencyPolicy: { ...config.dependencyPolicy },
    persistence: { ...config.persistence },
  };
}

function mergeConfig(base: TmuConfig, overrides: TmuConfigInput): TmuConfig {
  return {
    helpers: {
      ...base.helpers,
      ...overrides.helpers,
    },
    lowPower: {
      ...base.lowPower,
      ...overrides.lowPower,
    },
    youtubeCache: {
      ...base.youtubeCache,
      ...overrides.youtubeCache,
    },
    youtube: {
      ...base.youtube,
      ...overrides.youtube,
    },
    dependencyPolicy: {
      ...base.dependencyPolicy,
      ...overrides.dependencyPolicy,
    },
    persistence: {
      ...base.persistence,
      ...overrides.persistence,
    },
  };
}

function normalizeConfigInput(input: TmuConfigInput): TmuConfigInput {
  const maybeYoutube = input.youtube as (TmuConfig["youtube"] & { cookies_from_browser?: string }) | undefined;
  if (!maybeYoutube?.cookies_from_browser) return input;

  return {
    ...input,
    youtube: {
      ...input.youtube,
      cookiesFromBrowser: maybeYoutube.cookiesFromBrowser ?? maybeYoutube.cookies_from_browser,
    },
  };
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
    && "path" in error
    && dirname(String((error as NodeJS.ErrnoException).path ?? "")) !== "";
}
