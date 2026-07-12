import {
  clampIndex,
  identityKey,
  PlaybackFailure,
  YOUTUBE_CACHE_PROVIDER_ID,
  sameIdentity,
  type AppIntent,
  type AppState,
  type LastQueueSnapshot,
  type Player,
  type PlayerPlaybackState,
  type Provider,
  type Queue,
  type QueueEntry,
  type Track,
  type UiState,
} from "./domain";
import {
  nodeDependencyCommandRunner,
  playbackHealthMessage,
  youtubeDownloadHealthMessage,
  type DependencyCommandRunner,
  type DependencyHealthState,
  type HelperName,
} from "./dependencies";
import {
  isYouTubeCacheProvider,
  defaultYouTubeCacheDirectory,
} from "./youtube-cache";
import {
  InMemoryAppPreferencesPersistence,
  type AppPreferencesRecord,
  type AppPreferencesPersistence,
} from "./preferences";
import {
  InMemoryLastQueueSnapshotPersistence,
  createLastQueueSnapshot,
  type LastQueueSnapshotPersistence,
} from "./snapshot";
import {
  executeYouTubeDownloadBatch,
  prepareYouTubeDownloadBatch,
  type PrepareYouTubeDownloadBatchResult,
  type DownloadBatchEntry,
  type YouTubeDownloadBatch,
} from "./youtube-url-download";
import { UiStateStore, type UiStateAction } from "./ui-state";

export type DependencyHealthRefresh = (
  helper: HelperName,
  currentHealth: DependencyHealthState,
) => Promise<DependencyHealthState>;
export type AppStateChangeReason = "state" | "playback";

export type AppCoordinatorOptions = {
  appState: AppState;
  uiState: UiState;
  queue: Queue;
  player: Player;
  refreshDependencyHealth?: DependencyHealthRefresh;
  snapshotPersistence?: LastQueueSnapshotPersistence;
  appPreferencesPersistence?: AppPreferencesPersistence;
  dependencyRunner?: DependencyCommandRunner;
  prepareDownloadBatch?: typeof prepareYouTubeDownloadBatch;
  executeDownloadBatch?: typeof executeYouTubeDownloadBatch;
  now?: () => number;
};

export class AppCoordinator {
  private readonly checkedHelpers = new Set<HelperName>();
  readonly appState: AppState;
  private readonly uiStateStore: UiStateStore;
  private readonly queue: Queue;
  private readonly player: Player;
  private readonly refreshDependencyHealth: DependencyHealthRefresh;
  private readonly snapshotPersistence: LastQueueSnapshotPersistence;
  private readonly appPreferencesPersistence: AppPreferencesPersistence;
  private readonly dependencyRunner: DependencyCommandRunner;
  private readonly prepareDownloadBatch: typeof prepareYouTubeDownloadBatch;
  private readonly executeDownloadBatch: typeof executeYouTubeDownloadBatch;
  private pendingPlaylistConfirmation: {
    id: number;
    sourceUrl: string;
    prepared: Extract<PrepareYouTubeDownloadBatchResult, { kind: "confirmation-required" }>;
    settle(): void;
  } | null = null;
  private readonly pendingDownloadBatches: Array<{ id: number; batch: YouTubeDownloadBatch }> = [];
  private activeDownloadBatch: { id: number; batch: YouTubeDownloadBatch; controller: AbortController } | null = null;
  private nextDownloadBatchId = 1;
  private downloadSubmissionTail: Promise<void> = Promise.resolve();
  private activeDownloadPreparation: AbortController | null = null;
  private readonly unsubscribeFromPlayer: () => void;
  private readonly stateListeners = new Set<(reason: AppStateChangeReason) => void>();
  private activeDownloadTask: Promise<void> | null = null;
  private naturalAdvanceInFlight = false;
  private tornDown = false;
  private readonly now: () => number;
  private lastSnapshotCheckpointAt = Number.NEGATIVE_INFINITY;
  private snapshotSaveBlockedUntilMeaningfulChange = false;
  private snapshotWriteTail: Promise<void> = Promise.resolve();
  private feedbackRevision = 0;

  constructor(options: AppCoordinatorOptions) {
    this.appState = options.appState;
    this.uiStateStore = new UiStateStore(options.uiState);
    this.queue = options.queue;
    this.player = options.player;
    this.refreshDependencyHealth = options.refreshDependencyHealth ?? (async (_helper, currentHealth) => currentHealth);
    this.snapshotPersistence = options.snapshotPersistence ?? new InMemoryLastQueueSnapshotPersistence();
    this.appPreferencesPersistence = options.appPreferencesPersistence
      ?? new InMemoryAppPreferencesPersistence();
    this.dependencyRunner = options.dependencyRunner ?? nodeDependencyCommandRunner;
    this.prepareDownloadBatch = options.prepareDownloadBatch ?? prepareYouTubeDownloadBatch;
    this.executeDownloadBatch = options.executeDownloadBatch ?? executeYouTubeDownloadBatch;
    this.now = options.now ?? Date.now;
    this.unsubscribeFromPlayer = this.player.onPlaybackStateChange((playback) => {
      const reachedNaturalEnd = playback.status === "idle" && playback.eof === true;
      this.mergePlayerPlayback(playback);
      const playbackFailed = playback.failureKind === "playback";
      if (playbackFailed) this.recordCurrentTrackPlaybackFailure(playback.message);
      this.notifyStateChanged("playback");
      this.maybeCheckpointLastQueueSnapshot(playback);
      if (reachedNaturalEnd || playbackFailed) void this.advanceAfterTerminalPlaybackEvent();
    });
    this.syncQueueState();
  }

  get uiState(): Readonly<UiState> {
    return this.uiStateStore.snapshot;
  }

  dispatchUi(action: UiStateAction): Readonly<UiState> {
    const snapshot = this.uiStateStore.dispatch(action);
    this.notifyStateChanged();
    return snapshot;
  }

  queueTrackIdentities() {
    return this.queueIdentities();
  }

  async start(): Promise<void> {
    await this.restoreAppPreferences();
    await this.restoreQueueSnapshotIfPresent();
    this.syncQueueState();
    this.notifyStateChanged();
  }

  async dispatch(intent: AppIntent): Promise<void> {
    const beforeSnapshot = this.snapshotFingerprint();
    try {
      switch (intent.type) {
        case "playNext":
          await this.playNextTarget(intent.target);
          return;
        case "playNow":
          await this.playNowTarget(intent.target);
          return;
        case "playSelected":
          await this.playSelected(intent.identity);
          return;
        case "addToQueue":
          this.addToQueue(intent.target);
          return;
        case "removeQueueTrack":
          await this.removeQueueTrack(intent.identity);
          return;
        case "moveQueueTrack":
          this.moveQueueTrack(intent.identity, intent.delta);
          return;
        case "downloadOperation":
          if (intent.operation === "start") this.startYouTubeUrlDownload(intent.url);
          else if (intent.operation === "cancel" || intent.operation === "cancel-active") this.cancelYouTubeDownload();
          else if (intent.operation === "confirm-playlist") this.confirmPlaylistDownload();
          else if (intent.operation === "cancel-playlist") this.cancelPlaylistDownload();
          else if (intent.operation === "remove-pending") this.removePendingDownloadBatch(intent.batchId);
          else if (intent.operation === "acknowledge-accepted") this.acknowledgeAcceptedSubmission(intent.submissionId);
          else if (intent.operation === "confirm-quit") await this.confirmQuitWithDownloads();
          else this.cancelQuitWithDownloads();
          return;
        case "cacheOperation":
          if (intent.operation === "request-delete") this.requestCacheDeletion(intent.identity);
          else if (intent.operation === "request-cleanup") this.requestCacheHealthCleanup(intent.stem);
          else if (intent.operation === "confirm") await this.confirmCacheOperation();
          else this.cancelCacheOperation();
          return;
        case "playerOperation":
          await this.dispatchPlayerOperation(intent);
          return;
        case "clearQueue":
          await this.clearQueue();
          return;
      }
    } finally {
      this.notifyStateChanged();
      const persistenceIntent = intent.type === "playerOperation" && intent.operation === "quit";
      const forceSave = intent.type === "playerOperation"
        && ["toggle-play-pause", "stop"].includes(intent.operation);
      if (!this.tornDown && !persistenceIntent) {
        const meaningful = beforeSnapshot !== this.snapshotFingerprint();
        if (meaningful || forceSave) await this.saveLastQueueSnapshot({ meaningful });
      }
    }
  }

  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    await this.saveLastQueueSnapshot({ meaningful: false });
    this.pendingDownloadBatches.length = 0;
    this.pendingPlaylistConfirmation?.prepared.cancel();
    this.pendingPlaylistConfirmation?.settle();
    this.pendingPlaylistConfirmation = null;
    this.activeDownloadPreparation?.abort();
    this.activeDownloadBatch?.controller.abort();
    this.unsubscribeFromPlayer();
    const cleanupFailures: string[] = [];
    await this.downloadSubmissionTail.catch((error) => {
      cleanupFailures.push(error instanceof Error ? error.message : String(error));
    });
    if (this.activeDownloadTask) {
      await this.activeDownloadTask.catch((error) => {
        cleanupFailures.push(error instanceof Error ? error.message : String(error));
      });
    }
    await this.player.teardown().catch((error) => {
      cleanupFailures.push(error instanceof Error ? error.message : String(error));
    });
    for (const failure of cleanupFailures) {
      this.appState.appErrors.push(`Coordinator cleanup failed: ${failure}`);
    }
    if (cleanupFailures.length > 0) {
      this.appState.lastEvent = this.appState.appErrors.at(-1) ?? "Coordinator cleanup failed";
    }
  }

  onStateChange(listener: (reason: AppStateChangeReason) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private async restoreAppPreferences(): Promise<void> {
    const record = await this.appPreferencesPersistence.load();
    this.recordPersistenceRecoveryMessages(this.appPreferencesPersistence);

    if (record?.repeatAll !== undefined) this.queue.setRepeatAll(record.repeatAll);
    if (record?.volume !== undefined) this.appState.volume = { ...record.volume };

    this.syncQueueState();
  }

  private async persistPlaybackPreferences(): Promise<void> {
    const queue = this.queue.snapshot();
    await this.persistAppPreferences({
      repeatAll: queue.repeatAll,
      volume: this.appState.volume,
    });
  }

  private async persistAppPreferences(patch: Omit<Partial<AppPreferencesRecord>, "version">): Promise<void> {
    try {
      const existing = await this.appPreferencesPersistence.load();
      this.recordPersistenceRecoveryMessages(this.appPreferencesPersistence);
      await this.appPreferencesPersistence.save({
        ...(existing ?? {}),
        ...patch,
        version: 1,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appState.appErrors.push(`Could not persist app preferences: ${message}`);
    }
  }

  private async restoreQueueSnapshotIfPresent(): Promise<void> {
    const snapshot = await this.snapshotPersistence.load();
    this.recordPersistenceRecoveryMessages(this.snapshotPersistence);
    this.snapshotSaveBlockedUntilMeaningfulChange = this.snapshotPersistence.wasLastLoadQuarantined?.() ?? false;
    if (!snapshot) return;

    await this.applyLastQueueSnapshot(snapshot);
  }

  private recordPersistenceRecoveryMessages(persistence: { drainRecoveryMessages?(): string[] }): void {
    for (const message of persistence.drainRecoveryMessages?.() ?? []) {
      this.appState.appErrors.push(message);
    }
  }

  private async applyLastQueueSnapshot(snapshot: LastQueueSnapshot): Promise<void> {
    this.queue.restore({
      ...snapshot,
      entries: snapshot.entries.map((entry) => ({
        track: entry.track,
        availability: { status: "unknown" },
      })),
    });
    await this.refreshRestoredProviderAvailability();
    this.appState.volume = snapshot.volume;
    if (snapshot.volume.ready) {
      await this.runPlayerCommand(() => this.player.setVolume(snapshot.volume.percent));
    }
    const current = this.queue.entries[this.queue.currentIndex];
    this.appState.playback = current
      ? {
        status: "paused",
        positionSeconds: snapshot.positionSeconds ?? 0,
        currentTrackIdentity: current.track.identity,
        restored: true,
      }
      : { status: "idle", currentTrackIdentity: null };
    this.selectQueueIndex(current ? this.queue.currentIndex : 0);
    this.syncQueueState();
  }

  private async playNextTarget(track: Track): Promise<void> {
    const block = this.queue.playNext([track]);
    for (const entry of block) {
      if (entry.availability.status === "unknown") this.markSelectedYouTubeCacheAvailability(entry);
    }
    this.appState.lastEvent = `accepted Play Next for ${block.length} Track${block.length === 1 ? "" : "s"}`;
    this.syncQueueState();
  }

  private async playNowTarget(track: Track): Promise<void> {
    const entry = this.queue.playNow([track]);
    const queuedEntry = this.queue.entries.find((candidate) => sameIdentity(candidate.track.identity, track.identity));
    if (queuedEntry?.availability.status === "unknown") {
      this.markSelectedYouTubeCacheAvailability(queuedEntry);
    }
    await this.startQueueEntryFromBeginning(entry);
  }

  private async playSelected(identity: Track["identity"]): Promise<void> {
    const index = this.queue.entries.findIndex((entry) => sameIdentity(entry.track.identity, identity));
    await this.startQueueEntryFromBeginning(this.queue.startAt(index));
  }

  private async startQueueEntryFromBeginning(entry: QueueEntry | undefined): Promise<void> {
    if (!entry) {
      this.appState.lastEvent = "Track is not in Queue";
      this.syncQueueState();
      return;
    }
    this.appState.playback = {
      ...this.appState.playback,
      currentTrackIdentity: entry.track.identity,
      positionSeconds: 0,
    };
    this.syncQueueState();
    if (this.blockPlaybackActionIfUnavailable()) return;
    if (entry.availability.status === "unavailable") {
      this.markUnavailable(entry, entry.availability.reason);
      return;
    }
    await this.playQueueEntry(entry);
  }

  private addToQueue(track: Track): void {
    const previousLength = this.queue.entries.length;
    const entry = this.queue.enqueue(track);
    if (entry.availability.status === "unknown") this.markSelectedYouTubeCacheAvailability(entry);
    const inserted = this.queue.entries.length > previousLength;
    this.appState.lastEvent = inserted ? `added ${track.title} to Queue` : `${track.title} is already in Queue`;
    this.syncQueueState();
  }

  private async removeQueueTrack(identity: Track["identity"]): Promise<void> {
    const index = this.queue.entries.findIndex((entry) => sameIdentity(entry.track.identity, identity));
    await this.removeQueueEntry(index, "Track is not in Queue");
  }

  private moveQueueTrack(identity: Track["identity"], delta: number): void {
    const fromIndex = this.queue.entries.findIndex((entry) => sameIdentity(entry.track.identity, identity));
    const toIndex = clampIndex(fromIndex + delta, this.queue.entries.length);
    const moved = fromIndex < 0 ? undefined : this.queue.move(fromIndex, toIndex);
    if (!moved) {
      this.appState.lastEvent = "Track is not in Queue";
      this.syncQueueState();
      return;
    }
    this.uiStateStore.dispatch({ type: "syncQueue", identities: this.queueIdentities() });
    this.appState.lastEvent = `moved ${moved.track.title}`;
    this.syncQueueState();
  }

  private async dispatchPlayerOperation(intent: Extract<AppIntent, { type: "playerOperation" }>): Promise<void> {
    switch (intent.operation) {
      case "toggle-play-pause": await this.togglePlayPause(); return;
      case "stop":
        if (this.blockPlaybackActionIfUnavailable()) return;
        await this.stopAndRetainCurrentTrack("stopped");
        return;
      case "next-track": await this.nextTrack(); return;
      case "previous-track": await this.previousTrack(); return;
      case "randomize-queue": this.randomizeQueue(); return;
      case "toggle-repeat-all": await this.toggleRepeatAll(); return;
      case "seek": await this.seekBy(intent.seconds); return;
      case "adjust-volume":
        await this.setVolume((this.appState.volume.ready ? this.appState.volume.percent : 100) + intent.delta, true);
        return;
      case "set-volume": await this.setVolume(intent.percent, intent.ready); return;
      case "quit":
        if (this.hasDownloadWork()) {
          this.appState.downloads.quitConfirmationRequired = true;
          this.appState.lastEvent = "confirm quit to cancel active and pending Download Batches";
          return;
        }
        this.appState.lastEvent = "quit requested";
        await this.teardown();
        return;
    }
  }

  private startYouTubeUrlDownload(url: string): void {
    const id = this.nextDownloadBatchId++;
    this.appState.downloads.preparingSubmissions += 1;
    this.appState.lastEvent = "preparing YouTube URL Download Batch";
    const submission = this.downloadSubmissionTail.then(() => this.prepareSubmittedDownload(id, url))
      .catch((error) => {
        this.appState.lastEvent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.appState.downloads.preparingSubmissions -= 1;
        this.notifyStateChanged();
      });
    this.downloadSubmissionTail = submission;
  }

  private cancelYouTubeDownload(): void {
    if (!this.activeDownloadBatch) {
      this.appState.lastEvent = "no active Download Batch";
      return;
    }

    this.activeDownloadBatch.controller.abort();
    this.recordOperationFeedback("warning", "cancelling active Download Batch and cleaning up partial files");
  }

  private requestCacheDeletion(identity: Track["identity"]): void {
    const provider = this.appState.providers[YOUTUBE_CACHE_PROVIDER_ID];
    if (!isYouTubeCacheProvider(provider)) {
      this.appState.lastEvent = "YouTube Cache is unavailable";
      return;
    }
    const entry = provider.findByIdentity(identity);
    if (!entry) {
      this.appState.lastEvent = `YouTube Cache entry is missing: ${identity.stableId}`;
      return;
    }
    const isCurrent = sameIdentity(this.appState.playback.currentTrackIdentity, identity);
    const stopsPlayback = isCurrent && ["playing", "paused"].includes(this.appState.playback.status);
    this.appState.cacheConfirmation = {
      kind: "delete-track",
      stem: identity.stableId,
      title: entry.track.title,
      stopsPlayback,
    };
    this.appState.lastEvent = stopsPlayback
      ? `confirm permanent Cache Deletion of playing Current Track ${entry.track.title}; playback will stop`
      : `confirm permanent Cache Deletion of ${entry.track.title}`;
  }

  private requestCacheHealthCleanup(stem: string): void {
    const provider = this.appState.providers[YOUTUBE_CACHE_PROVIDER_ID];
    const entry = isYouTubeCacheProvider(provider)
      ? provider.listIncompleteEntries().find((candidate) => candidate.stem === stem)
      : undefined;
    if (!entry) {
      this.appState.lastEvent = `incomplete YouTube Cache entry is missing: ${stem}`;
      return;
    }
    this.appState.cacheConfirmation = {
      kind: "cleanup-incomplete",
      stem,
      ...(entry.title ? { title: entry.title } : {}),
      stopsPlayback: false,
    };
    this.appState.lastEvent = `confirm cleanup of incomplete YouTube Cache entry ${stem}`;
  }

  private async confirmCacheOperation(): Promise<void> {
    const confirmation = this.appState.cacheConfirmation;
    const provider = this.appState.providers[YOUTUBE_CACHE_PROVIDER_ID];
    if (!confirmation || !isYouTubeCacheProvider(provider)) {
      this.appState.lastEvent = "no Cache operation confirmation pending";
      return;
    }
    delete this.appState.cacheConfirmation;
    if (confirmation.kind === "cleanup-incomplete") {
      const removed = await provider.cleanupIncompleteEntry(confirmation.stem);
      this.recordOperationFeedback(
        removed ? "success" : "error",
        removed ? `cleaned incomplete YouTube Cache entry ${confirmation.stem}` : `incomplete YouTube Cache entry is missing: ${confirmation.stem}`,
      );
      return;
    }

    const identity = { providerId: YOUTUBE_CACHE_PROVIDER_ID, stableId: confirmation.stem };
    const deletesPlayingCurrent = sameIdentity(this.appState.playback.currentTrackIdentity, identity)
      && ["playing", "paused"].includes(this.appState.playback.status);
    if (deletesPlayingCurrent && !await this.stopAndRetainCurrentTrack("stopped for Cache Deletion")) return;
    const removed = await provider.deleteCacheEntry(identity);
    if (!removed) {
      this.recordOperationFeedback("error", `YouTube Cache entry is missing: ${confirmation.stem}`);
      return;
    }
    this.queue.markAvailability(identity, {
      status: "unavailable",
      reason: `YouTube Cache entry was deleted: ${confirmation.stem}`,
    });
    this.syncQueueState();
    this.recordOperationFeedback("success", `permanently deleted YouTube Cache entry ${confirmation.stem}`);
  }

  private cancelCacheOperation(): void {
    delete this.appState.cacheConfirmation;
    this.recordOperationFeedback("warning", "Cache operation cancelled");
  }

  private async startSelectedQueueEntry(): Promise<void> {
    if (this.blockPlaybackActionIfUnavailable()) return;

    const entry = this.queue.startAt(this.uiState.selectedQueueIndex);
    if (!entry) {
      this.appState.lastEvent = "Queue is empty";
      this.syncQueueState();
      return;
    }

    if (entry.availability.status === "unavailable") {
      this.markUnavailable(entry, entry.availability.reason);
      return;
    }

    await this.playQueueEntry(entry);
  }

  private async removeSelectedQueueEntry(): Promise<void> {
    await this.removeQueueEntry(this.uiState.selectedQueueIndex, "Queue is empty");
  }

  private async removeQueueEntry(index: number, missingEvent: string): Promise<void> {
    const entry = this.queue.entries[index];
    if (!entry) {
      this.appState.lastEvent = missingEvent;
      this.syncQueueState();
      return;
    }

    const removingCurrent = sameIdentity(entry.track.identity, this.appState.playback.currentTrackIdentity);
    if (removingCurrent && !await this.runPlayerCommand(() => this.player.stop())) return;
    const removed = this.queue.remove(index);
    if (!removed) return;

    if (removingCurrent) this.appState.playback = { status: "idle", currentTrackIdentity: null };
    this.uiStateStore.dispatch({ type: "syncQueue", identities: this.queueIdentities() });
    this.appState.lastEvent = `removed ${removed.track.title}`;
    this.syncQueueState();
  }

  private moveSelectedQueueEntry(delta: number): void {
    const fromIndex = this.uiState.selectedQueueIndex;
    const toIndex = clampIndex(fromIndex + delta, this.queue.entries.length);
    const moved = this.queue.move(fromIndex, toIndex);
    if (!moved) {
      this.appState.lastEvent = "Queue is empty";
      this.syncQueueState();
      return;
    }

    this.selectQueueIndex(toIndex);
    this.appState.lastEvent = `moved ${moved.track.title}`;
    this.syncQueueState();
  }

  private async clearQueue(): Promise<void> {
    if (!await this.runPlayerCommand(() => this.player.stop())) return;
    this.queue.clear();
    this.appState.playback = {
      status: "idle",
      currentTrackIdentity: null,
    };
    this.uiStateStore.dispatch({ type: "syncQueue", identities: [] });
    this.recordOperationFeedback("success", "cleared Queue");
    this.syncQueueState();
  }

  private async nextTrack(): Promise<void> {
    if (this.blockPlaybackActionIfUnavailable()) return;

    if (this.queue.entries.length === 0) {
      this.appState.lastEvent = "end of Queue";
      this.syncQueueState();
      return;
    }

    const originalIdentity = this.appState.playback.currentTrackIdentity;
    let skippedUnavailable = false;
    for (let attempts = 0; attempts < this.queue.entries.length; attempts += 1) {
      const entry = this.queue.next();
      if (!entry) {
        await this.restoreAndStopCurrentTrack(originalIdentity);
        this.appState.lastEvent = skippedUnavailable ? "no available Tracks to play" : "end of Queue";
        this.syncQueueState();
        return;
      }

      if (entry.availability.status === "unavailable") {
        skippedUnavailable = true;
        continue;
      }

      const started = await this.playQueueEntry(entry);
      if (started) return;

      const currentEntry = this.queue.entries[this.queue.currentIndex];
      if (currentEntry?.availability.status === "unavailable") {
        skippedUnavailable = true;
        continue;
      }
      return;
    }

    await this.restoreAndStopCurrentTrack(originalIdentity);
    this.appState.lastEvent = "no available Tracks to play";
    this.syncQueueState();
  }

  private async advanceAfterTerminalPlaybackEvent(): Promise<void> {
    if (this.naturalAdvanceInFlight || this.tornDown) return;
    this.naturalAdvanceInFlight = true;
    try {
      await this.nextTrack();
      await this.saveLastQueueSnapshot({ meaningful: true });
    } finally {
      this.naturalAdvanceInFlight = false;
    }
  }

  private async previousTrack(): Promise<void> {
    if (this.blockPlaybackActionIfUnavailable()) return;

    const current = this.currentQueueEntry();
    if (!current) {
      this.appState.lastEvent = "start of Queue";
      this.syncQueueState();
      return;
    }

    const positionSeconds = this.appState.playback.positionSeconds;
    if (typeof positionSeconds === "number" && Number.isFinite(positionSeconds) && positionSeconds > 5) {
      const wasPaused = this.appState.playback.status === "paused";
      const restarted = await this.runPlayerCommand(() => this.player.seekBy(-positionSeconds));
      if (!restarted) return;
      if (wasPaused && !await this.runPlayerCommand(() => this.player.setPaused(false))) return;
      this.appState.lastEvent = `restarted ${current.track.title}`;
      return;
    }

    const entry = this.queue.previous();
    if (!entry) {
      await this.playQueueEntry(current);
      return;
    }

    await this.playQueueEntry(entry);
  }

  private randomizeQueue(): void {
    this.queue.randomizeUpcoming();
    this.appState.lastEvent = "randomized upcoming Queue";
    this.syncQueueState();
  }

  private async toggleRepeatAll(): Promise<void> {
    this.queue.setRepeatAll(!this.queue.snapshot().repeatAll);
    this.appState.lastEvent = this.queue.snapshot().repeatAll ? "repeat all on" : "repeat all off";
    this.syncQueueState();
    await this.persistPlaybackPreferences();
  }

  private async setVolume(percent: number, ready: boolean): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (!ready) {
      this.appState.volume = { percent: clamped, ready };
      this.appState.lastEvent = "volume unavailable";
      await this.persistPlaybackPreferences();
      return;
    }

    if (this.blockPlaybackActionIfUnavailable()) return;
    const restoredPlayback = this.appState.playback.status === "paused"
      && this.appState.playback.paused !== true
      && (this.appState.playback.positionSeconds ?? 0) > 0
      ? { ...this.appState.playback }
      : null;
    const ok = await this.runPlayerCommand(() => this.player.setVolume(clamped));
    if (!ok) return;
    if (restoredPlayback) {
      this.appState.playback = { ...restoredPlayback, volumePercent: clamped };
    }

    this.appState.volume = { percent: clamped, ready };
    this.appState.lastEvent = `volume ${clamped}%`;
    await this.persistPlaybackPreferences();
  }

  private async seekBy(seconds: number): Promise<void> {
    if (this.blockPlaybackActionIfUnavailable()) return;

    if (!this.appState.playback.currentTrackIdentity) {
      this.appState.lastEvent = "nothing is playing";
      return;
    }

    const ok = await this.runPlayerCommand(() => this.player.seekBy(seconds));
    if (!ok) return;
    this.appState.lastEvent = `seeked ${seconds}s`;
  }

  private async saveLastQueueSnapshot(options: { meaningful?: boolean } = {}): Promise<void> {
    if (this.snapshotSaveBlockedUntilMeaningfulChange && !options.meaningful) return;
    if (options.meaningful) this.snapshotSaveBlockedUntilMeaningfulChange = false;
    const snapshot = this.currentLastQueueSnapshot();
    const write = async () => {
      try {
        await this.snapshotPersistence.save(snapshot);
      } catch (error) {
        const message = `Could not save Last Queue Snapshot: ${error instanceof Error ? error.message : String(error)}. Will retry on the next state change or quit.`;
        this.appState.appErrors.push(message);
        this.appState.lastEvent = message;
        this.notifyStateChanged();
      }
    };
    this.snapshotWriteTail = this.snapshotWriteTail.then(write, write);
    await this.snapshotWriteTail;
  }

  private snapshotFingerprint(): string {
    return JSON.stringify(this.currentLastQueueSnapshot());
  }

  private currentLastQueueSnapshot(): LastQueueSnapshot {
    return createLastQueueSnapshot(
      this.queue.snapshot(),
      this.appState.volume,
      this.appState.playback.positionSeconds,
    );
  }

  private maybeCheckpointLastQueueSnapshot(playback: PlayerPlaybackState): void {
    if (this.tornDown || playback.status !== "playing") return;
    if (typeof playback.positionSeconds !== "number" || !Number.isFinite(playback.positionSeconds)) return;
    const now = this.now();
    if (now - this.lastSnapshotCheckpointAt < 30_000) return;
    this.lastSnapshotCheckpointAt = now;
    void this.saveLastQueueSnapshot({ meaningful: false });
  }

  private async refreshRestoredProviderAvailability(): Promise<void> {
    this.refreshRestoredYouTubeCacheAvailability();
  }

  private refreshRestoredYouTubeCacheAvailability(): void {
    const provider = this.appState.providers[YOUTUBE_CACHE_PROVIDER_ID];
    if (!isYouTubeCacheProvider(provider)) return;

    provider.refresh();
    for (const entry of this.queue.entries) {
      if (entry.track.identity.providerId !== YOUTUBE_CACHE_PROVIDER_ID) continue;

      const cacheEntry = provider.findByIdentity(entry.track.identity);
      if (!cacheEntry) {
        this.queue.markAvailability(entry.track.identity, {
          status: "unavailable",
          reason: `YouTube Cache entry is missing: ${entry.track.identity.stableId}`,
        });
        continue;
      }

      this.queue.updateTrack(cacheEntry.track);
      this.queue.markAvailability(entry.track.identity, cacheEntry.availability);
    }
  }

  private async playQueueEntry(entry: QueueEntry, startSeconds = 0): Promise<boolean> {
    await this.refreshHelperDependency("mpv");
    if (this.blockPlaybackActionIfUnavailable()) return false;

    const provider = this.appState.providers[entry.track.identity.providerId];
    if (!provider) {
      this.markUnavailable(entry, `Provider ${entry.track.identity.providerId} is unavailable`);
      return false;
    }

    let locator;
    try {
      locator = await provider.resolvePlaybackLocator(entry.track.identity);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Playback Locator could not be resolved";
      this.markUnavailable(entry, message);
      return false;
    }

    try {
      await this.player.load(locator, startSeconds > 0 ? { startSeconds } : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof PlaybackFailure) this.markUnavailable(entry, message);
      else this.recordPlayerLoadCommandFailure(message);
      return false;
    }

    this.queue.markAvailability(entry.track.identity, { status: "available" });
    this.appState.playback = {
      ...this.player.playback,
      status: "playing",
      positionSeconds: startSeconds,
      currentTrackIdentity: entry.track.identity,
    };
    this.appState.lastEvent = `started ${entry.track.title}`;
    this.syncQueueState();
    return true;
  }
  private async prepareSubmittedDownload(id: number, url: string): Promise<void> {
    if (this.tornDown) return;
    await this.refreshHelperDependency("yt-dlp");
    if (this.tornDown) return;
    const healthMessage = youtubeDownloadHealthMessage(this.appState.dependencyHealth);
    if (healthMessage) {
      this.appState.lastEvent = healthMessage;
      return;
    }

    const controller = new AbortController();
    this.activeDownloadPreparation = controller;
    const prepared = await this.prepareDownloadBatch(url, {
      command: this.appState.config.helpers.ytDlp,
      timeoutMs: this.appState.config.dependencyPolicy.checkTimeoutMs,
      cookiesFromBrowser: this.appState.config.youtube.cookiesFromBrowser,
      signal: controller.signal,
      runner: this.dependencyRunner,
    }).finally(() => {
      if (this.activeDownloadPreparation === controller) this.activeDownloadPreparation = null;
    });
    if (this.tornDown) return;
    if (prepared.kind === "rejected") {
      this.appState.lastEvent = prepared.message;
      return;
    }
    if (prepared.kind === "confirmation-required") {
      await new Promise<void>((settle) => {
        this.pendingPlaylistConfirmation = { id, sourceUrl: url, prepared, settle };
        this.appState.downloads.confirmation = prepared.confirmation;
        this.appState.lastEvent = `confirm playlist ${prepared.confirmation.title} (${prepared.confirmation.itemCount} items)`;
        this.notifyStateChanged();
      });
      return;
    }

    this.enqueueDownloadBatch(id, prepared.batch, url);
  }

  private async runPreparedDownloadBatch(id: number, batch: YouTubeDownloadBatch, signal: AbortSignal): Promise<void> {
    const summary = await this.executeDownloadBatch(batch, {
      command: this.appState.config.helpers.ytDlp,
      cache: { cacheDir: defaultYouTubeCacheDirectory() },
      cookiesFromBrowser: this.appState.config.youtube.cookiesFromBrowser,
      progressThrottleMs: this.appState.config.lowPower.downloadProgressThrottleMs,
      signal,
      onEntryStart: (entryIndex, entry) => this.recordActiveDownloadTrack(entryIndex, entry),
      onProgress: (entryIndex, line) => this.recordYouTubeDownloadProgress(entryIndex, line),
    });
    const categoricalSummary = {
      downloaded: summary.downloaded,
      alreadyCached: summary.alreadyCached,
      failed: summary.failed,
      cancelled: summary.cancelled,
    };
    this.appState.downloads.summary = categoricalSummary;
    this.appState.downloads.summaries.push({ id, sourceUrl: batch.sourceUrl, ...categoricalSummary, failures: summary.failures });
    this.recordOperationFeedback(
      summary.failed > 0 || summary.cancelled > 0 ? "warning" : "success",
      `Download Batch complete: ${summary.downloaded} downloaded, ${summary.alreadyCached} already cached, ${summary.failed} failed, ${summary.cancelled} cancelled`,
    );
    const provider = this.appState.providers[YOUTUBE_CACHE_PROVIDER_ID];
    if (isYouTubeCacheProvider(provider)) provider.refresh();
  }

  private confirmPlaylistDownload(): void {
    const pending = this.pendingPlaylistConfirmation;
    if (!pending) {
      this.appState.lastEvent = "no playlist confirmation pending";
      return;
    }
    this.pendingPlaylistConfirmation = null;
    delete this.appState.downloads.confirmation;
    this.enqueueDownloadBatch(pending.id, pending.prepared.confirm(), pending.sourceUrl);
    pending.settle();
    this.recordOperationFeedback("success", "created confirmed playlist Download Batch in the Download Pipeline");
  }

  private cancelPlaylistDownload(): void {
    const pending = this.pendingPlaylistConfirmation;
    if (!pending) {
      this.appState.lastEvent = "no playlist confirmation pending";
      return;
    }
    pending.prepared.cancel();
    this.pendingPlaylistConfirmation = null;
    delete this.appState.downloads.confirmation;
    pending.settle();
    this.recordOperationFeedback("warning", "playlist Download Batch cancelled before start");
  }

  private enqueueDownloadBatch(id: number, batch: YouTubeDownloadBatch, submittedInput: string): void {
    this.pendingDownloadBatches.push({ id, batch });
    this.pendingDownloadBatches.sort((left, right) => left.id - right.id);
    this.syncDownloadPipelineState();
    this.appState.downloads.acceptedSubmission = { id, input: submittedInput };
    this.pumpDownloadPipeline();
  }

  private pumpDownloadPipeline(): void {
    if (this.tornDown || this.activeDownloadBatch) return;
    const next = this.pendingDownloadBatches.shift();
    if (!next) {
      this.syncDownloadPipelineState();
      return;
    }
    const controller = new AbortController();
    this.activeDownloadBatch = { ...next, controller };
    this.appState.downloads.lines = [];
    this.syncDownloadPipelineState();
    const task = this.runPreparedDownloadBatch(next.id, next.batch, controller.signal)
      .catch((error) => {
        this.appState.lastEvent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        if (this.activeDownloadBatch?.id === next.id) this.activeDownloadBatch = null;
        if (this.activeDownloadTask === task) this.activeDownloadTask = null;
        this.syncDownloadPipelineState();
        this.notifyStateChanged();
        this.pumpDownloadPipeline();
      });
    this.activeDownloadTask = task;
  }

  private removePendingDownloadBatch(batchId: number): void {
    const index = this.pendingDownloadBatches.findIndex((candidate) => candidate.id === batchId);
    if (index < 0) {
      this.appState.lastEvent = "pending Download Batch not found";
      return;
    }
    this.pendingDownloadBatches.splice(index, 1);
    this.syncDownloadPipelineState();
    this.recordOperationFeedback("success", "removed pending Download Batch");
  }

  private acknowledgeAcceptedSubmission(submissionId: number): void {
    if (this.appState.downloads.acceptedSubmission?.id === submissionId) {
      delete this.appState.downloads.acceptedSubmission;
    }
  }

  private hasDownloadWork(): boolean {
    return Boolean(
      this.appState.downloads.preparingSubmissions
      || this.activeDownloadBatch
      || this.pendingDownloadBatches.length
      || this.pendingPlaylistConfirmation,
    );
  }

  private async confirmQuitWithDownloads(): Promise<void> {
    this.pendingDownloadBatches.length = 0;
    this.pendingPlaylistConfirmation?.prepared.cancel();
    this.pendingPlaylistConfirmation?.settle();
    this.pendingPlaylistConfirmation = null;
    this.activeDownloadPreparation?.abort();
    delete this.appState.downloads.confirmation;
    this.appState.downloads.quitConfirmationRequired = false;
    this.activeDownloadBatch?.controller.abort();
    this.syncDownloadPipelineState();
    await this.teardown();
  }

  private cancelQuitWithDownloads(): void {
    this.appState.downloads.quitConfirmationRequired = false;
    this.recordOperationFeedback("warning", "quit cancelled; Download Pipeline continues");
  }

  private recordOperationFeedback(level: "success" | "warning" | "error", message: string): void {
    this.appState.lastEvent = message;
    this.appState.operationFeedback = { level, message, revision: ++this.feedbackRevision };
  }

  private syncDownloadPipelineState(): void {
    const active = this.activeDownloadBatch;
    this.appState.downloads.active = Boolean(active);
    if (active) {
      this.appState.downloads.activeBatch = {
        id: active.id,
        sourceUrl: active.batch.sourceUrl,
        kind: active.batch.kind,
        itemCount: active.batch.entries.length,
      };
    } else {
      delete this.appState.downloads.activeBatch;
    }
    this.appState.downloads.pendingBatches = this.pendingDownloadBatches.map(({ id, batch }) => ({
      id,
      sourceUrl: batch.sourceUrl,
      kind: batch.kind,
      itemCount: batch.entries.length,
    }));
    const pipelineCount = this.appState.downloads.pendingBatches.length
      + this.appState.downloads.summaries.length
      + (this.appState.downloads.activeBatch ? 1 : 0);
    this.uiStateStore.dispatch({
      type: "setDownloaderBatchSelection",
      index: this.uiState.downloader.selectedBatchIndex,
      resultCount: pipelineCount,
    });
  }

  private recordActiveDownloadTrack(entryIndex: number, entry: DownloadBatchEntry): void {
    if (!this.appState.downloads.activeBatch) return;
    this.appState.downloads.activeBatch.activeTrack = entry.kind === "track"
      ? { index: entryIndex, title: entry.metadata.title, stableId: entry.metadata.id }
      : { index: entryIndex, ...(entry.title ? { title: entry.title } : {}) };
    this.notifyStateChanged();
  }

  private recordYouTubeDownloadProgress(_entryIndex: number, line: string): void {
    const lines = [...this.appState.downloads.lines, line].slice(-4);
    this.appState.downloads.lines = lines;
    const percent = line.match(/(?:^|\s)(\d+(?:\.\d+)?)%/)?.[1];
    if (percent && this.appState.downloads.activeBatch) {
      this.appState.downloads.activeBatch.progressPercent = Math.max(0, Math.min(100, Number(percent)));
    }
    this.notifyStateChanged();
  }

  private markSelectedYouTubeCacheAvailability(entry: QueueEntry): void {
    const provider = this.appState.providers[YOUTUBE_CACHE_PROVIDER_ID];
    if (!isYouTubeCacheProvider(provider)) return;
    if (entry.track.identity.providerId !== YOUTUBE_CACHE_PROVIDER_ID) return;

    const cacheEntry = provider.findByIdentity(entry.track.identity);
    if (!cacheEntry) {
      this.queue.markAvailability(entry.track.identity, {
        status: "unavailable",
        reason: `YouTube Cache entry is missing: ${entry.track.identity.stableId}`,
      });
      return;
    }
    this.queue.markAvailability(entry.track.identity, cacheEntry.availability);
  }

  private async togglePlayPause(): Promise<void> {
    if (this.blockPlaybackActionIfUnavailable()) return;

    const current = this.currentQueueEntry();
    if (!current) {
      this.appState.lastEvent = "nothing is playing";
      return;
    }
    if (current.availability.status === "unavailable") {
      this.markUnavailable(current, current.availability.reason);
      return;
    }

    const livePause = this.appState.playback.status === "paused"
      && this.player.playback.status === "paused";
    if (!livePause && this.appState.playback.status !== "playing") {
      const resumePosition = this.appState.playback.status === "stopped"
        ? 0
        : this.appState.playback.positionSeconds;
      this.queue.startAt(this.queue.entries.indexOf(current));
      const startSeconds = typeof resumePosition === "number" && resumePosition > 0 ? resumePosition : 0;
      const started = await this.playQueueEntry(current, startSeconds);
      if (started && startSeconds > 0) this.appState.lastEvent = `resumed ${current.track.title}`;
      return;
    }

    const pause = this.appState.playback.status === "playing";
    const ok = await this.runPlayerCommand(() => this.player.setPaused(pause));
    if (!ok) return;
    this.appState.lastEvent = this.appState.playback.status === "paused" ? "paused" : "resumed";
  }

  private currentQueueEntry(): QueueEntry | undefined {
    const identity = this.appState.playback.currentTrackIdentity;
    return identity
      ? this.queue.entries.find((entry) => sameIdentity(entry.track.identity, identity))
      : undefined;
  }

  private async stopAndRetainCurrentTrack(event: string): Promise<boolean> {
    const identity = this.appState.playback.currentTrackIdentity;
    const stopped = await this.runPlayerCommand(() => this.player.stop());
    if (!stopped) return false;
    this.appState.playback = {
      ...this.appState.playback,
      status: "stopped",
      positionSeconds: 0,
      currentTrackIdentity: identity,
    };
    this.appState.lastEvent = event;
    return true;
  }

  private async restoreAndStopCurrentTrack(identity: Track["identity"] | null): Promise<void> {
    if (!identity) return;
    const index = this.queue.entries.findIndex((entry) => sameIdentity(entry.track.identity, identity));
    if (index >= 0) this.queue.startAt(index);
    this.appState.playback.currentTrackIdentity = identity;
    await this.stopAndRetainCurrentTrack("end of Queue");
  }

  private markUnavailable(entry: QueueEntry, reason: string): void {
    this.queue.markAvailability(entry.track.identity, { status: "unavailable", reason });
    this.appState.playback = {
      status: "error",
      currentTrackIdentity: entry.track.identity,
      message: reason,
    };
    this.appState.appErrors.push(reason);
    this.appState.lastEvent = reason;
    this.syncQueueState();
  }

  private recordCurrentTrackPlaybackFailure(message = "mpv playback failed"): void {
    const current = this.currentQueueEntry();
    if (!current) return;
    this.queue.markAvailability(current.track.identity, { status: "unavailable", reason: message });
    this.appState.appErrors.push(message);
    this.appState.lastEvent = message;
    this.syncQueueState();
  }

  private recordPlayerLoadCommandFailure(message: string): void {
    this.appState.playback = {
      ...this.appState.playback,
      status: "error",
      message,
    };
    this.appState.appErrors.push(message);
    this.appState.lastEvent = message;
    this.syncQueueState();
  }

  private blockPlaybackActionIfUnavailable(): boolean {
    const playbackMessage = playbackHealthMessage(this.appState.dependencyHealth);
    if (!playbackMessage) return false;

    this.appState.playback = {
      ...this.appState.playback,
      status: "error",
      currentTrackIdentity: this.appState.playback.currentTrackIdentity,
      message: playbackMessage,
    };
    this.appState.lastEvent = playbackMessage;
    return true;
  }

  private async refreshHelperDependency(helper: HelperName): Promise<void> {
    if (this.checkedHelpers.has(helper)) return;
    this.appState.dependencyHealth = await this.refreshDependencyHealth(helper, this.appState.dependencyHealth);
    if (this.appState.dependencyHealth.helpers[helper].status === "present") {
      this.checkedHelpers.add(helper);
    }
  }


  private async runPlayerCommand(
    command: () => Promise<PlayerPlaybackState>,
    fallbackEvent?: string,
    options: { clearCurrentTrack?: boolean } = {},
  ): Promise<boolean> {
    try {
      const playback = await command();
      this.mergePlayerPlayback(playback, options);
      if (fallbackEvent) this.appState.lastEvent = fallbackEvent;
      return true;
    } catch (error) {
      this.mergePlayerPlayback(this.player.playback);
      const message = error instanceof Error ? error.message : String(error);
      this.appState.lastEvent = message;
      return false;
    }
  }

  private mergePlayerPlayback(
    playback: PlayerPlaybackState,
    options: { clearCurrentTrack?: boolean } = {},
  ): void {
    this.appState.playback = {
      ...playback,
      currentTrackIdentity: options.clearCurrentTrack ? null : this.appState.playback.currentTrackIdentity,
    };
  }

  private syncQueueState(): void {
    this.appState.queue = this.queue.snapshot();
  }

  private selectQueueIndex(index: number): void {
    const selectedQueueIndex = clampIndex(index, this.queue.entries.length);
    this.uiStateStore.dispatch({
      type: "syncQueue",
      identities: this.queueIdentities(),
      preferredIdentity: this.queue.entries[selectedQueueIndex]?.track.identity ?? null,
    });
  }

  private queueIdentities() {
    return this.queue.entries.map((entry) => entry.track.identity);
  }

  private notifyStateChanged(reason: AppStateChangeReason = "state"): void {
    for (const listener of this.stateListeners) listener(reason);
  }
}
