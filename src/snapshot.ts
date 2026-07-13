import { readFile, readdir, rename } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { YOUTUBE_CACHE_PROVIDER_ID, type PlaylistContentState, type SnapshotTrack, type Track, type VolumeState } from "./domain";
import { JsonRecoveryMessages, writeJsonAtomically } from "./json-persistence";

export type LastQueueSnapshotEntry = { track: SnapshotTrack };

export type LastQueueSnapshot = {
  version: 1;
  entries: LastQueueSnapshotEntry[];
  currentIndex: number;
  repeatAll: boolean;
  volume: VolumeState;
  positionSeconds?: number;
};

export type LastQueueSnapshotPersistence = {
  load(): Promise<LastQueueSnapshot | null>;
  save(snapshot: LastQueueSnapshot): Promise<void>;
  drainRecoveryMessages?(): string[];
  wasLastLoadQuarantined?(): boolean;
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
  private quarantinedLastLoad = false;

  constructor(private readonly path: string) {}

  async load(): Promise<LastQueueSnapshot | null> {
    this.recoveryMessages.reset();
    this.quarantinedLastLoad = false;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        this.quarantinedLastLoad = await this.hasQuarantinedSnapshot();
      } else {
        this.recoveryMessages.push(`Could not read Last Queue Snapshot at ${this.path}: ${errorMessage(error)}`);
      }
      return null;
    }

    try {
      const snapshot = parseSnapshot(JSON.parse(raw));
      if (snapshot) return snapshot;
      await this.quarantine("invalid or unsupported");
    } catch (error) {
      await this.quarantine(`corrupted: ${errorMessage(error)}`);
    }
    return null;
  }

  async save(snapshot: LastQueueSnapshot): Promise<void> {
    await writeJsonAtomically(this.path, snapshot);
  }

  drainRecoveryMessages(): string[] {
    return this.recoveryMessages.drain();
  }

  wasLastLoadQuarantined(): boolean {
    return this.quarantinedLastLoad;
  }

  private async quarantine(reason: string): Promise<void> {
    this.quarantinedLastLoad = true;
    const suffix = new Date().toISOString().replaceAll(/[-:.]/g, "");
    const quarantinePath = `${this.path}.corrupt-${suffix}-${crypto.randomUUID()}`;
    try {
      await rename(this.path, quarantinePath);
      this.recoveryMessages.push(
        `Legacy Queue snapshot was ${reason}; moved it to ${quarantinePath}. Make a Playlist or playback-setting change to replace it.`,
      );
    } catch (error) {
      this.recoveryMessages.push(
        `Legacy Queue snapshot was ${reason}, but could not be quarantined: ${errorMessage(error)}`,
      );
    }
  }

  private async hasQuarantinedSnapshot(): Promise<boolean> {
    try {
      const prefix = `${basename(this.path)}.corrupt-`;
      return (await readdir(dirname(this.path))).some((name) => name.startsWith(prefix));
    } catch {
      return false;
    }
  }
}

export function createLastQueueSnapshot(
  queue: Pick<PlaylistContentState, "entries" | "currentIndex" | "repeatAll">,
  volume: VolumeState,
  positionSeconds: number | null | undefined = 0,
): LastQueueSnapshot {
  return {
    version: 1,
    entries: queue.entries.map((entry) => ({
      track: snapshotTrackFromTrack(entry.track),
    })),
    currentIndex: queue.currentIndex,
    repeatAll: queue.repeatAll,
    volume: { ...volume },
    positionSeconds: normalizePosition(positionSeconds),
  };
}

function cloneSnapshot(snapshot: LastQueueSnapshot): LastQueueSnapshot {
  return {
    version: 1,
    entries: snapshot.entries.map((entry) => ({
      track: snapshotTrackFromTrack(entry.track),
    })),
    currentIndex: snapshot.currentIndex,
    repeatAll: snapshot.repeatAll,
    volume: { ...snapshot.volume },
    positionSeconds: snapshot.positionSeconds ?? 0,
  };
}

function parseSnapshot(value: unknown): LastQueueSnapshot | null {
  if (!isObject(value)) return null;
  if (value.version !== 1) return null;
  if (!Array.isArray(value.entries)) return null;
  if (typeof value.currentIndex !== "number") return null;
  if (typeof value.repeatAll !== "boolean") return null;
  if (!isVolumeState(value.volume)) return null;
  const positionSeconds = value.positionSeconds === undefined ? 0 : value.positionSeconds;
  if (!isFiniteNumber(positionSeconds) || positionSeconds < 0) return null;

  const entries: LastQueueSnapshotEntry[] = [];
  for (const entry of value.entries) {
    const parsed = parseSnapshotEntry(entry);
    if (!parsed) return null;
    entries.push(parsed);
  }
  if (!Number.isInteger(value.currentIndex) || value.currentIndex < -1 || value.currentIndex >= entries.length) return null;
  if (value.currentIndex === -1 && positionSeconds !== 0) return null;
  if (new Set(entries.map((entry) => `${entry.track.identity.providerId}\u0000${entry.track.identity.stableId}`)).size !== entries.length) return null;

  return {
    version: 1,
    entries,
    currentIndex: value.currentIndex,
    repeatAll: value.repeatAll,
    volume: value.volume,
    positionSeconds,
  };
}

function parseSnapshotEntry(value: unknown): LastQueueSnapshotEntry | null {
  if (!isObject(value) || !isObject(value.track) || !isObject(value.track.identity)) return null;
  if ("availability" in value) return null;
  if (value.track.identity.providerId !== YOUTUBE_CACHE_PROVIDER_ID) return null;
  if (typeof value.track.identity.stableId !== "string") return null;
  if (typeof value.track.title !== "string") return null;
  if (typeof value.track.providerLabel !== "string") return null;
  return {
    track: snapshotTrackFromTrack(value.track as Track),
  };
}

function isVolumeState(value: unknown): value is VolumeState {
  return isObject(value)
    && isFiniteNumber(value.percent)
    && value.percent >= 0
    && value.percent <= 100
    && typeof value.ready === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizePosition(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isMissingFileError(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (track.durationSeconds !== undefined) snapshotTrack.durationSeconds = track.durationSeconds;
  return snapshotTrack;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}
