import { readFile, rename } from "node:fs/promises";
import {
  YOUTUBE_CACHE_PROVIDER_ID,
  identityKey,
  sameIdentity,
  type LastPlaylistSnapshot,
  type LastPlaylistSnapshotPlaylist,
  type PlaylistCollectionState,
  type PlaylistState,
  type SnapshotTrack,
  type Track,
  type TrackIdentity,
  type VolumeState,
} from "./domain";
import { JsonRecoveryMessages, writeJsonAtomically } from "./json-persistence";
import { playlistNameKey } from "./playlists";

export type LastPlaylistSnapshotPersistence = {
  load(): Promise<LastPlaylistSnapshot | null>;
  save(snapshot: LastPlaylistSnapshot): Promise<void>;
  drainRecoveryMessages?(): string[];
  wasLastLoadQuarantined?(): boolean;
};

export class InMemoryLastPlaylistSnapshotPersistence implements LastPlaylistSnapshotPersistence {
  private value: LastPlaylistSnapshot | null = null;

  async load(): Promise<LastPlaylistSnapshot | null> {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(snapshot: LastPlaylistSnapshot): Promise<void> {
    this.value = structuredClone(snapshot);
  }
}

export class FileLastPlaylistSnapshotPersistence implements LastPlaylistSnapshotPersistence {
  private readonly messages = new JsonRecoveryMessages();
  private quarantined = false;

  constructor(private readonly path: string) {}

  async load(): Promise<LastPlaylistSnapshot | null> {
    this.messages.reset();
    this.quarantined = false;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (!isMissingFileError(error)) this.messages.push(`Could not read Last Playlist Snapshot at ${this.path}: ${errorMessage(error)}`);
      return null;
    }
    try {
      const parsed = parseLastPlaylistSnapshot(JSON.parse(raw));
      if (parsed) return parsed;
      await this.quarantine("invalid or unsupported");
    } catch (error) {
      await this.quarantine(`corrupted: ${errorMessage(error)}`);
    }
    return null;
  }

  async save(snapshot: LastPlaylistSnapshot): Promise<void> {
    await writeJsonAtomically(this.path, snapshot);
  }

  drainRecoveryMessages(): string[] {
    return this.messages.drain();
  }

  wasLastLoadQuarantined(): boolean {
    return this.quarantined;
  }

  private async quarantine(reason: string): Promise<void> {
    this.quarantined = true;
    const suffix = new Date().toISOString().replaceAll(/[-:.]/g, "");
    const target = `${this.path}.corrupt-${suffix}-${crypto.randomUUID()}`;
    try {
      await rename(this.path, target);
      this.messages.push(`Last Playlist Snapshot was ${reason}; moved it to ${target}. Opened a fresh Default Playlist.`);
    } catch (error) {
      this.messages.push(`Last Playlist Snapshot was ${reason}, but could not be quarantined: ${errorMessage(error)}. Opened a fresh Default Playlist.`);
    }
  }
}

export function createLastPlaylistSnapshot(
  collection: PlaylistCollectionState,
  volume: VolumeState,
): LastPlaylistSnapshot {
  const tracks = new Map<string, SnapshotTrack>();
  for (const playlist of collection.playlists) {
    for (const entry of playlist.entries) {
      const key = identityKey(entry.track.identity);
      if (!tracks.has(key)) tracks.set(key, snapshotTrack(entry.track));
    }
  }
  return {
    version: 1,
    activePlaylistId: collection.activePlaylistId,
    playlists: collection.playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.name,
      trackIdentities: playlist.entries.map((entry) => ({ ...entry.track.identity })),
      currentTrackIdentity: playlist.entries[playlist.currentIndex]?.track.identity ?? null,
      positionSeconds: playlist.positionSeconds,
      playbackStatus: playlist.playbackStatus,
      repeatAll: playlist.repeatAll,
    })),
    tracks: [...tracks.values()],
    volume: { ...volume },
  };
}

export function playlistCollectionFromSnapshot(snapshot: LastPlaylistSnapshot): PlaylistCollectionState {
  const tracks = new Map(snapshot.tracks.map((track) => [identityKey(track.identity), track]));
  return {
    activePlaylistId: snapshot.activePlaylistId,
    playlists: snapshot.playlists.map((playlist): PlaylistState => {
      const entries = playlist.trackIdentities.map((identity) => ({
        track: tracks.get(identityKey(identity))!,
        availability: { status: "unknown" as const },
      }));
      return {
        id: playlist.id,
        name: playlist.name,
        entries,
        currentIndex: playlist.currentTrackIdentity
          ? entries.findIndex((entry) => sameIdentity(entry.track.identity, playlist.currentTrackIdentity))
          : -1,
        repeatAll: playlist.repeatAll,
        positionSeconds: playlist.positionSeconds,
        playbackStatus: playlist.playbackStatus,
      };
    }),
  };
}

function parseLastPlaylistSnapshot(value: unknown): LastPlaylistSnapshot | null {
  if (!isObject(value) || value.version !== 1 || typeof value.activePlaylistId !== "string") return null;
  if (!Array.isArray(value.playlists) || value.playlists.length === 0 || !Array.isArray(value.tracks)) return null;
  if (!isVolume(value.volume)) return null;
  const tracks: SnapshotTrack[] = [];
  const trackKeys = new Set<string>();
  for (const raw of value.tracks) {
    const track = parseTrack(raw);
    if (!track || trackKeys.has(identityKey(track.identity))) return null;
    trackKeys.add(identityKey(track.identity));
    tracks.push(track);
  }
  const playlists: LastPlaylistSnapshotPlaylist[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const raw of value.playlists) {
    const playlist = parsePlaylist(raw, trackKeys);
    if (!playlist) return null;
    const foldedName = playlistNameKey(playlist.name);
    if (ids.has(playlist.id) || names.has(foldedName)) return null;
    ids.add(playlist.id);
    names.add(foldedName);
    playlists.push(playlist);
  }
  if (!ids.has(value.activePlaylistId)) return null;
  const referenced = new Set(playlists.flatMap((playlist) => playlist.trackIdentities.map(identityKey)));
  if (referenced.size !== trackKeys.size || [...trackKeys].some((key) => !referenced.has(key))) return null;
  return { version: 1, activePlaylistId: value.activePlaylistId, playlists, tracks, volume: { ...value.volume } };
}

function parsePlaylist(value: unknown, trackKeys: Set<string>): LastPlaylistSnapshotPlaylist | null {
  if (!isObject(value) || typeof value.id !== "string" || !isUuid(value.id) || typeof value.name !== "string") return null;
  if (value.name.trim() !== value.name || value.name.length === 0 || [...value.name].length > 16) return null;
  if (!Array.isArray(value.trackIdentities) || typeof value.repeatAll !== "boolean") return null;
  if (!isFiniteNumber(value.positionSeconds) || value.positionSeconds < 0) return null;
  if (value.playbackStatus !== "stopped" && value.playbackStatus !== "resumable") return null;
  if (value.playbackStatus === "stopped" && value.positionSeconds !== 0) return null;
  const identities: TrackIdentity[] = [];
  const membership = new Set<string>();
  for (const raw of value.trackIdentities) {
    const identity = parseIdentity(raw);
    if (!identity || !trackKeys.has(identityKey(identity)) || membership.has(identityKey(identity))) return null;
    membership.add(identityKey(identity));
    identities.push(identity);
  }
  const current = value.currentTrackIdentity === null ? null : parseIdentity(value.currentTrackIdentity);
  if (current && !membership.has(identityKey(current))) return null;
  if (!current && value.positionSeconds !== 0) return null;
  return {
    id: value.id,
    name: value.name,
    trackIdentities: identities,
    currentTrackIdentity: current,
    positionSeconds: value.positionSeconds,
    playbackStatus: value.playbackStatus,
    repeatAll: value.repeatAll,
  };
}

function parseTrack(value: unknown): SnapshotTrack | null {
  if (!isObject(value)) return null;
  const identity = parseIdentity(value.identity);
  if (!identity || typeof value.title !== "string" || typeof value.providerLabel !== "string") return null;
  if (value.artist !== undefined && typeof value.artist !== "string") return null;
  if (value.durationSeconds !== undefined && (!isFiniteNumber(value.durationSeconds) || value.durationSeconds < 0)) return null;
  return snapshotTrack(value as Track);
}

function parseIdentity(value: unknown): TrackIdentity | null {
  if (!isObject(value) || value.providerId !== YOUTUBE_CACHE_PROVIDER_ID || typeof value.stableId !== "string" || value.stableId.length === 0) return null;
  return { providerId: value.providerId, stableId: value.stableId };
}

function snapshotTrack(track: Track): SnapshotTrack {
  const result: SnapshotTrack = {
    identity: { ...track.identity }, title: track.title, providerLabel: track.providerLabel,
  };
  if (track.artist !== undefined) result.artist = track.artist;
  if (track.durationSeconds !== undefined) result.durationSeconds = track.durationSeconds;
  return result;
}

function isVolume(value: unknown): value is VolumeState {
  return isObject(value) && isFiniteNumber(value.percent) && value.percent >= 0 && value.percent <= 100 && typeof value.ready === "boolean";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isMissingFileError(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
