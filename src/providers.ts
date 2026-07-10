import { readdirSync, realpathSync, statSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  createDefaultDependencyHealth,
  nodeDependencyCommandRunner,
  type DependencyCommandRunner,
  type DependencyHealthState,
} from "./dependencies";
import { createDefaultTmuConfig } from "./config";
import {
  identityKey,
  type PlaybackLocator,
  type Provider,
  type ProviderBrowserEntry,
  type ProviderCapabilities,
  type Track,
  type TrackIdentity,
} from "./domain";
import { createNavidromeProvider, type NavidromeProviderOptions } from "./navidrome";
import {
  OFFLINE_YOUTUBE_CACHE_PROVIDER_ID,
  createOfflineYouTubeCacheProvider,
  type OfflineYouTubeCacheProviderOptions,
} from "./offline-youtube-cache";

const LOCAL_PROVIDER_ID = "local";
const LOCAL_CAPABILITIES: ProviderCapabilities = {
  searchableResultTypes: ["track"],
  browsableHierarchy: ["local-directory", "track"],
  operations: [],
};
export const DEFAULT_LOCAL_DIRECTORY_SOFT_CAP = 10_000;

const COMMON_AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".alac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
  ".wma",
]);

type CanonicalLocalFile = {
  path: string;
  title: string;
  size: number;
  mtimeMs: number;
};

type FfprobeJson = {
  streams?: Array<{ codec_type?: unknown }>;
  format?: {
    duration?: unknown;
    tags?: Record<string, unknown>;
  };
};

export type LocalTrackMetadataListener = (track: Track) => void;

export type LocalOpenOptions = {
  signal?: AbortSignal;
  softCap?: number;
};

export type LocalOpenResult = {
  tracks: Track[];
  capped: boolean;
  cancelled: boolean;
};

export type LocalProviderOptions = {
  dependencyHealth?: DependencyHealthState;
  ffprobeCommand?: string;
  runner?: DependencyCommandRunner;
  metadataTimeoutMs?: number;
  metadataConcurrency?: number;
  directorySoftCap?: number;
};

export type LocalProvider = Provider & {
  createTrackFromPath(path: string): Promise<Track | undefined>;
  createTracksFromOpenPath(path: string, options?: LocalOpenOptions): Promise<LocalOpenResult>;
  onTrackMetadataChange(listener: LocalTrackMetadataListener): () => void;
};

class SkeletonProvider implements Provider {
  readonly capabilities: ProviderCapabilities = {
    searchableResultTypes: [], browsableHierarchy: [], operations: [],
  };

  getNavigationRoot() {
    return { visible: false, order: 40, detail: this.hint };
  }
  constructor(
    readonly id: string,
    readonly label: string,
    readonly hint: string,
    private readonly tracks: readonly Track[],
  ) {}

  listVisibleTracks(): readonly Track[] {
    return this.tracks;
  }

  async resolvePlaybackLocator(identity: TrackIdentity): Promise<PlaybackLocator> {
    return { kind: "file", path: `skeleton://${identity.providerId}/${identity.stableId}` };
  }
}

class FileSystemLocalProvider implements LocalProvider {
  readonly id = LOCAL_PROVIDER_ID;
  readonly label = "Local";
  readonly hint = "files and folders";
  readonly capabilities = LOCAL_CAPABILITIES;

  getNavigationRoot() {
    return { visible: true, order: 10, detail: this.hint };
  }

  private readonly dependencyHealth: DependencyHealthState;
  private readonly ffprobeCommand: string;
  private readonly runner: DependencyCommandRunner;
  private readonly metadataTimeoutMs: number;
  private readonly metadataConcurrency: number;
  private readonly directorySoftCap: number;
  private readonly tracks = new Map<string, Track>();
  private readonly metadataCache = new Map<string, Partial<Track>>();
  private readonly metadataInFlight = new Set<string>();
  private readonly metadataQueue: Array<{ file: CanonicalLocalFile; track: Track; cacheKey: string }> = [];
  private readonly metadataListeners = new Set<LocalTrackMetadataListener>();
  private activeMetadataJobs = 0;

  constructor(options: LocalProviderOptions = {}) {
    this.dependencyHealth = options.dependencyHealth ?? createDefaultDependencyHealth();
    this.ffprobeCommand = options.ffprobeCommand ?? this.dependencyHealth.helpers.ffprobe.command;
    this.runner = options.runner ?? nodeDependencyCommandRunner;
    this.metadataTimeoutMs = options.metadataTimeoutMs ?? 2000;
    this.metadataConcurrency = Math.max(1, Math.floor(options.metadataConcurrency ?? 2));
    this.directorySoftCap = normalizeSoftCap(options.directorySoftCap ?? DEFAULT_LOCAL_DIRECTORY_SOFT_CAP);
  }

  listVisibleTracks(): readonly Track[] {
    return [...this.tracks.values()];
  }

  listBrowserEntries(location: import("./domain").ProviderLocation): readonly ProviderBrowserEntry[] {
    return this.localBrowserRows(location).map(({ entry }) => entry);
  }

  playableTargetAt(location: import("./domain").ProviderLocation, index: number): Track | undefined {
    return this.localBrowserRows(location)[index]?.track;
  }

  private localBrowserRows(location: import("./domain").ProviderLocation): Array<{
    entry: ProviderBrowserEntry;
    track?: Track;
  }> {
    if (location.providerId !== LOCAL_PROVIDER_ID) return [];
    const directory = location.path.at(-1) || process.cwd();
    let names: string[];
    try {
      names = readdirSync(directory).sort(comparePathNames);
    } catch {
      return [];
    }

    const rows: Array<{ entry: ProviderBrowserEntry; track?: Track }> = [];
    for (const name of names) {
      if (isHiddenPathSegment(name)) continue;
      const path = join(directory, name);
      let pathStat;
      try {
        pathStat = statSync(path);
      } catch {
        continue;
      }
      if (pathStat.isDirectory()) {
        rows.push({ entry: { id: path, kind: "local-directory", label: name, detail: path } });
        continue;
      }
      if (!pathStat.isFile() || !isCommonAudioExtension(path)) continue;
      const canonical = canonicalLocalFileFromPath(path);
      if (!canonical) continue;
      const track = this.acceptFile(canonical);
      rows.push({ entry: { id: track.identity.stableId, kind: "track", label: track.title }, track });
    }
    return rows;
  }

  async createTrackFromPath(path: string): Promise<Track | undefined> {
    const file = canonicalLocalFileFromPath(path);
    if (!file) return undefined;

    if (isCommonAudioExtension(file.path)) {
      return this.acceptFile(file);
    }

    if (!this.canUseFfprobe()) return undefined;

    return await this.probeAudio(file) ? this.acceptFile(file) : undefined;
  }

  async createTracksFromOpenPath(path: string, options: LocalOpenOptions = {}): Promise<LocalOpenResult> {
    const result: LocalOpenResult = {
      tracks: [],
      capped: false,
      cancelled: false,
    };
    const selectedPath = path.trim();
    if (!selectedPath) return result;

    const softCap = normalizeSoftCap(options.softCap ?? this.directorySoftCap);
    const addTrack = (track: Track | undefined) => {
      if (result.tracks.length >= softCap) {
        result.capped = true;
        return;
      }
      if (!track) return;
      result.tracks.push(track);
      if (result.tracks.length >= softCap) result.capped = true;
    };

    const checkCancelled = () => {
      if (!options.signal?.aborted) return false;
      result.cancelled = true;
      return true;
    };

    if (checkCancelled()) return result;

    const selectedKind = await selectedLocalPathKind(selectedPath);
    if (checkCancelled() || !selectedKind) return result;

    if (selectedKind.kind === "file") {
      addTrack(await this.createTrackFromPath(selectedPath));
      return result;
    }

    if (selectedKind.kind === "directory-symlink") return result;

    await this.walkDirectoryForOpenPath(selectedPath, {
      result,
      checkCancelled,
      addTrack,
    });
    return result;
  }

  async resolvePlaybackLocator(identity: TrackIdentity): Promise<PlaybackLocator> {
    if (identity.providerId !== LOCAL_PROVIDER_ID) {
      throw new Error(`Local Provider cannot resolve ${identity.providerId}`);
    }

    let fileStat;
    try {
      fileStat = await stat(identity.stableId);
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new Error(`Local file no longer exists: ${identity.stableId}`);
      }
      throw new Error(`Local file cannot be accessed: ${identity.stableId}`);
    }

    if (!fileStat.isFile()) {
      throw new Error(`Local path is not a file: ${identity.stableId}`);
    }

    return { kind: "file", path: identity.stableId };
  }

  onTrackMetadataChange(listener: LocalTrackMetadataListener): () => void {
    this.metadataListeners.add(listener);
    return () => this.metadataListeners.delete(listener);
  }

  private async walkDirectoryForOpenPath(
    directoryPath: string,
    context: {
      result: LocalOpenResult;
      checkCancelled: () => boolean;
      addTrack: (track: Track | undefined) => void;
    },
  ): Promise<void> {
    if (context.checkCancelled() || context.result.capped) return;

    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }
    if (context.checkCancelled()) return;

    entries.sort((left, right) => comparePathNames(left.name, right.name));
    for (const entry of entries) {
      if (context.checkCancelled() || context.result.capped) return;

      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (isHiddenPathSegment(entry.name)) continue;
        await this.walkDirectoryForOpenPath(entryPath, context);
        continue;
      }

      if (entry.isSymbolicLink()) {
        if (!isCommonAudioExtension(entryPath)) continue;
        const file = await canonicalLocalFileFromDirectoryEntry(entryPath);
        if (context.checkCancelled()) return;
        context.addTrack(file ? this.acceptFile(file) : undefined);
        continue;
      }

      if (!entry.isFile() || !isCommonAudioExtension(entryPath)) continue;
      const file = await canonicalLocalFileFromDirectoryEntry(entryPath);
      if (context.checkCancelled()) return;
      context.addTrack(file ? this.acceptFile(file) : undefined);
    }
  }

  private acceptFile(file: CanonicalLocalFile): Track {
    const identity = {
      providerId: LOCAL_PROVIDER_ID,
      stableId: file.path,
    };
    const key = identityKey(identity);
    const existing = this.tracks.get(key);
    if (existing) return existing;

    const track: Track = {
      identity,
      title: file.title,
      providerLabel: "Local",
    };
    this.tracks.set(key, track);
    this.scheduleLazyMetadata(file, track);
    return track;
  }

  private scheduleLazyMetadata(file: CanonicalLocalFile, track: Track): void {
    if (!this.canUseFfprobe()) return;

    const cacheKey = `${file.path}:${file.size}:${file.mtimeMs}`;
    const cached = this.metadataCache.get(cacheKey);
    if (cached) {
      this.applyMetadata(track, cached);
      return;
    }

    if (this.metadataInFlight.has(cacheKey)) return;
    this.metadataInFlight.add(cacheKey);
    this.metadataQueue.push({ file, track, cacheKey });
    this.drainMetadataQueue();
  }

  private drainMetadataQueue(): void {
    while (this.activeMetadataJobs < this.metadataConcurrency && this.metadataQueue.length > 0) {
      const job = this.metadataQueue.shift();
      if (!job) return;

      this.activeMetadataJobs += 1;
      void this.readMetadata(job.file)
        .then((metadata) => {
          if (!metadata || Object.keys(metadata).length === 0) return;
          this.metadataCache.set(job.cacheKey, metadata);
          this.applyMetadata(job.track, metadata);
        })
        .catch(() => undefined)
        .finally(() => {
          this.activeMetadataJobs -= 1;
          this.metadataInFlight.delete(job.cacheKey);
          this.drainMetadataQueue();
        });
    }
  }

  private applyMetadata(track: Track, metadata: Partial<Track>): void {
    const updated = {
      ...track,
      ...metadata,
      identity: track.identity,
      providerLabel: track.providerLabel,
    };
    this.tracks.set(identityKey(track.identity), updated);
    for (const listener of this.metadataListeners) listener(updated);
  }

  private async probeAudio(file: CanonicalLocalFile): Promise<boolean> {
    const parsed = await this.runFfprobeJson(file, [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_type",
    ]);
    return parsed?.streams?.some((stream) => stream.codec_type === "audio") ?? false;
  }

  private async readMetadata(file: CanonicalLocalFile): Promise<Partial<Track> | null> {
    const parsed = await this.runFfprobeJson(file, [
      "-v",
      "error",
      "-show_entries",
      "format=duration:format_tags=title,artist,album",
    ]);
    if (!parsed?.format) return null;

    const metadata: Partial<Track> = {};
    const title = tagValue(parsed.format.tags, "title");
    const artist = tagValue(parsed.format.tags, "artist");
    const album = tagValue(parsed.format.tags, "album");
    const durationSeconds = numberValue(parsed.format.duration);

    if (title) metadata.title = title;
    if (artist) metadata.artist = artist;
    if (album) metadata.album = album;
    if (durationSeconds !== undefined) metadata.durationSeconds = durationSeconds;
    return metadata;
  }

  private async runFfprobeJson(file: CanonicalLocalFile, args: string[]): Promise<FfprobeJson | null> {
    const result = await this.runner({
      helper: "ffprobe",
      command: this.ffprobeCommand,
      args: [...args, "-of", "json", file.path],
      timeoutMs: this.metadataTimeoutMs,
    });

    if (result.exitCode !== 0) return null;
    return parseFfprobeJson(result.stdout);
  }

  private canUseFfprobe(): boolean {
    return !this.dependencyHealth.metadata.degraded
      && this.dependencyHealth.helpers.ffprobe.status === "present";
  }
}

export function createLocalProvider(options: LocalProviderOptions = {}): LocalProvider {
  return new FileSystemLocalProvider(options);
}

export function isLocalProvider(provider: Provider | undefined): provider is LocalProvider {
  return Boolean(provider)
    && typeof (provider as Partial<LocalProvider>).createTrackFromPath === "function"
    && typeof (provider as Partial<LocalProvider>).createTracksFromOpenPath === "function"
    && typeof (provider as Partial<LocalProvider>).onTrackMetadataChange === "function";
}

export function createDefaultProviders(options: {
  local?: LocalProviderOptions;
  navidrome?: Partial<NavidromeProviderOptions>;
  offlineYouTubeCache?: OfflineYouTubeCacheProviderOptions;
} = {}): Record<string, Provider> {
  const localOptions = options.local ?? {
    dependencyHealth: createDefaultDependencyHealth({
      helpers: {
        ffprobe: { name: "ffprobe", command: "ffprobe", status: "missing" },
      },
      metadata: {
        degraded: true,
        message: "Metadata degraded: ffprobe missing at ffprobe",
      },
    }),
  };
  const defaultConfig = createDefaultTmuConfig();
  const navidromeOptions = {
    config: defaultConfig.providers.navidrome,
    ...options.navidrome,
  };
  const offlineYouTubeCacheOptions = options.offlineYouTubeCache ?? defaultConfig.offlineYouTubeCache;

  return {
    local: createLocalProvider(localOptions),
    navidrome: createNavidromeProvider(navidromeOptions),
    [OFFLINE_YOUTUBE_CACHE_PROVIDER_ID]: createOfflineYouTubeCacheProvider(offlineYouTubeCacheOptions),
    "youtube-url-download": new SkeletonProvider(
      "youtube-url-download",
      "YouTube URL Download",
      "download then enqueue",
      [],
    ),
  };
}

function canonicalLocalFileFromPath(path: string): CanonicalLocalFile | undefined {
  const normalizedPath = path.trim();
  if (!normalizedPath) return undefined;

  try {
    const canonicalPath = realpathSync.native(normalizedPath);
    const stat = statSync(canonicalPath);
    if (!stat.isFile()) return undefined;

    return {
      path: canonicalPath,
      title: basename(canonicalPath) || canonicalPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return undefined;
  }
}

async function selectedLocalPathKind(path: string): Promise<
  | { kind: "file" }
  | { kind: "directory" }
  | { kind: "directory-symlink" }
  | undefined
> {
  try {
    const linkStat = await lstat(path);
    if (linkStat.isSymbolicLink()) {
      const targetStat = await stat(path);
      if (targetStat.isDirectory()) return { kind: "directory-symlink" };
      return targetStat.isFile() ? { kind: "file" } : undefined;
    }

    if (linkStat.isFile()) return { kind: "file" };
    if (linkStat.isDirectory()) return { kind: "directory" };
    return undefined;
  } catch {
    return undefined;
  }
}

async function canonicalLocalFileFromDirectoryEntry(path: string): Promise<CanonicalLocalFile | undefined> {
  try {
    const canonicalPath = await realpath(path);
    const fileStat = await stat(canonicalPath);
    if (!fileStat.isFile()) return undefined;

    return {
      path: canonicalPath,
      title: basename(canonicalPath) || canonicalPath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch {
    return undefined;
  }
}

function isCommonAudioExtension(path: string): boolean {
  return COMMON_AUDIO_EXTENSIONS.has(extname(path).toLowerCase());
}

function isHiddenPathSegment(name: string): boolean {
  return name.length > 1 && name.startsWith(".");
}

function comparePathNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizeSoftCap(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_LOCAL_DIRECTORY_SOFT_CAP;
  return Math.max(0, Math.floor(value));
}

function parseFfprobeJson(stdout: string): FfprobeJson | null {
  try {
    return JSON.parse(stdout) as FfprobeJson;
  } catch {
    return null;
  }
}

function tagValue(tags: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!tags) return undefined;

  const match = Object.entries(tags).find(([key]) => key.toLowerCase() === name);
  const value = match?.[1];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
