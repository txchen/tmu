import type { RedactedTmuConfig } from "./config";
import type { DependencyHealthState } from "./dependencies";

export type NavigationTargetId =
  | "local"
  | "navidrome"
  | "offline-youtube-cache"
  | "youtube-url-download"
  | "queue";

export type FocusedPane = "targets" | "content" | "queue";
export type ResponsiveTier = "wide" | "medium" | "narrow" | "terminal-too-small";
export type ProviderLocation = {
  providerId: NavigationTargetId | null;
  path: readonly string[];
};
export type ConfirmationKind = "clear-queue" | "cancel-download" | "quit-download";

export type FocusReturnToken = {
  focusedPane: FocusedPane;
  query: string;
  filterText: string;
  selectedQueueIdentity: TrackIdentity | null;
  selectedQueueIndex: number;
  providerLocation: ProviderLocation;
  scrollByPane: Record<FocusedPane, number>;
};

export type PickerOverlay = {
  kind: "music-picker" | "shortcut-help" | "command-palette" | "confirmation" | "youtube-url";
  focus: "results" | "search" | "filter" | "choice" | "input";
  query: string;
  selectedIdentity: TrackIdentity | null;
  selectedResultIndex?: number;
  scroll: number;
  filterText?: string;
  providerLocation?: ProviderLocation;
  returnTo?: FocusReturnToken;
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
  | { kind: "file"; path: string }
  | { kind: "url"; url: string };

export type Track = {
  identity: TrackIdentity;
  title: string;
  providerLabel: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  coverArtId?: string;
};

export type MusicCollection = {
  kind: "music-collection";
  id: string;
  label: string;
  tracks?: readonly Track[];
  resolve?: {
    providerId: string;
    operation: "album-tracks" | "playlist-tracks";
    collectionId: string;
  };
};

export type PlayableTarget = Track | MusicCollection;

export type ProviderSearchResultType = "track" | "artist" | "album" | "playlist";
export type ProviderBrowseKind = "local-directory" | "artist" | "album" | "playlist" | "track";
export type ProviderOperation = "refresh" | "retry";

export type ProviderCapabilities = {
  readonly searchableResultTypes: readonly ProviderSearchResultType[];
  readonly browsableHierarchy: readonly ProviderBrowseKind[];
  readonly operations: readonly ProviderOperation[];
};

export type ProviderBrowserEntry = {
  readonly id: string;
  readonly kind: ProviderBrowseKind;
  readonly label: string;
  readonly detail?: string;
};

export type ProviderNavigationRoot = {
  readonly visible: boolean;
  readonly order: number;
  readonly detail: string;
};

export type MusicCollectionResolution =
  | { status: "resolved"; tracks: readonly Track[] }
  | { status: "cancelled" };

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
};

export type SnapshotTrack = {
  identity: TrackIdentity;
  title: string;
  providerLabel: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
  coverArtId?: string;
};

export type LastQueueSnapshotEntry = {
  track: SnapshotTrack;
  availability: TrackAvailability;
};

export type LastQueueSnapshot = {
  version: 1;
  entries: LastQueueSnapshotEntry[];
  currentIndex: number;
  shuffle: boolean;
  repeatAll: boolean;
  volume: VolumeState;
};

export type PlaybackState = PlayerPlaybackState & {
  currentTrackIdentity: TrackIdentity | null;
};

export type Provider = {
  id: string;
  label: string;
  hint: string;
  capabilities: ProviderCapabilities;
  getNavigationRoot(): ProviderNavigationRoot;
  listVisibleTracks(): readonly Track[];
  listBrowserEntries?(location: ProviderLocation): readonly ProviderBrowserEntry[];
  playableTargetAt?(location: ProviderLocation, index: number): PlayableTarget | undefined;
  resolveMusicCollection?(
    collection: MusicCollection,
    options?: { signal?: AbortSignal },
  ): Promise<MusicCollectionResolution>;
  resolvePlaybackLocator(identity: TrackIdentity): Promise<PlaybackLocator>;
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

export type NavigationTarget = {
  id: NavigationTargetId;
  label: string;
  hint: string;
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
  };
  appErrors: string[];
  lastEvent: string;
};

export type UiState = {
  activeTargetId: NavigationTargetId;
  focusedPane: FocusedPane;
  selectedTargetIndex: number;
  selectedContentIndexByTarget: Record<NavigationTargetId, number>;
  selectedQueueIndex: number;
  activePrompt: null | "youtube-url" | "local-open-path" | "navidrome-search";
  promptInput: string;
  filterText: string;
  scrollByPane: Record<FocusedPane, number>;
  overlays: readonly PickerOverlay[];
  selectedQueueIdentity: TrackIdentity | null;
  providerLocation: ProviderLocation;
  providerNavigationMemory: {
    location: ProviderLocation;
    selectedIndex: number;
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
  | { type: "playNext"; target: PlayableTarget; signal?: AbortSignal }
  | { type: "playNow"; target: PlayableTarget; signal?: AbortSignal }
  | { type: "removeQueueTrack"; identity: TrackIdentity }
  | { type: "moveQueueTrack"; identity: TrackIdentity; delta: number }
  | { type: "clearQueue" }
  | { type: "providerOperation"; providerId: string; operation: "refresh" | "retry" }
  | { type: "providerOperation"; providerId: string; operation: "browse-query"; query: string }
  | { type: "providerOperation"; providerId: string; operation: "open-path"; path: string; signal?: AbortSignal }
  | { type: "providerOperation"; providerId: string; operation: "cancel-open" }
  | { type: "downloadOperation"; operation: "start"; url: string }
  | { type: "downloadOperation"; operation: "cancel" }
  | { type: "persistenceOperation"; operation: "save" | "restore" }
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

/** @deprecated Legacy ANSI TUI migration surface. New UI actions create AppIntent values. */
export type LegacyAppIntent =
  | { type: "selectNavigationTarget"; targetId: NavigationTargetId }
  | { type: "moveSelection"; delta: number }
  | { type: "activateSelectedContent" }
  | { type: "cycleFocus" }
  | { type: "enqueueSelectedTrack" }
  | { type: "refreshNavidromeLibrary" }
  | { type: "openNavidromeSearchPrompt" }
  | { type: "searchNavidromeTracks"; query: string }
  | { type: "openLocalPathPrompt" }
  | { type: "setPromptInput"; value: string }
  | { type: "submitPrompt" }
  | { type: "cancelPrompt" }
  | { type: "cancelLocalOpen" }
  | { type: "cancelYouTubeDownload" }
  | { type: "openLocalPath"; path: string; signal?: AbortSignal }
  | { type: "startSelectedQueueEntry" }
  | { type: "removeSelectedQueueEntry" }
  | { type: "moveSelectedQueueEntry"; delta: number }
  | { type: "clearQueue" }
  | { type: "nextTrack" }
  | { type: "previousTrack" }
  | { type: "toggleShuffle" }
  | { type: "toggleRepeatAll" }
  | { type: "setVolume"; percent: number; ready: boolean }
  | { type: "adjustVolume"; delta: number }
  | { type: "seekBy"; seconds: number }
  | { type: "saveLastQueueSnapshot" }
  | { type: "restoreLastQueueSnapshot" }
  | { type: "togglePlayPause" }
  | { type: "stop" }
  | { type: "quit" };

export const NAVIGATION_TARGETS: readonly NavigationTarget[] = [
  { id: "local", label: "Local", hint: "files and folders" },
  { id: "navidrome", label: "Navidrome", hint: "artists, albums, playlists" },
  { id: "offline-youtube-cache", label: "Offline YouTube Cache", hint: "downloaded YouTube audio" },
  { id: "youtube-url-download", label: "YouTube URL Download", hint: "download then enqueue" },
  { id: "queue", label: "Queue", hint: "shared playback queue" },
];

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

export function navigationTargetIndex(targetId: NavigationTargetId): number {
  const index = NAVIGATION_TARGETS.findIndex((target) => target.id === targetId);
  return index === -1 ? 0 : index;
}

export function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, value));
}
