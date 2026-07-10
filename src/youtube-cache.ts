import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import {
  identityKey,
  YOUTUBE_CACHE_PROVIDER_ID,
  type LocalPlaybackLocator,
  type Provider,
  type Track,
  type TrackAvailability,
  type TrackIdentity,
} from "./domain";

const YOUTUBE_CACHE_PROVIDER_LABEL = "YouTube Cache";
const REQUIRED_METADATA_KEYS = [
  "videoId", "title", "uploader", "cachedAt", "mediaFileName", "container",
] as const;
const OPTIONAL_METADATA_KEYS = ["durationSeconds", "thumbnailUrl"] as const;
const METADATA_KEYS = new Set<string>([...REQUIRED_METADATA_KEYS, ...OPTIONAL_METADATA_KEYS]);
const MEDIA_EXTENSIONS = new Set([
  ".aac", ".flac", ".m4a", ".mka", ".mkv", ".mp3", ".mp4", ".ogg", ".opus", ".wav", ".webm",
]);

export type YouTubeCacheProviderOptions = {
  cacheDir: string;
};

export function defaultYouTubeCacheDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "tmu", "youtube-cache");
}

export type YouTubeCacheMetadata = {
  videoId: string;
  title: string;
  uploader: string;
  durationSeconds?: number;
  cachedAt: string;
  mediaFileName: string;
  container: string;
  thumbnailUrl?: string;
};

export type YouTubeCacheEntry = {
  track: Track;
  availability: TrackAvailability;
  metadata: YouTubeCacheMetadata;
  metadataPath: string;
  mediaPath: string;
};

export type IncompleteYouTubeCacheEntry = {
  stem: string;
  paths: readonly string[];
  reason: string;
  title?: string;
  uploader?: string;
};

export type YouTubeCacheProvider = Provider & {
  refresh(): void;
  listCacheEntries(): readonly YouTubeCacheEntry[];
  listIncompleteEntries(): readonly IncompleteYouTubeCacheEntry[];
  findByIdentity(identity: TrackIdentity): YouTubeCacheEntry | undefined;
};

export function createYouTubeCacheProvider(
  options: YouTubeCacheProviderOptions = { cacheDir: defaultYouTubeCacheDirectory() },
): YouTubeCacheProvider {
  return new FileSystemYouTubeCacheProvider(options);
}

export function isYouTubeCacheProvider(
  provider: Provider | undefined,
): provider is YouTubeCacheProvider {
  return Boolean(provider)
    && typeof (provider as Partial<YouTubeCacheProvider>).listCacheEntries === "function"
    && typeof (provider as Partial<YouTubeCacheProvider>).listIncompleteEntries === "function"
    && typeof (provider as Partial<YouTubeCacheProvider>).findByIdentity === "function"
    && typeof (provider as Partial<YouTubeCacheProvider>).refresh === "function";
}

export async function writeYouTubeCacheMetadata(
  options: YouTubeCacheProviderOptions,
  metadata: YouTubeCacheMetadata,
  writeOptions: { signal?: AbortSignal } = {},
): Promise<string> {
  const normalized = normalizeMetadata(metadata);
  if (!normalized) throw new Error("YouTube Cache metadata is invalid");

  throwIfAborted(writeOptions.signal);
  await mkdir(options.cacheDir, { recursive: true });
  const metadataPath = join(options.cacheDir, `${normalized.videoId}.json`);
  const tempPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      signal: writeOptions.signal,
    });
    throwIfAborted(writeOptions.signal);
    await rename(tempPath, metadataPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return metadataPath;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("YouTube download cancelled");
}

class FileSystemYouTubeCacheProvider implements YouTubeCacheProvider {
  readonly id = YOUTUBE_CACHE_PROVIDER_ID;
  readonly label = YOUTUBE_CACHE_PROVIDER_LABEL;
  private readonly entries = new Map<string, YouTubeCacheEntry>();
  private incompleteEntries: IncompleteYouTubeCacheEntry[] = [];

  constructor(private readonly options: YouTubeCacheProviderOptions) {
    this.refresh();
  }

  refresh(): void {
    this.entries.clear();
    this.incompleteEntries = [];
    for (const candidate of scanCache(this.options.cacheDir)) {
      if (candidate.entry) {
        this.entries.set(identityKey(candidate.entry.track.identity), candidate.entry);
      } else if (candidate.incomplete) {
        this.incompleteEntries.push(candidate.incomplete);
      }
    }
    this.incompleteEntries.sort((left, right) => compareStrings(left.stem, right.stem));
  }

  listTracks(): readonly Track[] {
    return this.listCacheEntries().map((entry) => entry.track);
  }

  searchTracks(query: string): readonly Track[] {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return this.listTracks();
    return this.listTracks().filter((track) =>
      [track.title, track.artist, track.identity.stableId]
        .some((value) => value?.toLocaleLowerCase().includes(normalized))
    );
  }

  listCacheEntries(): readonly YouTubeCacheEntry[] {
    return [...this.entries.values()].sort((left, right) =>
      right.metadata.cachedAt.localeCompare(left.metadata.cachedAt)
      || compareStrings(left.track.identity.stableId, right.track.identity.stableId)
    );
  }

  listIncompleteEntries(): readonly IncompleteYouTubeCacheEntry[] {
    return this.incompleteEntries;
  }

  findByIdentity(identity: TrackIdentity): YouTubeCacheEntry | undefined {
    if (identity.providerId !== YOUTUBE_CACHE_PROVIDER_ID) return undefined;
    return this.entries.get(identityKey(identity));
  }

  async resolvePlaybackLocator(identity: TrackIdentity): Promise<LocalPlaybackLocator> {
    if (identity.providerId !== YOUTUBE_CACHE_PROVIDER_ID) {
      throw new Error(`YouTube Cache cannot resolve ${identity.providerId}`);
    }
    const entry = this.findByIdentity(identity);
    if (!entry || !isNonEmptyFile(entry.mediaPath)) {
      throw new Error(`YouTube Cache entry is missing: ${identity.stableId}`);
    }
    return { kind: "file", path: entry.mediaPath };
  }
}

type ScanResult = { entry?: YouTubeCacheEntry; incomplete?: IncompleteYouTubeCacheEntry };

function scanCache(cacheDir: string): ScanResult[] {
  if (!existsSync(cacheDir)) return [];
  let files: string[];
  try {
    files = readdirSync(cacheDir, { withFileTypes: true })
      .filter((item) => item.isFile())
      .map((item) => item.name);
  } catch {
    return [];
  }

  const results: ScanResult[] = [];
  const consumedMedia = new Set<string>();
  const sidecarsByStem = new Map<string, string[]>();
  for (const name of files.filter((candidate) => extname(candidate).toLowerCase() === ".json")) {
    const stem = name.slice(0, -5);
    if (!normalizeVideoId(stem)) continue;
    sidecarsByStem.set(stem, [...sidecarsByStem.get(stem) ?? [], name]);
  }
  for (const [stem, sidecarNames] of sidecarsByStem) {
    const sidecarName = sidecarNames[0]!;
    const metadataPath = join(cacheDir, sidecarName);
    const parsed = parseJson(metadataPath);
    const metadata = normalizeMetadata(parsed);
    const mediaName = metadata?.mediaFileName
      ?? (isObject(parsed) && typeof parsed.mediaFileName === "string" ? basename(parsed.mediaFileName) : undefined);
    const sameStemMedia = files.filter((name) =>
      normalizeVideoId(name.slice(0, -extname(name).length)) === stem
      && MEDIA_EXTENSIONS.has(extname(name).toLowerCase())
    );
    for (const name of sameStemMedia) consumedMedia.add(name);
    if (mediaName) consumedMedia.add(mediaName);
    const mediaPath = metadata ? join(cacheDir, metadata.mediaFileName) : undefined;
    if (sidecarNames.length !== 1 || sidecarName !== `${stem}.json`
      || !metadata || metadata.videoId !== stem || !mediaPath || sameStemMedia.length !== 1
      || sameStemMedia[0] !== metadata.mediaFileName || !isNonEmptyFile(mediaPath)) {
      results.push({ incomplete: incompleteFrom(
        stem,
        metadataPath,
        [...sidecarNames.slice(1), ...sameStemMedia].map((name) => join(cacheDir, name)),
        parsed,
      ) });
      continue;
    }
    results.push({ entry: {
      track: trackFromMetadata(metadata),
      availability: { status: "available" },
      metadata,
      metadataPath,
      mediaPath,
    } });
  }

  for (const name of files) {
    const extension = extname(name).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(extension) || consumedMedia.has(name)) continue;
    const stem = name.slice(0, -extension.length);
    if (!normalizeVideoId(stem)) continue;
    if (files.includes(`${stem}.json`)) continue;
    results.push({ incomplete: {
      stem,
      paths: [join(cacheDir, name)],
      reason: "Cache media has no sidecar",
    } });
  }
  return results;
}

function incompleteFrom(
  stem: string,
  metadataPath: string,
  mediaPaths: readonly string[],
  parsed: unknown,
): IncompleteYouTubeCacheEntry {
  const readable = isObject(parsed) ? parsed : {};
  return {
    stem,
    paths: [metadataPath, ...mediaPaths],
    reason: "Cache sidecar or media is invalid or incomplete",
    ...(normalizeDisplayValue(readable.title) ? { title: normalizeDisplayValue(readable.title) } : {}),
    ...(normalizeDisplayValue(readable.uploader) ? { uploader: normalizeDisplayValue(readable.uploader) } : {}),
  };
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function normalizeMetadata(value: unknown): YouTubeCacheMetadata | null {
  if (!isObject(value)) return null;
  if (Object.keys(value).some((key) => !METADATA_KEYS.has(key))) return null;
  if (REQUIRED_METADATA_KEYS.some((key) => !(key in value))) return null;

  const videoId = normalizeVideoId(value.videoId);
  const title = normalizeDisplayValue(value.title);
  const uploader = normalizeDisplayValue(value.uploader);
  const cachedAt = normalizeTimestamp(value.cachedAt);
  const mediaFileName = normalizeMediaFileName(value.mediaFileName);
  const container = normalizeContainer(value.container);
  if (!videoId || !title || !uploader || !cachedAt || !mediaFileName || !container) return null;
  const extension = extname(mediaFileName).slice(1).toLowerCase();
  if (mediaFileName !== `${videoId}.${extension}` || extension !== container) return null;

  const durationSeconds = normalizeDuration(value.durationSeconds);
  if ("durationSeconds" in value && durationSeconds === undefined) return null;
  const thumbnailUrl = normalizeDisplayValue(value.thumbnailUrl);
  if ("thumbnailUrl" in value && !thumbnailUrl) return null;
  return {
    videoId, title, uploader,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    cachedAt, mediaFileName, container,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

function trackFromMetadata(metadata: YouTubeCacheMetadata): Track {
  return {
    identity: { providerId: YOUTUBE_CACHE_PROVIDER_ID, stableId: metadata.videoId },
    title: metadata.title,
    artist: metadata.uploader,
    ...(metadata.durationSeconds !== undefined ? { durationSeconds: metadata.durationSeconds } : {}),
    providerLabel: YOUTUBE_CACHE_PROVIDER_LABEL,
  };
}

function isNonEmptyFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeVideoId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{11}$/.test(trimmed) ? trimmed : undefined;
}

function normalizeDisplayValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeMediaFileName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !isAbsolute(trimmed) && basename(trimmed) === trimmed && extname(trimmed) ? trimmed : undefined;
}

function normalizeContainer(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed && /^[a-z0-9]+$/.test(trimmed) ? trimmed : undefined;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function normalizeDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
