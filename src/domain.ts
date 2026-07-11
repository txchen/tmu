import type { RedactedTmuConfig } from "./config";
import type { DependencyHealthState } from "./dependencies";

export type ResponsiveTier = "wide" | "medium" | "narrow" | "terminal-too-small";
export const YOUTUBE_CACHE_PROVIDER_ID = "youtube-cache" as const;
export type ProviderId = typeof YOUTUBE_CACHE_PROVIDER_ID;
export type ConfirmationKind = "clear-queue" | "cancel-download" | "quit-download";

export type PickerOverlay = {
  kind: "shortcut-help";
  focus: "search" | "results";
  query: string;
  scroll: number;
};

export type TrackAvailability =
  | { status: "unknown" }
  | { status: "available" }
  | { status: "unavailable"; reason: string };

export type TrackIdentity = {
  providerId: string;
  stableId: string;
};

export type PlaybackLocator =
  { kind: "file"; path: string };

export type LocalPlaybackLocator = { kind: "file"; path: string };

export type Track = {
  identity: TrackIdentity;
  title: string;
  providerLabel: string;
  artist?: string;
  durationSeconds?: number;
};

export type QueueEntry = {
  track: Track;
  availability: TrackAvailability;
};

export type QueueState = {
  entries: QueueEntry[];
  currentIndex: number;
  shuffle: boolean;
  repeatAll: boolean;
};

export type VolumeState = {
  percent: number;
  ready: boolean;
};

export type PlaybackCommandError = {
  command: string;
  message: string;
  recoverable: boolean;
};

export class PlaybackFailure extends Error {
  override readonly name = "PlaybackFailure";
}

export type PlayerPlaybackState = {
  status: "idle" | "playing" | "paused" | "stopped" | "error";
  positionSeconds?: number | null;
  durationSeconds?: number | null;
  paused?: boolean | null;
  idle?: boolean | null;
  eof?: boolean;
  volumePercent?: number | null;
  commandError?: PlaybackCommandError;
  message?: string;
  failureKind?: "playback";
};

export type SnapshotTrack = {
  identity: TrackIdentity;
  title: string;
  providerLabel: string;
  artist?: string;
  durationSeconds?: number;
};

export type LastQueueSnapshotEntry = {
  track: SnapshotTrack;
};

export type LastQueueSnapshot = {
  version: 1;
  entries: LastQueueSnapshotEntry[];
  currentIndex: number;
  shuffle: boolean;
  repeatAll: boolean;
  volume: VolumeState;
  /** Last resumable position for Current Track. Missing in legacy version-1 files means zero. */
  positionSeconds?: number;
};

export type PlaybackState = PlayerPlaybackState & {
  currentTrackIdentity: TrackIdentity | null;
};

export type Provider = {
  id: string;
  label: string;
  listTracks(): readonly Track[];
  searchTracks(query: string): readonly Track[];
  resolvePlaybackLocator(identity: TrackIdentity): Promise<LocalPlaybackLocator>;
};

export type Player = {
  readonly playback: PlayerPlaybackState;
  start(): Promise<PlayerPlaybackState>;
  load(locator: PlaybackLocator): Promise<void>;
  togglePause(): Promise<PlayerPlaybackState>;
  setPaused(paused: boolean): Promise<PlayerPlaybackState>;
  stop(): Promise<PlayerPlaybackState>;
  seekBy(seconds: number): Promise<PlayerPlaybackState>;
  setVolume(percent: number): Promise<PlayerPlaybackState>;
  teardown(): Promise<void>;
  onPlaybackStateChange(listener: (state: PlayerPlaybackState) => void): () => void;
};

export type Queue = {
  readonly entries: readonly QueueEntry[];
  readonly currentIndex: number;
  enqueue(track: Track): QueueEntry;
  playNext(tracks: readonly Track[]): readonly QueueEntry[];
  playNow(tracks: readonly Track[]): QueueEntry | undefined;
  remove(index: number): QueueEntry | undefined;
  move(fromIndex: number, toIndex: number): QueueEntry | undefined;
  clear(): void;
  startAt(index: number): QueueEntry | undefined;
  next(): QueueEntry | undefined;
  previous(): QueueEntry | undefined;
  setShuffle(enabled: boolean): void;
  setRepeatAll(enabled: boolean): void;
  markAvailability(identity: TrackIdentity, availability: TrackAvailability): void;
  updateTrack(track: Track): QueueEntry | undefined;
  snapshot(): QueueState;
  restore(snapshot: QueueState): void;
};

export type AppState = {
  config: RedactedTmuConfig;
  configPath: string;
  configSource: "defaults" | "file";
  dependencyHealth: DependencyHealthState;
  providers: Record<string, Provider>;
  queue: QueueState;
  playback: PlaybackState;
  volume: VolumeState;
  downloads: {
    active: boolean;
    lines: string[];
    confirmation?: { title: string; itemCount: number };
    summary?: { downloaded: number; alreadyCached: number; failed: number; cancelled: number };
    activeBatch?: {
      id: number;
      sourceUrl: string;
      kind: "single" | "playlist";
      activeTrack?: { index: number; title?: string; stableId?: string };
    };
    pendingBatches: Array<{ id: number; sourceUrl: string; kind: "single" | "playlist" }>;
    summaries: Array<{
      id: number;
      sourceUrl: string;
      downloaded: number;
      alreadyCached: number;
      failed: number;
      cancelled: number;
    }>;
    quitConfirmationRequired: boolean;
    preparingSubmissions: number;
    acceptedSubmission?: { id: number; input: string };
  };
  cacheConfirmation?: {
    kind: "delete-track" | "cleanup-incomplete";
    stem: string;
    title?: string;
    stopsPlayback: boolean;
  };
  appErrors: string[];
  lastEvent: string;
};

export type UiState = {
  activeTab: "playback" | "library" | "downloader";
  selectedQueueIndex: number;
  queueScroll: number;
  overlays: readonly PickerOverlay[];
  selectedQueueIdentity: TrackIdentity | null;
  library: {
    query: string;
    inputFocused: boolean;
    selectedIndex: number;
    healthSelectedIndex: number;
    scroll: number;
  };
  downloader: {
    urlInput: string;
    inputFocused: boolean;
    selectedBatchIndex: number;
    scroll: number;
  };
  terminal: {
    columns: number;
    rows: number;
    tier: ResponsiveTier;
  };
  pendingConfirmation: null | {
    kind: ConfirmationKind;
    choice: "cancel" | "confirm";
  };
  pendingVimChord: null | {
    key: "g";
    expiresAtMs: number;
  };
};

export type AppIntent =
  | { type: "playNext"; target: Track }
  | { type: "playNow"; target: Track }
  | { type: "addToQueue"; target: Track }
  | { type: "removeQueueTrack"; identity: TrackIdentity }
  | { type: "moveQueueTrack"; identity: TrackIdentity; delta: number }
  | { type: "clearQueue" }
  | { type: "cacheOperation"; operation: "request-delete"; identity: TrackIdentity }
  | { type: "cacheOperation"; operation: "request-cleanup"; stem: string }
  | { type: "cacheOperation"; operation: "confirm" | "cancel" }
  | { type: "downloadOperation"; operation: "start"; url: string }
  | { type: "downloadOperation"; operation: "cancel" | "cancel-active" | "confirm-quit" | "cancel-quit" }
  | { type: "downloadOperation"; operation: "remove-pending"; batchId: number }
  | { type: "downloadOperation"; operation: "acknowledge-accepted"; submissionId: number }
  | { type: "downloadOperation"; operation: "confirm-playlist" | "cancel-playlist" }
  | {
    type: "playerOperation";
    operation:
      | "toggle-play-pause"
      | "stop"
      | "next-track"
      | "previous-track"
      | "toggle-shuffle"
      | "toggle-repeat-all"
      | "quit";
  }
  | { type: "playerOperation"; operation: "seek"; seconds: number }
  | { type: "playerOperation"; operation: "adjust-volume"; delta: number }
  | { type: "playerOperation"; operation: "set-volume"; percent: number; ready: boolean };

export function identityKey(identity: TrackIdentity): string {
  return `${identity.providerId}:${identity.stableId}`;
}

export function sameIdentity(left: TrackIdentity | null | undefined, right: TrackIdentity | null | undefined): boolean {
  if (!left || !right) return false;
  return left.providerId === right.providerId && left.stableId === right.stableId;
}

export function isRestoredPlayback(playback: PlayerPlaybackState): boolean {
  return playback.status === "paused"
    && playback.paused !== true
    && (playback.positionSeconds ?? 0) > 0;
}

export function uniqueTracksByIdentity(tracks: readonly Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    const key = identityKey(track.identity);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, value));
}
