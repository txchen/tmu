import type { RedactedTmuConfig } from "./config";
import type { DependencyHealthState } from "./dependencies";

export type NavigationTargetId =
  | "local"
  | "navidrome"
  | "offline-youtube-cache"
  | "youtube-url-download"
  | "queue";

export type FocusedPane = "targets" | "content" | "queue";

export type StartupMode = "empty" | "cli-seeded";

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

export type SnapshotTrack = {
  identity: TrackIdentity;
  title: string;
  providerLabel: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
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

export type PlaybackState = {
  status: "idle" | "playing" | "paused" | "stopped" | "error";
  currentTrackIdentity: TrackIdentity | null;
  message?: string;
};

export type Provider = {
  id: string;
  label: string;
  hint: string;
  listVisibleTracks(): readonly Track[];
  resolvePlaybackLocator(identity: TrackIdentity): Promise<PlaybackLocator>;
};

export type Player = {
  readonly playback: PlaybackState;
  load(locator: PlaybackLocator): Promise<void>;
  togglePause(): Promise<PlaybackState>;
  stop(): Promise<PlaybackState>;
};

export type Queue = {
  readonly entries: readonly QueueEntry[];
  readonly currentIndex: number;
  enqueue(track: Track): QueueEntry;
  remove(index: number): QueueEntry | undefined;
  move(fromIndex: number, toIndex: number): QueueEntry | undefined;
  clear(): void;
  startAt(index: number): QueueEntry | undefined;
  next(): QueueEntry | undefined;
  previous(): QueueEntry | undefined;
  setShuffle(enabled: boolean): void;
  setRepeatAll(enabled: boolean): void;
  markAvailability(identity: TrackIdentity, availability: TrackAvailability): void;
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
  startupMode: StartupMode;
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
  activePrompt: null | "youtube-url";
  filterText: string;
  scrollByPane: Record<FocusedPane, number>;
};

export type AppIntent =
  | { type: "selectNavigationTarget"; targetId: NavigationTargetId }
  | { type: "moveSelection"; delta: number }
  | { type: "cycleFocus" }
  | { type: "enqueueSelectedTrack" }
  | { type: "startSelectedQueueEntry" }
  | { type: "removeSelectedQueueEntry" }
  | { type: "moveSelectedQueueEntry"; delta: number }
  | { type: "clearQueue" }
  | { type: "nextTrack" }
  | { type: "previousTrack" }
  | { type: "toggleShuffle" }
  | { type: "toggleRepeatAll" }
  | { type: "setVolume"; percent: number; ready: boolean }
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

export function navigationTargetIndex(targetId: NavigationTargetId): number {
  const index = NAVIGATION_TARGETS.findIndex((target) => target.id === targetId);
  return index === -1 ? 0 : index;
}

export function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, value));
}
