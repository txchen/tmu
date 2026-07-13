import { MemoryQueue } from "./queue";
import {
  identityKey,
  type PlaylistCollectionState,
  type PlaylistPlaybackStatus,
  type PlaylistState,
  type Queue,
  type Track,
} from "./domain";

type PlaylistRecord = {
  id: string;
  name: string;
  queue: Queue;
  positionSeconds: number;
  playbackStatus: PlaylistPlaybackStatus;
};

export class MemoryPlaylistCollection {
  private records: PlaylistRecord[];
  private activeId: string;

  constructor(initialQueue: Queue, id = crypto.randomUUID()) {
    this.records = [{ id, name: "Default", queue: initialQueue, positionSeconds: 0, playbackStatus: "stopped" }];
    this.activeId = id;
  }

  get activeQueue(): Queue {
    return this.active.queue;
  }

  get activePlaylistId(): string {
    return this.activeId;
  }

  get activePlayback(): Pick<PlaylistRecord, "positionSeconds" | "playbackStatus"> {
    return { positionSeconds: this.active.positionSeconds, playbackStatus: this.active.playbackStatus };
  }

  append(name: string, id = crypto.randomUUID()): { id: string; queue: Queue } {
    const normalizedName = validatePlaylistName(name, this.records.map((record) => record.name));
    if (this.records.some((playlist) => playlist.id === id)) throw new Error(`Playlist UUID is already in use: ${id}`);
    const record = { id, name: normalizedName, queue: new MemoryQueue(), positionSeconds: 0, playbackStatus: "stopped" as const };
    this.records.push(record);
    return record;
  }

  rename(id: string, name: string): void {
    const record = this.records.find((playlist) => playlist.id === id);
    if (!record) throw new Error(`Playlist is missing: ${id}`);
    record.name = validatePlaylistName(name, this.records.filter((playlist) => playlist.id !== id).map((playlist) => playlist.name));
  }

  move(id: string, delta: -1 | 1): number {
    const from = this.records.findIndex((playlist) => playlist.id === id);
    if (from < 0) throw new Error(`Playlist is missing: ${id}`);
    const to = Math.max(0, Math.min(this.records.length - 1, from + delta));
    if (to === from) return from;
    const [record] = this.records.splice(from, 1);
    this.records.splice(to, 0, record!);
    return to;
  }

  removeInactive(id: string): void {
    if (id === this.activeId) throw new Error("Cannot remove the Active Playlist");
    this.records = this.records.filter((playlist) => playlist.id !== id);
  }

  activate(id: string): PlaylistState {
    const record = this.records.find((playlist) => playlist.id === id);
    if (!record) throw new Error(`Playlist is missing: ${id}`);
    this.activeId = id;
    return { id: record.id, name: record.name, ...record.queue.snapshot(), positionSeconds: record.positionSeconds, playbackStatus: record.playbackStatus };
  }

  updateActivePlayback(update: { positionSeconds: number; playbackStatus: PlaylistPlaybackStatus }): void {
    this.active.positionSeconds = update.playbackStatus === "stopped" ? 0 : normalizePosition(update.positionSeconds);
    this.active.playbackStatus = update.playbackStatus;
  }

  updateTrack(track: PlaylistState["entries"][number]["track"]): void {
    for (const record of this.records) record.queue.updateTrack(track);
  }

  markAvailability(
    identity: PlaylistState["entries"][number]["track"]["identity"],
    availability: PlaylistState["entries"][number]["availability"],
  ): void {
    for (const record of this.records) record.queue.markAvailability(identity, availability);
  }

  canonicalTracks(): readonly Track[] {
    const tracks = new Map<string, Track>();
    for (const record of this.records) {
      for (const entry of record.queue.entries) {
        const key = identityKey(entry.track.identity);
        if (!tracks.has(key)) tracks.set(key, entry.track);
      }
    }
    return [...tracks.values()];
  }

  snapshot(): PlaylistCollectionState {
    return {
      activePlaylistId: this.activeId,
      playlists: this.records.map((record): PlaylistState => ({
        id: record.id,
        name: record.name,
        ...record.queue.snapshot(),
        positionSeconds: record.positionSeconds,
        playbackStatus: record.playbackStatus,
      })),
    };
  }

  restore(state: PlaylistCollectionState): void {
    const activeState = state.playlists.find((playlist) => playlist.id === state.activePlaylistId);
    if (!activeState) throw new Error("Active Playlist is missing");
    const activeQueue = this.activeQueue;
    activeQueue.restore(activeState);
    this.records = state.playlists.map((playlist) => {
      const queue = playlist.id === state.activePlaylistId ? activeQueue : new MemoryQueue();
      if (queue !== activeQueue) queue.restore(playlist);
      return {
        id: playlist.id,
        name: playlist.name,
        queue,
        positionSeconds: normalizePosition(playlist.positionSeconds),
        playbackStatus: playlist.playbackStatus,
      };
    });
    this.activeId = state.activePlaylistId;
  }

  private get active(): PlaylistRecord {
    const record = this.records.find((playlist) => playlist.id === this.activeId);
    if (!record) throw new Error("Active Playlist is missing");
    return record;
  }
}

function validatePlaylistName(name: string, existingNames: readonly string[]): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Playlist name cannot be empty");
  if (Array.from(trimmed).length > 16) throw new Error("Playlist name must be at most 16 characters");
  const folded = playlistNameKey(trimmed);
  if (existingNames.some((candidate) => playlistNameKey(candidate) === folded)) {
    throw new Error(`Playlist name is already in use: ${trimmed}`);
  }
  return trimmed;
}

export function playlistNameKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ");
}

function normalizePosition(positionSeconds: number): number {
  return Number.isFinite(positionSeconds) && positionSeconds > 0 ? positionSeconds : 0;
}
