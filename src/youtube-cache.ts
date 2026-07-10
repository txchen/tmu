import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
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

export type YouTubeCacheProviderOptions = {
  cacheDir: string;
  mediaDirName: string;
  metadataFileName: string;
};

export type YouTubeCacheMetadata = {
  version: 1;
  extractor: string;
  id: string;
  title: string;
  mediaFileName: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  coverArtId?: string;
};

export type YouTubeCacheEntry = {
  track: Track;
  availability: TrackAvailability;
  metadataPath: string;
  mediaPath: string;
};

export type YouTubeCacheProvider = Provider & {
  refresh(): void;
  listCacheEntries(): readonly YouTubeCacheEntry[];
  findByIdentity(identity: TrackIdentity): YouTubeCacheEntry | undefined;
};

type NormalizedYouTubeCacheMetadata = YouTubeCacheMetadata & {
  extractor: string;
  id: string;
  title: string;
  mediaFileName: string;
};

export function createYouTubeCacheProvider(
  options: YouTubeCacheProviderOptions,
): YouTubeCacheProvider {
  return new FileSystemYouTubeCacheProvider(options);
}

export function isYouTubeCacheProvider(
  provider: Provider | undefined,
): provider is YouTubeCacheProvider {
  return Boolean(provider)
    && typeof (provider as Partial<YouTubeCacheProvider>).listCacheEntries === "function"
    && typeof (provider as Partial<YouTubeCacheProvider>).findByIdentity === "function"
    && typeof (provider as Partial<YouTubeCacheProvider>).refresh === "function";
}

export async function writeYouTubeCacheMetadata(
  options: YouTubeCacheProviderOptions,
  metadata: YouTubeCacheMetadata,
  writeOptions: { signal?: AbortSignal } = {},
): Promise<string> {
  const normalized = normalizeMetadata(metadata);
  if (!normalized) {
    throw new Error("YouTube Cache metadata is invalid");
  }

  throwIfAborted(writeOptions.signal);
  const entryDir = join(options.cacheDir, normalized.extractor, normalized.id);
  await mkdir(join(entryDir, options.mediaDirName), { recursive: true });
  const metadataPath = join(entryDir, options.metadataFileName);
  const tempPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    throwIfAborted(writeOptions.signal);
    await writeFile(
      tempPath,
      `${JSON.stringify(serializableMetadata(normalized), null, 2)}\n`,
      { encoding: "utf8", signal: writeOptions.signal },
    );
    throwIfAborted(writeOptions.signal);
    await rename(tempPath, metadataPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return metadataPath;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new Error("YouTube download cancelled");
}

class FileSystemYouTubeCacheProvider implements YouTubeCacheProvider {
  readonly id = YOUTUBE_CACHE_PROVIDER_ID;
  readonly label = YOUTUBE_CACHE_PROVIDER_LABEL;
  private readonly entries = new Map<string, YouTubeCacheEntry>();

  constructor(private readonly options: YouTubeCacheProviderOptions) {
    this.refresh();
  }

  refresh(): void {
    this.entries.clear();

    for (const metadataPath of findMetadataFiles(this.options.cacheDir, this.options.metadataFileName)) {
      const entry = this.entryFromMetadataPath(metadataPath);
      if (!entry) continue;

      const key = identityKey(entry.track.identity);
      if (!this.entries.has(key)) this.entries.set(key, entry);
    }
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
    return [...this.entries.values()].sort(compareCacheEntries);
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
    if (!entry) {
      throw new Error(`YouTube Cache entry is missing: ${identity.stableId}`);
    }

    const availability = cachedMediaAvailability(entry.mediaPath);
    if (availability.status === "unavailable") throw new Error(`${availability.reason}: ${entry.mediaPath}`);

    return { kind: "file", path: entry.mediaPath };
  }

  private entryFromMetadataPath(metadataPath: string): YouTubeCacheEntry | undefined {
    const metadata = readMetadata(metadataPath);
    if (!metadata) return undefined;

    const mediaPath = join(
      this.options.cacheDir,
      metadata.extractor,
      metadata.id,
      this.options.mediaDirName,
      metadata.mediaFileName,
    );
    const availability = cachedMediaAvailability(mediaPath);

    return {
      track: trackFromMetadata(metadata),
      availability,
      metadataPath,
      mediaPath,
    };
  }
}

function findMetadataFiles(cacheDir: string, metadataFileName: string): string[] {
  if (!existsSync(cacheDir)) return [];

  const found: string[] = [];
  const visit = (directory: string) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => compareStrings(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }

      if (entry.isFile() && entry.name === metadataFileName) {
        found.push(path);
      }
    }
  };

  visit(cacheDir);
  return found;
}

function readMetadata(path: string): NormalizedYouTubeCacheMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return normalizeMetadata(parsed);
  } catch {
    return null;
  }
}

function normalizeMetadata(value: unknown): NormalizedYouTubeCacheMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Partial<YouTubeCacheMetadata>;
  if (input.version !== 1) return null;

  const extractor = normalizeExtractor(input.extractor);
  const id = normalizeId(input.id);
  const title = normalizeDisplayValue(input.title);
  const mediaFileName = normalizeMediaFileName(input.mediaFileName);
  if (!extractor || !id || !title || !mediaFileName) return null;

  const metadata: NormalizedYouTubeCacheMetadata = {
    version: 1,
    extractor,
    id,
    title,
    mediaFileName,
  };
  const artist = normalizeDisplayValue(input.artist);
  const album = normalizeDisplayValue(input.album);
  const durationSeconds = normalizeDuration(input.durationSeconds);
  const coverArtId = normalizeDisplayValue(input.coverArtId);

  if (artist) metadata.artist = artist;
  if (album) metadata.album = album;
  if (durationSeconds !== undefined) metadata.durationSeconds = durationSeconds;
  if (coverArtId) metadata.coverArtId = coverArtId;
  return metadata;
}

function trackFromMetadata(metadata: NormalizedYouTubeCacheMetadata): Track {
  const track: Track = {
    identity: {
      providerId: YOUTUBE_CACHE_PROVIDER_ID,
      stableId: metadata.id,
    },
    title: metadata.title,
    providerLabel: YOUTUBE_CACHE_PROVIDER_LABEL,
  };

  if (metadata.artist) track.artist = metadata.artist;
  if (metadata.durationSeconds !== undefined) track.durationSeconds = metadata.durationSeconds;
  return track;
}

function cachedMediaAvailability(mediaPath: string): TrackAvailability {
  try {
    const mediaStat = statSync(mediaPath);
    if (mediaStat.isFile()) return { status: "available" };
    return { status: "unavailable", reason: "Cached media path is not a file" };
  } catch {
    return { status: "unavailable", reason: "Cached media file is missing" };
  }
}

function serializableMetadata(
  metadata: NormalizedYouTubeCacheMetadata,
): YouTubeCacheMetadata {
  return {
    version: 1,
    extractor: metadata.extractor,
    id: metadata.id,
    title: metadata.title,
    mediaFileName: metadata.mediaFileName,
    ...(metadata.artist ? { artist: metadata.artist } : {}),
    ...(metadata.album ? { album: metadata.album } : {}),
    ...(metadata.durationSeconds !== undefined ? { durationSeconds: metadata.durationSeconds } : {}),
    ...(metadata.coverArtId ? { coverArtId: metadata.coverArtId } : {}),
  };
}

function normalizeExtractor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed && !trimmed.includes("/") && !trimmed.includes("\\") ? trimmed : undefined;
}

function normalizeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && !trimmed.includes("/") && !trimmed.includes("\\") ? trimmed : undefined;
}

function normalizeDisplayValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeMediaFileName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || isAbsolute(trimmed) || basename(trimmed) !== trimmed) return undefined;
  return trimmed;
}

function normalizeDuration(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function compareCacheEntries(left: YouTubeCacheEntry, right: YouTubeCacheEntry): number {
  return compareStrings(left.track.title.toLowerCase(), right.track.title.toLowerCase())
    || compareStrings(left.track.artist?.toLowerCase() ?? "", right.track.artist?.toLowerCase() ?? "")
    || compareStrings(left.track.identity.stableId, right.track.identity.stableId);
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
