import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LastQueueSnapshot, LastQueueSnapshotEntry, QueueEntry, SnapshotTrack, Track, VolumeState } from "./domain";
import { JsonRecoveryMessages, loadJsonRecord } from "./json-persistence";

export type LastQueueSnapshotPersistence = {
  load(): Promise<LastQueueSnapshot | null>;
  save(snapshot: LastQueueSnapshot): Promise<void>;
  drainRecoveryMessages?(): string[];
};

export class InMemoryLastQueueSnapshotPersistence implements LastQueueSnapshotPersistence {
  private snapshot: LastQueueSnapshot | null = null;

  async load(): Promise<LastQueueSnapshot | null> {
    return this.snapshot ? cloneSnapshot(this.snapshot) : null;
  }

  async save(snapshot: LastQueueSnapshot): Promise<void> {
    this.snapshot = cloneSnapshot(snapshot);
  }
}

export class FileLastQueueSnapshotPersistence implements LastQueueSnapshotPersistence {
  private recoveryMessages = new JsonRecoveryMessages();

  constructor(private readonly path: string) {}

  async load(): Promise<LastQueueSnapshot | null> {
    return loadJsonRecord({
      path: this.path,
      label: "Last Queue Snapshot",
      recoveryMessages: this.recoveryMessages,
      parse: parseSnapshot,
    });
  }

  async save(snapshot: LastQueueSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await Bun.write(this.path, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  drainRecoveryMessages(): string[] {
    return this.recoveryMessages.drain();
  }
}

export function createLastQueueSnapshot(
  queue: Omit<LastQueueSnapshot, "version" | "volume">,
  volume: VolumeState,
): LastQueueSnapshot {
  return {
    version: 1,
    entries: queue.entries.map((entry) => ({
      track: snapshotTrackFromTrack(entry.track),
      availability: entry.availability,
    })),
    currentIndex: queue.currentIndex,
    shuffle: queue.shuffle,
    repeatAll: queue.repeatAll,
    volume: { ...volume },
  };
}

function cloneSnapshot(snapshot: LastQueueSnapshot): LastQueueSnapshot {
  return {
    version: 1,
    entries: snapshot.entries.map((entry) => ({
      track: snapshotTrackFromTrack(entry.track),
      availability: cloneAvailability(entry.availability),
    })),
    currentIndex: snapshot.currentIndex,
    shuffle: snapshot.shuffle,
    repeatAll: snapshot.repeatAll,
    volume: { ...snapshot.volume },
  };
}

function parseSnapshot(value: unknown): LastQueueSnapshot | null {
  if (!isObject(value)) return null;
  if (value.version !== 1) return null;
  if (!Array.isArray(value.entries)) return null;
  if (typeof value.currentIndex !== "number") return null;
  if (typeof value.shuffle !== "boolean") return null;
  if (typeof value.repeatAll !== "boolean") return null;
  if (!isVolumeState(value.volume)) return null;

  const entries: LastQueueSnapshotEntry[] = [];
  for (const entry of value.entries) {
    const parsed = parseSnapshotEntry(entry);
    if (!parsed) return null;
    entries.push(parsed);
  }

  return {
    version: 1,
    entries,
    currentIndex: value.currentIndex,
    shuffle: value.shuffle,
    repeatAll: value.repeatAll,
    volume: value.volume,
  };
}

function parseSnapshotEntry(value: unknown): LastQueueSnapshotEntry | null {
  if (!isObject(value) || !isObject(value.track) || !isObject(value.track.identity)) return null;
  if (typeof value.track.identity.providerId !== "string") return null;
  if (typeof value.track.identity.stableId !== "string") return null;
  if (typeof value.track.title !== "string") return null;
  if (typeof value.track.providerLabel !== "string") return null;
  if (!isObject(value.availability) || typeof value.availability.status !== "string") return null;
  if (!["unknown", "available", "unavailable"].includes(value.availability.status)) return null;
  if (value.availability.status === "unavailable" && typeof value.availability.reason !== "string") return null;

  return {
    track: snapshotTrackFromTrack(value.track as Track),
    availability: cloneAvailability(value.availability as QueueEntry["availability"]),
  };
}

function isVolumeState(value: unknown): value is VolumeState {
  return isObject(value)
    && typeof value.percent === "number"
    && typeof value.ready === "boolean";
}

function cloneAvailability(entry: QueueEntry["availability"]): QueueEntry["availability"] {
  if (entry.status === "unavailable") return { status: "unavailable", reason: entry.reason };
  return { status: entry.status };
}

function snapshotTrackFromTrack(track: Track | SnapshotTrack): SnapshotTrack {
  const snapshotTrack: SnapshotTrack = {
    identity: {
      providerId: track.identity.providerId,
      stableId: track.identity.stableId,
    },
    title: track.title,
    providerLabel: track.providerLabel,
  };
  if (track.artist !== undefined) snapshotTrack.artist = track.artist;
  if (track.album !== undefined) snapshotTrack.album = track.album;
  if (track.durationSeconds !== undefined) snapshotTrack.durationSeconds = track.durationSeconds;
  if (track.coverArtId !== undefined) snapshotTrack.coverArtId = track.coverArtId;
  return snapshotTrack;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
