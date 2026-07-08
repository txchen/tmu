import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";

export type TmuConfig = {
  helpers: {
    mpv: string;
    ffprobe: string;
    ytDlp: string;
  };
  providers: {
    local: {
      enabled: boolean;
      directorySoftCap: number;
    };
    navidrome: {
      enabled: boolean;
      serverUrl: string;
      username: string;
      password?: string;
      token?: string;
      salt?: string;
      apiVersion: string;
      clientName: string;
      scrobble: boolean;
    };
    offlineYouTubeCache: {
      enabled: boolean;
    };
    youtubeUrlDownload: {
      enabled: boolean;
    };
  };
  lowPower: {
    playbackTickMs: number;
    downloadProgressThrottleMs: number;
    providerProgressThrottleMs: number;
  };
  offlineYouTubeCache: {
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
  };
};

export type RedactedTmuConfig = Omit<TmuConfig, "providers"> & {
  providers: Omit<TmuConfig["providers"], "navidrome"> & {
    navidrome: Omit<TmuConfig["providers"]["navidrome"], "password" | "token" | "salt"> & {
      password?: "[redacted]";
      token?: "[redacted]";
      salt?: "[redacted]";
    };
  };
};
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
    providers: {
      local: {
        enabled: true,
        directorySoftCap: 10000,
      },
      navidrome: {
        enabled: false,
        serverUrl: "",
        username: "",
        apiVersion: "1.16.1",
        clientName: "tmu",
        scrobble: true,
      },
      offlineYouTubeCache: {
        enabled: true,
      },
      youtubeUrlDownload: {
        enabled: true,
      },
    },
    lowPower: {
      playbackTickMs: 500,
      downloadProgressThrottleMs: 500,
      providerProgressThrottleMs: 500,
    },
    offlineYouTubeCache: {
      cacheDir: join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "tmu", "offline-youtube-cache"),
      mediaDirName: "media",
      metadataFileName: "metadata.json",
    },
    youtube: {
      maxConcurrentDownloads: 1,
    },
    dependencyPolicy: {
      checkTimeoutMs: 2000,
    },
    persistence: {
      lastQueueSnapshotPath: join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "tmu", "last-queue.json"),
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
    providers: {
      local: { ...config.providers.local },
      navidrome: {
        ...config.providers.navidrome,
        password: redactSecret(config.providers.navidrome.password),
        token: redactSecret(config.providers.navidrome.token),
        salt: redactSecret(config.providers.navidrome.salt),
      },
      offlineYouTubeCache: { ...config.providers.offlineYouTubeCache },
      youtubeUrlDownload: { ...config.providers.youtubeUrlDownload },
    },
    lowPower: { ...config.lowPower },
    offlineYouTubeCache: { ...config.offlineYouTubeCache },
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
    providers: {
      local: {
        ...base.providers.local,
        ...overrides.providers?.local,
      },
      navidrome: {
        ...base.providers.navidrome,
        ...overrides.providers?.navidrome,
      },
      offlineYouTubeCache: {
        ...base.providers.offlineYouTubeCache,
        ...overrides.providers?.offlineYouTubeCache,
      },
      youtubeUrlDownload: {
        ...base.providers.youtubeUrlDownload,
        ...overrides.providers?.youtubeUrlDownload,
      },
    },
    lowPower: {
      ...base.lowPower,
      ...overrides.lowPower,
    },
    offlineYouTubeCache: {
      ...base.offlineYouTubeCache,
      ...overrides.offlineYouTubeCache,
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

function redactSecret(value: string | undefined): "[redacted]" | undefined {
  return value ? "[redacted]" : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT"
    && "path" in error
    && dirname(String((error as NodeJS.ErrnoException).path ?? "")) !== "";
}
