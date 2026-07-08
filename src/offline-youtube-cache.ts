import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import {
  identityKey,
  type PlaybackLocator,
  type Provider,
  type Track,
  type TrackAvailability,
  type TrackIdentity,
} from "./domain";

export const OFFLINE_YOUTUBE_CACHE_PROVIDER_ID = "offline-youtube-cache";
const OFFLINE_YOUTUBE_CACHE_PROVIDER_LABEL = "Offline YouTube Cache";

export type OfflineYouTubeCacheProviderOptions = {
  cacheDir: string;
  mediaDirName: string;
  metadataFileName: string;
};

export type OfflineYouTubeCacheMetadata = {
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

export type OfflineYouTubeCacheEntry = {
  track: Track;
  availability: TrackAvailability;
  metadataPath: string;
  mediaPath: string;
};

export type OfflineYouTubeCacheProvider = Provider & {
  refresh(): void;
  listCacheEntries(): readonly OfflineYouTubeCacheEntry[];
  findByIdentity(identity: TrackIdentity): OfflineYouTubeCacheEntry | undefined;
};

type NormalizedOfflineYouTubeCacheMetadata = OfflineYouTubeCacheMetadata & {
  extractor: string;
  id: string;
  title: string;
  mediaFileName: string;
};

export function createOfflineYouTubeCacheProvider(
  options: OfflineYouTubeCacheProviderOptions,
): OfflineYouTubeCacheProvider {
  return new FileSystemOfflineYouTubeCacheProvider(options);
}

export function isOfflineYouTubeCacheProvider(
  provider: Provider | undefined,
): provider is OfflineYouTubeCacheProvider {
  return Boolean(provider)
    && typeof (provider as Partial<OfflineYouTubeCacheProvider>).listCacheEntries === "function"
    && typeof (provider as Partial<OfflineYouTubeCacheProvider>).findByIdentity === "function"
    && typeof (provider as Partial<OfflineYouTubeCacheProvider>).refresh === "function";
}

export async function writeOfflineYouTubeCacheMetadata(
  options: OfflineYouTubeCacheProviderOptions,
  metadata: OfflineYouTubeCacheMetadata,
  writeOptions: { signal?: AbortSignal } = {},
): Promise<string> {
  const normalized = normalizeMetadata(metadata);
  if (!normalized) {
    throw new Error("Offline YouTube Cache metadata is invalid");
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

class FileSystemOfflineYouTubeCacheProvider implements OfflineYouTubeCacheProvider {
  readonly id = OFFLINE_YOUTUBE_CACHE_PROVIDER_ID;
  readonly label = OFFLINE_YOUTUBE_CACHE_PROVIDER_LABEL;
  readonly hint = "downloaded YouTube audio";

  private readonly entries = new Map<string, OfflineYouTubeCacheEntry>();

  constructor(private readonly options: OfflineYouTubeCacheProviderOptions) {
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

  listVisibleTracks(): readonly Track[] {
    return this.listCacheEntries().map((entry) => entry.track);
  }

  listCacheEntries(): readonly OfflineYouTubeCacheEntry[] {
    return [...this.entries.values()].sort(compareCacheEntries);
  }

  findByIdentity(identity: TrackIdentity): OfflineYouTubeCacheEntry | undefined {
    if (identity.providerId !== OFFLINE_YOUTUBE_CACHE_PROVIDER_ID) return undefined;
    return this.entries.get(identityKey(identity));
  }

  async resolvePlaybackLocator(identity: TrackIdentity): Promise<PlaybackLocator> {
    if (identity.providerId !== OFFLINE_YOUTUBE_CACHE_PROVIDER_ID) {
      throw new Error(`Offline YouTube Cache cannot resolve ${identity.providerId}`);
    }

    const entry = this.findByIdentity(identity);
    if (!entry) {
      throw new Error(`Offline YouTube Cache entry is missing: ${identity.stableId}`);
    }

    const availability = cachedMediaAvailability(entry.mediaPath);
    if (availability.status === "unavailable") throw new Error(`${availability.reason}: ${entry.mediaPath}`);

    return { kind: "file", path: entry.mediaPath };
  }

  private entryFromMetadataPath(metadataPath: string): OfflineYouTubeCacheEntry | undefined {
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

function readMetadata(path: string): NormalizedOfflineYouTubeCacheMetadata | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return normalizeMetadata(parsed);
  } catch {
    return null;
  }
}

function normalizeMetadata(value: unknown): NormalizedOfflineYouTubeCacheMetadata | null {
  if (typeof value !== "object" || value === null) return null;
  const input = value as Partial<OfflineYouTubeCacheMetadata>;
  if (input.version !== 1) return null;

  const extractor = normalizeExtractor(input.extractor);
  const id = normalizeId(input.id);
  const title = normalizeDisplayValue(input.title);
  const mediaFileName = normalizeMediaFileName(input.mediaFileName);
  if (!extractor || !id || !title || !mediaFileName) return null;

  const metadata: NormalizedOfflineYouTubeCacheMetadata = {
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

function trackFromMetadata(metadata: NormalizedOfflineYouTubeCacheMetadata): Track {
  const track: Track = {
    identity: {
      providerId: OFFLINE_YOUTUBE_CACHE_PROVIDER_ID,
      stableId: `${metadata.extractor}:${metadata.id}`,
    },
    title: metadata.title,
    providerLabel: OFFLINE_YOUTUBE_CACHE_PROVIDER_LABEL,
  };

  if (metadata.artist) track.artist = metadata.artist;
  if (metadata.album) track.album = metadata.album;
  if (metadata.durationSeconds !== undefined) track.durationSeconds = metadata.durationSeconds;
  if (metadata.coverArtId) track.coverArtId = metadata.coverArtId;
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
  metadata: NormalizedOfflineYouTubeCacheMetadata,
): OfflineYouTubeCacheMetadata {
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

function compareCacheEntries(left: OfflineYouTubeCacheEntry, right: OfflineYouTubeCacheEntry): number {
  return compareStrings(left.track.title.toLowerCase(), right.track.title.toLowerCase())
    || compareStrings(left.track.artist?.toLowerCase() ?? "", right.track.artist?.toLowerCase() ?? "")
    || compareStrings(left.track.identity.stableId, right.track.identity.stableId);
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
