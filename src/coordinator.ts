import {
  clampIndex,
  identityKey,
  navigationTargetIndex,
  sameIdentity,
  uniqueTracksByIdentity,
  type AppIntent,
  type AppState,
  type LastQueueSnapshot,
  type Player,
  type PlayerPlaybackState,
  type Provider,
  type Queue,
  type QueueEntry,
  type NavigationTargetId,
  type Track,
  type PlayableTarget,
  type GlobalSearchFilter,
  type GlobalSearchResultType,
  type GlobalSearchProviderResult,
  type GlobalSearchProviderId,
  isProviderId,
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
import { isNavidromeProvider } from "./navidrome";
import {
  OFFLINE_YOUTUBE_CACHE_PROVIDER_ID,
  isOfflineYouTubeCacheProvider,
  type OfflineYouTubeCacheEntry,
} from "./offline-youtube-cache";
import { isLocalProvider } from "./providers";
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
  createFfprobeYouTubeMediaValidator,
  downloadYouTubeUrl,
  identifyYouTubeUrl,
  type YouTubeDownloader,
} from "./youtube-url-download";
import { UiStateStore, type UiStateAction } from "./ui-state";
import { isNavigableGlobalSearchResult } from "./global-search";

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
  youtubeDownloader?: YouTubeDownloader;
  now?: () => number;
};

export class AppCoordinator {
  readonly appState: AppState;
  private readonly uiStateStore: UiStateStore;
  private readonly queue: Queue;
  private readonly player: Player;
  private readonly refreshDependencyHealth: DependencyHealthRefresh;
  private readonly snapshotPersistence: LastQueueSnapshotPersistence;
  private readonly appPreferencesPersistence: AppPreferencesPersistence;
  private readonly dependencyRunner: DependencyCommandRunner;
  private readonly youtubeDownloader: YouTubeDownloader;
  private readonly unsubscribeFromPlayer: () => void;
  private readonly unsubscribeFromProviders: Array<() => void>;
  private readonly stateListeners = new Set<(reason: AppStateChangeReason) => void>();
  private activeLocalOpen: AbortController | null = null;
  private activeYouTubeDownload: AbortController | null = null;
  private activeYouTubeDownloadTask: Promise<void> | null = null;
  private activeGlobalSearch: AbortController | null = null;
  private readonly globalSearchAttempts = new Map<GlobalSearchProviderId, number>();
  private reportingSessionKey: string | null = null;
  private completedPlayReported = false;
  private naturalAdvanceInFlight = false;
  private tornDown = false;
  private readonly now: () => number;
  private lastSnapshotCheckpointAt = Number.NEGATIVE_INFINITY;
  private snapshotSaveBlockedUntilMeaningfulChange = false;
  private snapshotWriteTail: Promise<void> = Promise.resolve();

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
    this.youtubeDownloader = options.youtubeDownloader ?? downloadYouTubeUrl;
    this.now = options.now ?? Date.now;
    this.unsubscribeFromPlayer = this.player.onPlaybackStateChange((playback) => {
      const reachedNaturalEnd = playback.status === "idle" && playback.eof === true;
      this.mergePlayerPlayback(playback);
      this.maybeReportCompletedPlay(playback);
      this.notifyStateChanged("playback");
      this.maybeCheckpointLastQueueSnapshot(playback);
      if (reachedNaturalEnd) void this.advanceAfterNaturalEnd();
    });
    this.unsubscribeFromProviders = Object.values(this.appState.providers)
      .filter(isLocalProvider)
      .map((provider) => provider.onTrackMetadataChange((track) => {
        if (!this.queue.updateTrack(track)) return;

        this.syncQueueState();
        this.appState.lastEvent = `updated metadata for ${track.title}`;
        this.notifyStateChanged();
        void this.saveLastQueueSnapshot({ meaningful: true });
      }));
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
          await this.playNextTarget(intent.target, intent.signal);
          return;
        case "playNow":
          await this.playNowTarget(intent.target, intent.signal);
          return;
        case "removeQueueTrack":
          await this.removeQueueTrack(intent.identity);
          return;
        case "moveQueueTrack":
          this.moveQueueTrack(intent.identity, intent.delta);
          return;
        case "providerOperation":
          if (intent.operation === "refresh") await this.refreshProvider(intent.providerId);
          else if (intent.operation === "retry") await this.retryProvider(intent.providerId);
          else if (intent.operation === "open-path") await this.openProviderPath(intent.providerId, intent.path, intent.signal);
          else if (intent.operation === "open-entry") await this.openProviderBrowserEntry(intent.providerId, intent.location, intent.index);
          else this.cancelLocalOpen();
          return;
        case "globalSearch":
          if (intent.operation === "submit") {
            await this.submitGlobalSearch(intent.query, intent.providerFilter, intent.resultTypeFilter);
          } else if (intent.operation === "retry") {
            await this.retryGlobalSearchProvider(intent.providerId);
          } else if (intent.operation === "open") {
            await this.openGlobalSearchResult(intent.result);
          } else {
            this.clearGlobalSearch();
          }
          return;
        case "downloadOperation":
          if (intent.operation === "start") this.startYouTubeUrlDownload(intent.url);
          else this.cancelYouTubeDownload();
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
    this.activeLocalOpen?.abort();
    this.activeLocalOpen = null;
    this.activeYouTubeDownload?.abort();
    this.activeYouTubeDownload = null;
    this.unsubscribeFromPlayer();
    for (const unsubscribe of this.unsubscribeFromProviders) unsubscribe();
    const cleanupFailures: string[] = [];
    if (this.activeYouTubeDownloadTask) {
      await this.activeYouTubeDownloadTask.catch((error) => {
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

    if (record?.shuffle !== undefined) this.queue.setShuffle(record.shuffle);
    if (record?.repeatAll !== undefined) this.queue.setRepeatAll(record.repeatAll);
    if (record?.volume !== undefined) this.appState.volume = { ...record.volume };

    this.syncQueueState();
  }

  private async persistPlaybackPreferences(): Promise<void> {
    const queue = this.queue.snapshot();
    await this.persistAppPreferences({
      shuffle: queue.shuffle,
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
    this.queue.restore(snapshot);
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
      }
      : { status: "idle", currentTrackIdentity: null };
    this.selectQueueIndex(current ? this.queue.currentIndex : 0);
    this.syncQueueState();
  }

  private async playNextTarget(target: PlayableTarget, signal?: AbortSignal): Promise<void> {
    const tracks = await this.resolvePlayableTarget(target, signal);
    if (!tracks) return;
    const block = this.queue.playNext(tracks);
    for (const entry of block) {
      if (entry.availability.status === "unknown") this.markSelectedOfflineYouTubeCacheAvailability(entry);
    }
    this.appState.lastEvent = `accepted Play Next for ${block.length} Track${block.length === 1 ? "" : "s"}`;
    this.syncQueueState();
  }

  private async playNowTarget(target: PlayableTarget, signal?: AbortSignal): Promise<void> {
    const tracks = await this.resolvePlayableTarget(target, signal);
    if (!tracks) return;
    if (tracks.length === 0) {
      this.appState.lastEvent = "Music Collection has no Tracks";
      return;
    }
    const entry = this.queue.playNow(tracks);
    for (const track of tracks) {
      const queuedEntry = this.queue.entries.find((candidate) => sameIdentity(candidate.track.identity, track.identity));
      if (queuedEntry?.availability.status === "unknown") {
        this.markSelectedOfflineYouTubeCacheAvailability(queuedEntry);
      }
    }
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

  private async resolvePlayableTarget(target: PlayableTarget, signal?: AbortSignal): Promise<readonly Track[] | null> {
    if ("identity" in target) return [target];
    if (target.tracks !== undefined) return uniqueTracksByIdentity(target.tracks);
    this.uiStateStore.dispatch({ type: "setOverlayMessage", message: undefined });
    if (signal?.aborted) {
      this.appState.lastEvent = "Music Collection resolution cancelled";
      this.setPickerRecovery("Music Collection resolution cancelled · Press Enter to retry or Esc to dismiss");
      return null;
    }

    const providerId = target.resolve?.providerId;
    const provider = providerId ? this.appState.providers[providerId] : undefined;
    if (!provider?.resolveMusicCollection) {
      this.appState.lastEvent = "Music Collection must be resolved by its Provider";
      return null;
    }

    try {
      const result = await provider.resolveMusicCollection(target, { signal });
      if (result.status === "cancelled" || signal?.aborted) {
        this.appState.lastEvent = "Music Collection resolution cancelled";
        this.setPickerRecovery("Music Collection resolution cancelled · Press Enter to retry or Esc to dismiss");
        return null;
      }
      return uniqueTracksByIdentity(result.tracks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appState.lastEvent = `Music Collection resolution failed: ${message}`;
      this.setPickerRecovery(`Could not load Music Collection: ${message} · Press Enter to retry or Esc to dismiss`);
      return null;
    }
  }

  private setPickerRecovery(message: string): void {
    if (this.uiStateStore.snapshot.overlays.at(-1)?.kind === "music-picker") {
      this.uiStateStore.dispatch({ type: "setOverlayMessage", message });
    }
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

  private async refreshProvider(providerId: string): Promise<void> {
    if (providerId !== "navidrome") {
      this.appState.lastEvent = `${providerId} Provider does not support refresh`;
      return;
    }
    await this.refreshNavidromeLibraryData();
  }

  private async retryProvider(providerId: string): Promise<void> {
    const provider = this.appState.providers[providerId];
    if (providerId !== "navidrome" || !isNavidromeProvider(provider)) {
      this.appState.lastEvent = `${providerId} Provider does not support retry`;
      return;
    }
    const state = await provider.validateConnection();
    this.appState.lastEvent = state.status === "connected"
      ? "Navidrome connection restored"
      : `Navidrome retry failed: ${state.message}`;
  }

  private async openProviderPath(providerId: string, path: string, signal?: AbortSignal): Promise<void> {
    if (providerId !== "local") {
      this.appState.lastEvent = `${providerId} Provider cannot open paths`;
      return;
    }
    await this.openLocalPathTracks(path, signal);
  }

  private async openProviderBrowserEntry(
    providerId: string,
    location: import("./domain").ProviderLocation,
    index: number,
  ): Promise<void> {
    const provider = this.appState.providers[providerId];
    if (!provider?.openBrowserEntry) {
      this.appState.lastEvent = `${providerId} Provider row cannot be opened`;
      return;
    }
    try {
      const nextLocation = await provider.openBrowserEntry(location, index);
      if (nextLocation) this.uiStateStore.dispatch({ type: "setProviderLocation", location: nextLocation });
      this.appState.lastEvent = nextLocation ? `opened ${providerId} Provider row` : `${providerId} Provider row cannot be opened`;
    } catch (error) {
      this.appState.lastEvent = `Could not open ${providerId} Provider row: ${error instanceof Error ? error.message : String(error)} · Retry`;
    }
  }

  private async submitGlobalSearch(
    query: string,
    providerFilter: GlobalSearchFilter<GlobalSearchProviderId>,
    resultTypeFilter: GlobalSearchFilter<GlobalSearchResultType>,
  ): Promise<void> {
    const trimmed = query.trim();
    if (!trimmed) {
      this.clearGlobalSearch();
      return;
    }
    this.activeGlobalSearch?.abort();
    const controller = new AbortController();
    this.activeGlobalSearch = controller;
    const requestId = this.appState.globalSearch.requestId + 1;
    const providers = this.searchProviders(providerFilter);
    this.appState.globalSearch = {
      requestId, query: trimmed, providerFilter, resultTypeFilter,
      providers: Object.fromEntries(providers.map((provider) => [provider.id, {
        providerLabel: provider.label, status: "loading" as const, results: [],
      }])),
    };
    this.appState.lastEvent = `searching for ${trimmed}`;
    this.notifyStateChanged();
    this.globalSearchAttempts.clear();
    await Promise.all(providers.map((provider) => {
      this.globalSearchAttempts.set(provider.id, 1);
      return this.searchProvider(provider, requestId, 1, controller.signal, resultTypeFilter);
    }));
    if (this.activeGlobalSearch === controller) this.activeGlobalSearch = null;
  }

  private async retryGlobalSearchProvider(providerId: GlobalSearchProviderId): Promise<void> {
    const search = this.appState.globalSearch;
    const provider = this.appState.providers[providerId];
    if (!search.query || !provider?.search || !isGlobalSearchProvider(provider)) return;
    const controller = new AbortController();
    const requestId = search.requestId;
    this.appState.globalSearch = {
      ...search,
      providers: { ...search.providers, [providerId]: { providerLabel: provider.label, status: "loading", results: [] } },
    };
    this.notifyStateChanged();
    const attemptId = (this.globalSearchAttempts.get(providerId) ?? 0) + 1;
    this.globalSearchAttempts.set(providerId, attemptId);
    await this.searchProvider(provider, requestId, attemptId, controller.signal, search.resultTypeFilter);
  }

  private clearGlobalSearch(): void {
    this.activeGlobalSearch?.abort();
    this.activeGlobalSearch = null;
    this.globalSearchAttempts.clear();
    this.appState.globalSearch = {
      requestId: this.appState.globalSearch.requestId + 1,
      query: "", providerFilter: "all", resultTypeFilter: "all", providers: {},
    };
    this.notifyStateChanged();
  }

  private async openGlobalSearchResult(result: GlobalSearchProviderResult): Promise<void> {
    const provider = this.appState.providers[result.providerId];
    if (!isNavigableGlobalSearchResult(result) || !isNavidromeProvider(provider)) {
      this.appState.lastEvent = "Global Search result cannot be opened";
      return;
    }
    try {
      const location = await provider.openSearchResult(result);
      this.clearGlobalSearch();
      this.uiStateStore.dispatch({ type: "setQuery", query: "" });
      this.uiStateStore.dispatch({ type: "setProviderLocation", location });
      this.appState.lastEvent = `opened Navidrome ${result.type} ${result.label}`;
    } catch (error) {
      this.appState.lastEvent = `Could not open Artist Albums: ${error instanceof Error ? error.message : String(error)} · Retry`;
    }
  }

  private searchProviders(providerFilter: GlobalSearchFilter<GlobalSearchProviderId>): GlobalSearchProvider[] {
    return Object.values(this.appState.providers).filter((provider): provider is GlobalSearchProvider => {
      if (!isGlobalSearchProvider(provider)) return false;
      if (!provider.search || provider.capabilities.searchableResultTypes.length === 0) return false;
      if (providerFilter !== "all" && provider.id !== providerFilter) return false;
      if (!provider.getNavigationRoot().visible) return false;
      if (provider.id === "local" && !this.appState.config.providers.local.enabled) return false;
      if (provider.id === OFFLINE_YOUTUBE_CACHE_PROVIDER_ID && !this.appState.config.providers.offlineYouTubeCache.enabled) return false;
      return true;
    });
  }

  private async searchProvider(
    provider: GlobalSearchProvider,
    requestId: number,
    attemptId: number,
    signal: AbortSignal,
    resultTypeFilter: GlobalSearchFilter<GlobalSearchResultType>,
  ): Promise<void> {
    const resultTypes = resultTypeFilter === "all"
      ? provider.capabilities.searchableResultTypes
      : provider.capabilities.searchableResultTypes.filter((type) => type === resultTypeFilter);
    try {
      const results = resultTypes.length === 0 ? [] : await provider.search!({
        query: this.appState.globalSearch.query, resultTypes, limit: 50, signal,
      });
      if (signal.aborted || this.appState.globalSearch.requestId !== requestId
        || this.globalSearchAttempts.get(provider.id) !== attemptId) return;
      this.appState.globalSearch.providers[provider.id] = {
        providerLabel: provider.label,
        status: results.length === 0 ? "empty" : "success",
        results: resultTypes.flatMap((type) => results.filter((result) => result.type === type).slice(0, 50)),
      };
    } catch (error) {
      if (signal.aborted || this.appState.globalSearch.requestId !== requestId
        || this.globalSearchAttempts.get(provider.id) !== attemptId) return;
      const message = error instanceof Error ? error.message : String(error);
      const kind = typeof error === "object" && error !== null && "kind" in error ? String(error.kind) : "failure";
      this.appState.globalSearch.providers[provider.id] = {
        providerLabel: provider.label,
        status: kind === "auth" ? "auth" : kind === "api" ? "offline" : "failure",
        results: [], message,
      };
    }
    this.appState.lastEvent = `Global Search updated: ${provider.label}`;
    this.notifyStateChanged();
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
      case "toggle-shuffle": await this.toggleShuffle(); return;
      case "toggle-repeat-all": await this.toggleRepeatAll(); return;
      case "seek": await this.seekBy(intent.seconds); return;
      case "adjust-volume":
        await this.setVolume((this.appState.volume.ready ? this.appState.volume.percent : 100) + intent.delta, true);
        return;
      case "set-volume": await this.setVolume(intent.percent, intent.ready); return;
      case "quit":
        this.appState.lastEvent = "quit requested";
        await this.teardown();
        return;
    }
  }

  private startLocalOpen(path: string): void {
    this.activeLocalOpen?.abort();
    const controller = new AbortController();
    this.activeLocalOpen = controller;
    this.appState.lastEvent = `opening Local path ${path}`;

    void this.openLocalPath(path, controller.signal)
      .catch((error) => {
        if (this.tornDown) return;
        this.appState.lastEvent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        if (this.activeLocalOpen === controller) this.activeLocalOpen = null;
        this.notifyStateChanged();
      });
  }

  private cancelLocalOpen(): void {
    if (!this.activeLocalOpen) {
      this.appState.lastEvent = "no active Local open";
      return;
    }

    this.activeLocalOpen.abort();
    this.appState.lastEvent = "cancelling Local open";
  }

  private startYouTubeUrlDownload(url: string): void {
    if (this.activeYouTubeDownload) {
      this.appState.lastEvent = "YouTube download already in progress";
      return;
    }

    const controller = new AbortController();
    this.activeYouTubeDownload = controller;
    this.appState.downloads = {
      active: true,
      lines: [],
    };
    this.appState.lastEvent = "starting YouTube URL Download";

    const task = this.submitYouTubeUrl(url, controller.signal)
      .catch((error) => {
        this.appState.lastEvent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        if (this.activeYouTubeDownload === controller) this.activeYouTubeDownload = null;
        if (this.activeYouTubeDownloadTask === task) this.activeYouTubeDownloadTask = null;
        this.notifyStateChanged();
      });
    this.activeYouTubeDownloadTask = task;
  }

  private cancelYouTubeDownload(): void {
    if (!this.activeYouTubeDownload) {
      this.appState.lastEvent = "no active YouTube download";
      return;
    }

    this.activeYouTubeDownload.abort();
    this.appState.lastEvent = "cancelling YouTube download and cleaning up partial files";
  }

  private async openLocalPath(path: string, signal?: AbortSignal): Promise<void> {
    const localProvider = this.appState.providers.local;
    if (!isLocalProvider(localProvider)) {
      this.appState.lastEvent = "Local Provider cannot open paths";
      return;
    }

    this.updateUiState({
      activeTargetId: "local",
      selectedTargetIndex: navigationTargetIndex("local"),
      focusedPane: "content",
      providerLocation: { providerId: "local", path: [{ kind: "local-directory", path }] },
    });
    const selectedEntry = await this.openLocalPathTracks(path, signal);
    if (selectedEntry) this.selectQueueIndex(Math.max(0, this.queue.entries.indexOf(selectedEntry)));
  }

  private async openLocalPathTracks(path: string, signal?: AbortSignal): Promise<QueueEntry | undefined> {
    const localProvider = this.appState.providers.local;
    if (!isLocalProvider(localProvider)) {
      this.appState.lastEvent = "Local Provider cannot open paths";
      return undefined;
    }

    const result = await localProvider.createTracksFromOpenPath(path, {
      signal,
      softCap: this.appState.config.providers.local.directorySoftCap,
    });
    let selectedEntry: QueueEntry | undefined;
    for (const track of result.tracks) {
      selectedEntry = this.queue.enqueue(track);
    }

    this.syncQueueState();
    if (result.cancelled) {
      this.appState.lastEvent = `cancelled Local open after ${result.tracks.length} Tracks`;
      return selectedEntry;
    }

    if (result.capped) {
      this.appState.lastEvent = `added ${result.tracks.length} Local Tracks to shared Queue; soft cap reached`;
      return selectedEntry;
    }

    if (result.tracks.length === 0) {
      this.appState.lastEvent = "no Local audio files found";
      return selectedEntry;
    }

    this.appState.lastEvent = `added ${result.tracks.length} Local Tracks to shared Queue`;
    return selectedEntry;
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
    this.appState.lastEvent = "cleared Queue";
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

  private async advanceAfterNaturalEnd(): Promise<void> {
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

  private async toggleShuffle(): Promise<void> {
    this.queue.setShuffle(!this.queue.snapshot().shuffle);
    this.appState.lastEvent = this.queue.snapshot().shuffle ? "shuffle on" : "shuffle off";
    this.syncQueueState();
    await this.persistPlaybackPreferences();
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
    await this.refreshRestoredLocalAvailability();
    this.refreshRestoredOfflineYouTubeCacheAvailability();
  }

  private refreshRestoredOfflineYouTubeCacheAvailability(): void {
    const provider = this.appState.providers[OFFLINE_YOUTUBE_CACHE_PROVIDER_ID];
    if (!isOfflineYouTubeCacheProvider(provider)) return;

    provider.refresh();
    for (const entry of this.queue.entries) {
      if (entry.track.identity.providerId !== OFFLINE_YOUTUBE_CACHE_PROVIDER_ID) continue;

      const cacheEntry = provider.findByIdentity(entry.track.identity);
      if (!cacheEntry) {
        this.queue.markAvailability(entry.track.identity, {
          status: "unavailable",
          reason: `Offline YouTube Cache entry is missing: ${entry.track.identity.stableId}`,
        });
        continue;
      }

      this.queue.updateTrack(cacheEntry.track);
      this.queue.markAvailability(entry.track.identity, cacheEntry.availability);
    }
  }

  private async playQueueEntry(entry: QueueEntry): Promise<boolean> {
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
      await this.player.load(locator);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markUnavailable(entry, message);
      return false;
    }

    this.queue.markAvailability(entry.track.identity, { status: "available" });
    this.appState.playback = {
      ...this.player.playback,
      status: "playing",
      currentTrackIdentity: entry.track.identity,
    };
    this.reportingSessionKey = identityKey(entry.track.identity);
    this.completedPlayReported = false;
    this.appState.lastEvent = `started ${entry.track.title}`;
    this.syncQueueState();
    this.reportNowPlaying(entry.track);
    return true;
  }

  private async refreshRestoredLocalAvailability(): Promise<void> {
    for (const entry of this.queue.entries) {
      if (entry.track.identity.providerId !== "local") continue;

      const provider = this.appState.providers[entry.track.identity.providerId];
      if (!provider) {
        this.queue.markAvailability(entry.track.identity, {
          status: "unavailable",
          reason: "Provider local is unavailable",
        });
        continue;
      }

      try {
        await provider.resolvePlaybackLocator(entry.track.identity);
        this.queue.markAvailability(entry.track.identity, { status: "available" });
      } catch (error) {
        this.queue.markAvailability(entry.track.identity, {
          status: "unavailable",
          reason: error instanceof Error ? error.message : "Playback Locator could not be resolved",
        });
      }
    }
  }

  private async submitYouTubeUrl(url: string, signal: AbortSignal): Promise<void> {
    await this.refreshHelperDependency("yt-dlp");
    const healthMessage = youtubeDownloadHealthMessage(this.appState.dependencyHealth);
    if (healthMessage) {
      this.appState.lastEvent = healthMessage;
      this.finishYouTubeDownload({ clearLines: true });
      return;
    }

    const identified = await identifyYouTubeUrl(url, {
      command: this.appState.config.helpers.ytDlp,
      timeoutMs: this.appState.config.dependencyPolicy.checkTimeoutMs,
      cookiesFromBrowser: this.appState.config.youtube.cookiesFromBrowser,
      signal,
      runner: this.dependencyRunner,
    });
    if (!identified.ok) {
      this.appState.lastEvent = identified.message;
      this.finishYouTubeDownload({ clearLines: true });
      return;
    }

    const provider = this.appState.providers[OFFLINE_YOUTUBE_CACHE_PROVIDER_ID];
    if (!isOfflineYouTubeCacheProvider(provider)) {
      this.appState.lastEvent = "Offline YouTube Cache Provider is unavailable";
      this.finishYouTubeDownload({ clearLines: true });
      return;
    }

    provider.refresh();
    const cacheEntry = provider.findByIdentity(identified.identity);
    if (cacheEntry?.availability.status === "available") {
      this.enqueueOfflineYouTubeCacheEntry(cacheEntry);
      this.finishYouTubeDownload({ clearLines: true });
      return;
    }

    const download = await this.youtubeDownloader({
      url,
      command: this.appState.config.helpers.ytDlp,
      cache: this.appState.config.offlineYouTubeCache,
      metadata: identified.metadata,
      cookiesFromBrowser: this.appState.config.youtube.cookiesFromBrowser,
      progressThrottleMs: this.appState.config.lowPower.downloadProgressThrottleMs,
      signal,
      validateMedia: createFfprobeYouTubeMediaValidator({
        command: this.appState.config.helpers.ffprobe,
        timeoutMs: this.appState.config.dependencyPolicy.checkTimeoutMs,
        runner: this.dependencyRunner,
      }),
      onProgress: (line) => this.recordYouTubeDownloadProgress(line),
    });

    if (!download.ok) {
      this.finishYouTubeDownload({ clearLines: Boolean(download.cancelled) });
      this.appState.lastEvent = download.message;
      return;
    }
    if (signal.aborted) {
      this.finishYouTubeDownload({ clearLines: true });
      this.appState.lastEvent = "YouTube download cancelled";
      return;
    }

    provider.refresh();
    const downloadedEntry = provider.findByIdentity(identified.identity);
    if (!downloadedEntry) {
      this.finishYouTubeDownload({ clearLines: false });
      this.appState.lastEvent = `Offline YouTube Cache entry is missing after download: ${identified.identity.stableId}`;
      return;
    }
    if (downloadedEntry.availability.status !== "available") {
      this.finishYouTubeDownload({ clearLines: false });
      this.appState.lastEvent = downloadedEntry.availability.status === "unavailable"
        ? `Offline YouTube Cache entry is incomplete: ${downloadedEntry.availability.reason}`
        : "Offline YouTube Cache entry is incomplete";
      return;
    }

    this.enqueueOfflineYouTubeCacheEntry(downloadedEntry);
    this.finishYouTubeDownload({ clearLines: false });
  }

  private enqueueOfflineYouTubeCacheEntry(cacheEntry: OfflineYouTubeCacheEntry): void {
    const entry = this.queue.enqueue(cacheEntry.track);
    this.queue.markAvailability(cacheEntry.track.identity, cacheEntry.availability);
    this.appState.lastEvent = `added ${cacheEntry.track.title} to shared Queue`;
    this.syncQueueState();
    void this.saveLastQueueSnapshot({ meaningful: true });
  }

  private recordYouTubeDownloadProgress(line: string): void {
    const lines = [...this.appState.downloads.lines, line].slice(-4);
    this.appState.downloads = {
      active: true,
      lines,
    };
    this.notifyStateChanged();
  }

  private finishYouTubeDownload(options: { clearLines: boolean }): void {
    this.appState.downloads = {
      active: false,
      lines: options.clearLines ? [] : this.appState.downloads.lines,
    };
  }

  private markSelectedOfflineYouTubeCacheAvailability(entry: QueueEntry): void {
    const provider = this.appState.providers[OFFLINE_YOUTUBE_CACHE_PROVIDER_ID];
    if (!isOfflineYouTubeCacheProvider(provider)) return;
    if (entry.track.identity.providerId !== OFFLINE_YOUTUBE_CACHE_PROVIDER_ID) return;

    const cacheEntry = provider.findByIdentity(entry.track.identity);
    if (!cacheEntry) return;
    this.queue.markAvailability(entry.track.identity, cacheEntry.availability);
  }

  private async togglePlayPause(): Promise<void> {
    if (this.blockPlaybackActionIfUnavailable()) return;

    const current = this.currentQueueEntry();
    if (!current) {
      this.appState.lastEvent = "nothing is playing";
      return;
    }

    const livePause = this.appState.playback.status === "paused"
      && this.player.playback.status === "paused";
    if (!livePause && this.appState.playback.status !== "playing") {
      const resumePosition = this.appState.playback.status === "stopped"
        ? 0
        : this.appState.playback.positionSeconds;
      this.queue.startAt(this.queue.entries.indexOf(current));
      const started = await this.playQueueEntry(current);
      if (!started || typeof resumePosition !== "number" || resumePosition <= 0) return;
      const resumed = await this.runPlayerCommand(() => this.player.seekBy(resumePosition));
      if (resumed) this.appState.lastEvent = `resumed ${current.track.title}`;
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
    this.appState.dependencyHealth = await this.refreshDependencyHealth(helper, this.appState.dependencyHealth);
  }

  private async refreshNavidromeLibrary(): Promise<void> {
    if (await this.refreshNavidromeLibraryData()) this.selectContentIndex("navidrome", 0);
  }

  private async refreshNavidromeLibraryData(): Promise<boolean> {
    const provider = this.appState.providers.navidrome;
    if (!isNavidromeProvider(provider)) {
      this.appState.lastEvent = "Navidrome Library Browser is unavailable";
      return false;
    }

    const state = await provider.validateConnection();
    if (state.status !== "connected") {
      this.appState.lastEvent = state.message;
      return false;
    }

    try {
      await provider.refreshLibraryBrowser();
    } catch (error) {
      this.appState.lastEvent = error instanceof Error ? error.message : String(error);
      return false;
    }

    this.appState.lastEvent = "refreshed Navidrome Library Browser";
    return true;
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

  private reportNowPlaying(track: Track): void {
    if (!this.shouldReportNavidromeScrobble(track)) return;

    const provider = this.appState.providers.navidrome;
    if (!isNavidromeProvider(provider)) return;

    void provider.reportNowPlaying(track.identity)
      .catch((error) => this.recordReportingFailure(error));
  }

  private maybeReportCompletedPlay(playback: PlayerPlaybackState): void {
    if (this.completedPlayReported || playback.status !== "playing") return;

    const currentIdentity = this.appState.playback.currentTrackIdentity;
    if (!currentIdentity) return;

    const currentKey = identityKey(currentIdentity);
    if (this.reportingSessionKey !== currentKey) return;

    const entry = this.queue.entries.find((candidate) => sameIdentity(candidate.track.identity, currentIdentity));
    if (!entry || !this.shouldReportNavidromeScrobble(entry.track)) return;

    const positionSeconds = playback.positionSeconds;
    if (typeof positionSeconds !== "number" || !Number.isFinite(positionSeconds)) return;

    const durationSeconds = playback.durationSeconds ?? entry.track.durationSeconds;
    const thresholdSeconds = completedPlayThresholdSeconds(durationSeconds);
    if (positionSeconds < thresholdSeconds) return;

    const provider = this.appState.providers.navidrome;
    if (!isNavidromeProvider(provider)) return;

    this.completedPlayReported = true;
    void provider.reportCompletedPlay(entry.track.identity)
      .catch((error) => this.recordReportingFailure(error));
  }

  private shouldReportNavidromeScrobble(track: Track): boolean {
    return track.identity.providerId === "navidrome"
      && this.appState.config.providers.navidrome.scrobble;
  }

  private recordReportingFailure(error: unknown): void {
    if (this.tornDown) return;

    const message = `Navidrome reporting failed: ${error instanceof Error ? error.message : String(error)}`;
    this.appState.appErrors.push(message);
    this.notifyStateChanged();
  }

  private syncQueueState(): void {
    this.appState.queue = this.queue.snapshot();
  }

  private updateUiState(patch: Partial<UiState>): void {
    this.uiStateStore.dispatch({ type: "updateView", patch });
  }

  private selectContentIndex(targetId: NavigationTargetId, index: number): void {
    this.updateUiState({
      selectedContentIndexByTarget: {
        ...this.uiState.selectedContentIndexByTarget,
        [targetId]: index,
      },
    });
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

type GlobalSearchProvider = Provider & { readonly id: GlobalSearchProviderId };

function isGlobalSearchProvider(provider: Provider): provider is GlobalSearchProvider {
  return isProviderId(provider.id);
}

function completedPlayThresholdSeconds(durationSeconds: number | null | undefined): number {
  return typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.min(240, durationSeconds / 2)
    : 240;
}
