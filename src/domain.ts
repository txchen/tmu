import type { RedactedTmuConfig } from "./config";
import type { DependencyHealthState } from "./dependencies";

export type ResponsiveTier = "wide" | "medium" | "narrow" | "terminal-too-small";
export const YOUTUBE_CACHE_PROVIDER_ID = "youtube-cache" as const;
export type ProviderId = typeof YOUTUBE_CACHE_PROVIDER_ID;
export type ConfirmationKind =
  | "clear-playlist"
  | "delete-playlist"
  | "cancel-download"
  | "remove-pending-download"
  | "delete-cache"
  | "cleanup-cache"
  | "accept-playlist"
  | "quit-downloads";

export type PickerOverlay = {
  kind: "shortcut-help";
  focus: "search" | "results";
  query: string;
  scroll: number;
  pendingG: boolean;
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

export type PlaylistEntry = {
  track: Track;
  availability: TrackAvailability;
};

export type PlaylistContentState = {
  entries: PlaylistEntry[];
  currentIndex: number;
  repeatAll: boolean;
};

export type PlaylistPlaybackStatus = "stopped" | "resumable";

export type PlaylistState = PlaylistContentState & {
  id: string;
  name: string;
  positionSeconds: number;
  playbackStatus: PlaylistPlaybackStatus;
};

export type PlaylistCollectionState = {
  playlists: PlaylistState[];
  activePlaylistId: string;
};

export type LastPlaylistSnapshotPlaylist = {
  id: string;
  name: string;
  trackIdentities: TrackIdentity[];
  currentTrackIdentity: TrackIdentity | null;
  positionSeconds: number;
  playbackStatus: PlaylistPlaybackStatus;
  repeatAll: boolean;
};

export type LastPlaylistSnapshot = {
  version: 1;
  activePlaylistId: string;
  playlists: LastPlaylistSnapshotPlaylist[];
  tracks: SnapshotTrack[];
  volume: VolumeState;
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

export type PlayerLoadOptions = {
  startSeconds?: number;
};

export type SnapshotTrack = {
  identity: TrackIdentity;
  title: string;
  providerLabel: string;
  artist?: string;
  durationSeconds?: number;
};

export type PlaybackState = PlayerPlaybackState & {
  currentTrackIdentity: TrackIdentity | null;
  /** True only for a Current Track restored from persistence before explicit Resume. */
  restored?: boolean;
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
  load(locator: PlaybackLocator, options?: PlayerLoadOptions): Promise<void>;
  togglePause(): Promise<PlayerPlaybackState>;
  setPaused(paused: boolean): Promise<PlayerPlaybackState>;
  stop(): Promise<PlayerPlaybackState>;
  seekBy(seconds: number): Promise<PlayerPlaybackState>;
  setVolume(percent: number): Promise<PlayerPlaybackState>;
  teardown(): Promise<void>;
  onPlaybackStateChange(listener: (state: PlayerPlaybackState) => void): () => void;
};

export type PlaylistContent = {
  readonly entries: readonly PlaylistEntry[];
  readonly currentIndex: number;
  add(track: Track): PlaylistEntry;
  playNext(tracks: readonly Track[]): readonly PlaylistEntry[];
  playNow(tracks: readonly Track[]): PlaylistEntry | undefined;
  remove(index: number): PlaylistEntry | undefined;
  move(fromIndex: number, toIndex: number): PlaylistEntry | undefined;
  clear(): void;
  startAt(index: number): PlaylistEntry | undefined;
  next(): PlaylistEntry | undefined;
  previous(): PlaylistEntry | undefined;
  randomize(): void;
  setRepeatAll(enabled: boolean): void;
  markAvailability(identity: TrackIdentity, availability: TrackAvailability): void;
  updateTrack(track: Track): PlaylistEntry | undefined;
  snapshot(): PlaylistContentState;
  restore(snapshot: PlaylistContentState): void;
};

export type AppState = {
  config: RedactedTmuConfig;
  configPath: string;
  configSource: "defaults" | "file";
  dependencyHealth: DependencyHealthState;
  providers: Record<string, Provider>;
  activePlaylistContent: PlaylistContentState;
  playlists: PlaylistCollectionState;
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
      itemCount: number;
      progressPercent?: number;
      activeTrack?: { index: number; title?: string; stableId?: string };
    };
    pendingBatches: Array<{ id: number; sourceUrl: string; kind: "single" | "playlist"; itemCount: number }>;
    summaries: Array<{
      id: number;
      sourceUrl: string;
      downloaded: number;
      alreadyCached: number;
      failed: number;
      cancelled: number;
      failures: ReadonlyArray<{ index: number; title?: string; message: string }>;
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
  operationFeedback?: {
    level: "success" | "warning" | "error";
    message: string;
    revision: number;
  };
};

export type UiState = {
  activeTab: "playback" | "library" | "downloader";
  selectedPlaylistIndex: number;
  playlistScroll: number;
  overlays: readonly PickerOverlay[];
  selectedPlaylistIdentity: TrackIdentity | null;
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
    batchId?: number;
    target?: string;
  };
  renameDialog: null | {
    identity: TrackIdentity;
    currentTitle: string;
    value: string;
    cursor: number;
    error: string | null;
  };
  notification: null | {
    level: "success" | "warning" | "error";
    message: string;
    expiresAtMs?: number;
  };
  pendingVimChord: null | {
    key: "g";
    expiresAtMs: number;
  };
  playlistManager: null | {
    selectedIndex: number;
    scroll: number;
    mode: "browse" | "create" | "rename";
    value: string;
    cursor: number;
    error: string | null;
  };
};

export type AppIntent =
  | { type: "playNext"; target: Track }
  | { type: "playNow"; target: Track }
  | { type: "playSelected"; identity: TrackIdentity }
  | { type: "addToPlaylist"; target: Track }
  | { type: "removePlaylistTrack"; identity: TrackIdentity }
  | { type: "movePlaylistTrack"; identity: TrackIdentity; delta: number }
  | { type: "renameTrack"; identity: TrackIdentity; title: string }
  | { type: "clearPlaylist" }
  | { type: "createPlaylist"; name: string }
  | { type: "renamePlaylist"; playlistId: string; name: string }
  | { type: "movePlaylist"; playlistId: string; delta: -1 | 1 }
  | { type: "switchPlaylist"; playlistId: string }
  | { type: "deletePlaylist"; playlistId: string }
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
      | "randomize-playlist"
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
