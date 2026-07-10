import {
  NAVIGATION_TARGETS,
  clampIndex,
  identityKey,
  navigationTargetIndex,
  sameIdentity,
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
import { isNavidromeProvider, type NavidromeLibraryBrowserEntry } from "./navidrome";
import {
  OFFLINE_YOUTUBE_CACHE_PROVIDER_ID,
  isOfflineYouTubeCacheProvider,
  type OfflineYouTubeCacheEntry,
} from "./offline-youtube-cache";
import { isLocalProvider } from "./providers";
import {
  InMemoryAppPreferencesPersistence,
  isRestorableProviderTargetId,
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
  private reportingSessionKey: string | null = null;
  private completedPlayReported = false;
  private tornDown = false;

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
    this.unsubscribeFromPlayer = this.player.onPlaybackStateChange((playback) => {
      this.mergePlayerPlayback(playback);
      this.maybeReportCompletedPlay(playback);
      this.notifyStateChanged("playback");
    });
    this.unsubscribeFromProviders = Object.values(this.appState.providers)
      .filter(isLocalProvider)
      .map((provider) => provider.onTrackMetadataChange((track) => {
        if (!this.queue.updateTrack(track)) return;

        this.syncQueueState();
        this.appState.lastEvent = `updated metadata for ${track.title}`;
        this.notifyStateChanged();
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

  async start(cliArgs: readonly string[]): Promise<void> {
    const fileArgs = cliArgs.filter((arg) => arg.trim());

    if (fileArgs.length > 0) {
      await this.restoreAppPreferences({ restoreProvider: false });
      this.appState.startupMode = "cli-seeded";
      this.updateUiState({
        activeTargetId: "queue",
        focusedPane: "queue",
        selectedTargetIndex: navigationTargetIndex("queue"),
        providerLocation: { providerId: null, path: [] },
      });
      this.appState.lastEvent = "CLI args seeded the shared Queue";
    } else {
      await this.restoreQueueSnapshotIfPresent();
      this.appState.startupMode = "empty";
      await this.restoreAppPreferences({ restoreProvider: true });
    }

    for (const arg of fileArgs) {
      await this.seedLocalCliArg(arg);
    }

    this.syncQueueState();
    this.notifyStateChanged();
  }

  async dispatch(intent: AppIntent): Promise<void> {
    try {
      switch (intent.type) {
        case "selectNavigationTarget":
          await this.selectNavigationTarget(intent.targetId);
          return;
        case "moveSelection":
          await this.moveSelection(intent.delta);
          return;
        case "activateSelectedContent":
          await this.activateSelectedContent();
          return;
        case "cycleFocus":
          this.cycleFocus();
          return;
        case "enqueueSelectedTrack":
          await this.enqueueSelectedTrack();
          return;
        case "refreshNavidromeLibrary":
          if (this.uiState.activeTargetId !== "navidrome") return;
          await this.refreshNavidromeLibrary();
          return;
        case "openNavidromeSearchPrompt":
          this.openNavidromeSearchPrompt();
          return;
        case "searchNavidromeTracks":
          await this.searchNavidromeTracks(intent.query);
          return;
        case "openLocalPathPrompt":
          await this.openLocalPathPrompt();
          return;
        case "setPromptInput":
          this.setPromptInput(intent.value);
          return;
        case "submitPrompt":
          await this.submitPrompt();
          return;
        case "cancelPrompt":
          this.cancelPrompt();
          return;
        case "cancelLocalOpen":
          this.cancelLocalOpen();
          return;
        case "cancelYouTubeDownload":
          this.cancelYouTubeDownload();
          return;
        case "openLocalPath":
          await this.openLocalPath(intent.path, intent.signal);
          return;
        case "startSelectedQueueEntry":
          await this.startSelectedQueueEntry();
          return;
        case "removeSelectedQueueEntry":
          this.removeSelectedQueueEntry();
          return;
        case "moveSelectedQueueEntry":
          this.moveSelectedQueueEntry(intent.delta);
          return;
        case "clearQueue":
          this.clearQueue();
          return;
        case "nextTrack":
          await this.nextTrack();
          return;
        case "previousTrack":
          await this.previousTrack();
          return;
        case "toggleShuffle":
          await this.toggleShuffle();
          return;
        case "toggleRepeatAll":
          await this.toggleRepeatAll();
          return;
        case "setVolume":
          await this.setVolume(intent.percent, intent.ready);
          return;
        case "adjustVolume":
          await this.setVolume((this.appState.volume.ready ? this.appState.volume.percent : 100) + intent.delta, true);
          return;
        case "seekBy":
          await this.seekBy(intent.seconds);
          return;
        case "saveLastQueueSnapshot":
          await this.saveLastQueueSnapshot();
          return;
        case "restoreLastQueueSnapshot":
          await this.restoreLastQueueSnapshot();
          return;
        case "togglePlayPause":
          await this.togglePlayPause();
          return;
        case "stop":
          if (this.blockPlaybackActionIfUnavailable()) return;

          await this.runPlayerCommand(
            () => this.player.stop(),
            "stopped",
            { clearCurrentTrack: true },
          );
          return;
        case "quit":
          this.appState.lastEvent = "quit requested";
          await this.teardown();
          return;
      }
    } finally {
      this.notifyStateChanged();
    }
  }

  async teardown(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    this.activeLocalOpen?.abort();
    this.activeLocalOpen = null;
    this.activeYouTubeDownload?.abort();
    this.activeYouTubeDownload = null;
    this.unsubscribeFromPlayer();
    for (const unsubscribe of this.unsubscribeFromProviders) unsubscribe();
    await this.player.teardown();
  }

  onStateChange(listener: (reason: AppStateChangeReason) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private async restoreAppPreferences(options: { restoreProvider: boolean }): Promise<void> {
    const record = await this.appPreferencesPersistence.load();
    this.recordPersistenceRecoveryMessages(this.appPreferencesPersistence);

    if (record?.shuffle !== undefined) this.queue.setShuffle(record.shuffle);
    if (record?.repeatAll !== undefined) this.queue.setRepeatAll(record.repeatAll);
    if (record?.volume !== undefined) this.appState.volume = { ...record.volume };

    if (options.restoreProvider) {
      this.updateUiState({
        activeTargetId: "local",
        selectedTargetIndex: navigationTargetIndex("local"),
        focusedPane: "targets",
        providerLocation: { providerId: "local", path: [] },
      });
      this.appState.lastEvent = "opened Local";

      if (record?.lastSelectedProviderId) {
        const targetId = record.lastSelectedProviderId;
        this.updateUiState({
          activeTargetId: targetId,
          selectedTargetIndex: navigationTargetIndex(targetId),
          focusedPane: "targets",
          providerLocation: { providerId: targetId, path: [] },
        });
        this.appState.lastEvent = `restored last selected ${NAVIGATION_TARGETS[this.uiState.selectedTargetIndex]?.label ?? targetId}`;
      }
    }

    this.syncQueueState();
  }

  private async persistLastSelectedTarget(targetId: NavigationTargetId): Promise<void> {
    if (!isRestorableProviderTargetId(targetId)) return;
    await this.persistAppPreferences({ lastSelectedProviderId: targetId });
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
    this.selectQueueIndex(snapshot.currentIndex >= 0 ? snapshot.currentIndex : 0);
    this.syncQueueState();
  }

  private async selectNavigationTarget(targetId: NavigationTargetId): Promise<void> {
    this.updateUiState({
      activeTargetId: targetId,
      selectedTargetIndex: navigationTargetIndex(targetId),
      focusedPane: targetId === "queue" ? "queue" : "content",
      providerLocation: { providerId: targetId === "queue" ? null : targetId, path: [] },
    });
    await this.persistLastSelectedTarget(targetId);
    await this.refreshEnteredTarget(targetId);
    const activePrompt = targetId === "youtube-url-download" && !youtubeDownloadHealthMessage(this.appState.dependencyHealth)
      ? "youtube-url"
      : null;
    this.updateUiState({ activePrompt, ...(!activePrompt ? { promptInput: "" } : {}) });
    this.appState.lastEvent = `switched to ${NAVIGATION_TARGETS[this.uiState.selectedTargetIndex]?.label ?? targetId}`;
  }

  private async moveSelection(delta: number): Promise<void> {
    if (this.uiState.focusedPane === "targets") {
      const selectedTargetIndex = clampIndex(this.uiState.selectedTargetIndex + delta, NAVIGATION_TARGETS.length);
      const activeTargetId = NAVIGATION_TARGETS[selectedTargetIndex]?.id ?? "local";
      this.updateUiState({
        selectedTargetIndex,
        activeTargetId,
        providerLocation: { providerId: activeTargetId === "queue" ? null : activeTargetId, path: [] },
      });
      await this.persistLastSelectedTarget(this.uiState.activeTargetId);
      await this.refreshEnteredTarget(this.uiState.activeTargetId);
      this.appState.lastEvent = `selected ${NAVIGATION_TARGETS[this.uiState.selectedTargetIndex]?.label ?? "target"}`;
      return;
    }

    if (this.uiState.focusedPane === "queue" || this.uiState.activeTargetId === "queue") {
      this.selectQueueIndex(clampIndex(this.uiState.selectedQueueIndex + delta, this.queue.entries.length));
      this.appState.lastEvent = "moved queue selection";
      return;
    }

    const targetId = this.uiState.activeTargetId;
    const current = this.uiState.selectedContentIndexByTarget[targetId] ?? 0;
    this.selectContentIndex(targetId, clampIndex(current + delta, this.visibleContentLength(targetId)));
    this.appState.lastEvent = "moved Provider Browsing Surface selection";
  }

  private cycleFocus(): void {
    const next = this.uiState.focusedPane === "targets"
      ? "content"
      : this.uiState.focusedPane === "content"
        ? "queue"
        : "targets";
    this.updateUiState({ focusedPane: next });
    this.appState.lastEvent = `focus ${next}`;
  }

  private async enqueueSelectedTrack(): Promise<void> {
    if (this.uiState.activeTargetId === "queue") {
      await this.startSelectedQueueEntry();
      return;
    }

    if (this.uiState.activeTargetId === "navidrome" && isNavidromeProvider(this.appState.providers.navidrome)) {
      const selected = this.selectedNavidromeTrack();
      if (!selected) {
        this.appState.lastEvent = "no Navidrome Track selected";
        return;
      }

      const entry = this.queue.enqueue(selected);
      this.selectQueueIndex(Math.max(0, this.queue.entries.indexOf(entry)));
      this.appState.lastEvent = `added ${selected.title} to shared Queue`;
      this.syncQueueState();
      return;
    }

    if (this.uiState.activeTargetId === "youtube-url-download") {
      await this.refreshHelperDependency("yt-dlp");
      const healthMessage = youtubeDownloadHealthMessage(this.appState.dependencyHealth);
      if (healthMessage) {
        this.updateUiState({ activePrompt: null });
        this.appState.lastEvent = healthMessage;
        return;
      }

      this.appState.lastEvent = "would open YouTube URL prompt, download into Offline YouTube Cache, then enqueue";
      this.updateUiState({ activePrompt: "youtube-url" });
      return;
    }

    const selected = this.selectedVisibleTrack();
    if (!selected) {
      this.appState.lastEvent = "no Track selected";
      return;
    }

    const entry = this.queue.enqueue(selected);
    this.markSelectedOfflineYouTubeCacheAvailability(entry);
    this.selectQueueIndex(Math.max(0, this.queue.entries.indexOf(entry)));
    this.appState.lastEvent = `added ${selected.title} to shared Queue`;
    this.syncQueueState();
  }

  private async activateSelectedContent(): Promise<void> {
    if (this.uiState.activeTargetId !== "navidrome") {
      await this.enqueueSelectedTrack();
      return;
    }

    const provider = this.appState.providers.navidrome;
    if (!isNavidromeProvider(provider)) {
      this.appState.lastEvent = "Navidrome Library Browser is unavailable";
      return;
    }

    const index = this.uiState.selectedContentIndexByTarget.navidrome ?? 0;
    const entry = provider.getLibraryBrowserEntries()[index];
    if (!entry) {
      this.appState.lastEvent = "no Navidrome Library Browser row selected";
      return;
    }

    try {
      await provider.openLibraryBrowserEntry(entry);
      const providerLocation = navidromeLocationForEntry(entry);
      if (providerLocation) this.updateUiState({ providerLocation });
    } catch (error) {
      this.appState.lastEvent = error instanceof Error ? error.message : String(error);
      return;
    }

    if (entry.kind === "artist") {
      this.appState.lastEvent = `opened Navidrome artist ${entry.label}`;
    } else if (entry.kind === "album") {
      this.appState.lastEvent = `opened Navidrome album ${entry.label}`;
    } else if (entry.kind === "load-more-albums" || entry.kind === "load-more-tracks") {
      this.appState.lastEvent = entry.label;
    } else if (entry.kind === "track") {
      this.appState.lastEvent = `selected Navidrome Track ${entry.label}`;
    } else {
      this.appState.lastEvent = "opened Navidrome artists";
    }
  }

  private async openLocalPathPrompt(): Promise<void> {
    this.updateUiState({
      activeTargetId: "local",
      selectedTargetIndex: navigationTargetIndex("local"),
      focusedPane: "content",
      activePrompt: "local-open-path",
      promptInput: "",
      providerLocation: { providerId: "local", path: [] },
    });
    this.appState.lastEvent = "opened Local path prompt";
    await this.persistLastSelectedTarget("local");
  }

  private openNavidromeSearchPrompt(): void {
    if (this.uiState.activeTargetId !== "navidrome") {
      this.appState.lastEvent = "Navidrome search is only available in the Navidrome Library Browser";
      return;
    }

    this.updateUiState({ focusedPane: "content", activePrompt: "navidrome-search", promptInput: "" });
    this.appState.lastEvent = "opened Navidrome search prompt";
  }

  private setPromptInput(value: string): void {
    if (!this.uiState.activePrompt) return;
    this.updateUiState({ promptInput: value });
  }

  private async submitPrompt(): Promise<void> {
    if (this.uiState.activePrompt === "local-open-path") {
      const path = this.uiState.promptInput;
      this.updateUiState({ activePrompt: null, promptInput: "" });
      this.startLocalOpen(path);
      return;
    }

    if (this.uiState.activePrompt === "youtube-url") {
      const url = this.uiState.promptInput;
      this.updateUiState({ activePrompt: null, promptInput: "" });
      this.startYouTubeUrlDownload(url);
      return;
    }

    if (this.uiState.activePrompt === "navidrome-search") {
      const query = this.uiState.promptInput;
      this.updateUiState({ activePrompt: null, promptInput: "" });
      await this.searchNavidromeTracks(query);
    }
  }

  private cancelPrompt(): void {
    if (!this.uiState.activePrompt) return;

    this.updateUiState({ activePrompt: null, promptInput: "" });
    this.appState.lastEvent = "cancelled prompt";
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

    void this.submitYouTubeUrl(url, controller.signal)
      .catch((error) => {
        if (this.tornDown) return;
        this.appState.lastEvent = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        if (this.activeYouTubeDownload === controller) this.activeYouTubeDownload = null;
        this.notifyStateChanged();
      });
  }

  private cancelYouTubeDownload(): void {
    if (!this.activeYouTubeDownload) {
      this.appState.lastEvent = "no active YouTube download";
      return;
    }

    this.activeYouTubeDownload.abort();
    this.appState.lastEvent = "cancelling YouTube download";
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
      activePrompt: null,
      promptInput: "",
      providerLocation: { providerId: "local", path: [path] },
    });
    await this.persistLastSelectedTarget("local");

    const result = await localProvider.createTracksFromOpenPath(path, {
      signal,
      softCap: this.appState.config.providers.local.directorySoftCap,
    });
    let selectedEntry: QueueEntry | undefined;
    for (const track of result.tracks) {
      selectedEntry = this.queue.enqueue(track);
    }

    if (selectedEntry) {
      this.selectQueueIndex(Math.max(0, this.queue.entries.indexOf(selectedEntry)));
    }

    this.syncQueueState();
    if (result.cancelled) {
      this.appState.lastEvent = `cancelled Local open after ${result.tracks.length} Tracks`;
      return;
    }

    if (result.capped) {
      this.appState.lastEvent = `added ${result.tracks.length} Local Tracks to shared Queue; soft cap reached`;
      return;
    }

    if (result.tracks.length === 0) {
      this.appState.lastEvent = "no Local audio files found";
      return;
    }

    this.appState.lastEvent = `added ${result.tracks.length} Local Tracks to shared Queue`;
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

  private removeSelectedQueueEntry(): void {
    const removed = this.queue.remove(this.uiState.selectedQueueIndex);
    if (!removed) {
      this.appState.lastEvent = "Queue is empty";
      this.syncQueueState();
      return;
    }

    this.selectQueueIndex(clampIndex(this.uiState.selectedQueueIndex, this.queue.entries.length));
    if (sameIdentity(removed.track.identity, this.appState.playback.currentTrackIdentity)) {
      this.appState.playback = {
        status: "idle",
        currentTrackIdentity: null,
      };
    }
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

  private clearQueue(): void {
    this.queue.clear();
    this.selectQueueIndex(0);
    this.appState.playback = {
      status: "idle",
      currentTrackIdentity: null,
    };
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

    let skippedUnavailable = false;
    for (let attempts = 0; attempts < this.queue.entries.length; attempts += 1) {
      const entry = this.queue.next();
      if (!entry) {
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

    this.appState.lastEvent = "no available Tracks to play";
    this.syncQueueState();
  }

  private async previousTrack(): Promise<void> {
    if (this.blockPlaybackActionIfUnavailable()) return;

    const entry = this.queue.previous();
    if (!entry) {
      this.appState.lastEvent = "start of Queue";
      this.syncQueueState();
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
    const ok = await this.runPlayerCommand(() => this.player.setVolume(clamped));
    if (!ok) return;

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

  private async saveLastQueueSnapshot(): Promise<void> {
    await this.snapshotPersistence.save(createLastQueueSnapshot(this.queue.snapshot(), this.appState.volume));
    this.appState.lastEvent = "saved Last Queue Snapshot";
  }

  private async restoreLastQueueSnapshot(): Promise<void> {
    const snapshot = await this.snapshotPersistence.load();
    this.recordPersistenceRecoveryMessages(this.snapshotPersistence);
    if (!snapshot) {
      this.appState.lastEvent = "no Last Queue Snapshot";
      return;
    }

    await this.applyLastQueueSnapshot(snapshot);
    this.appState.lastEvent = "restored Last Queue Snapshot";
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

  private refreshOfflineYouTubeCache(): void {
    const provider = this.appState.providers[OFFLINE_YOUTUBE_CACHE_PROVIDER_ID];
    if (!isOfflineYouTubeCacheProvider(provider)) return;
    provider.refresh();
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
    this.selectQueueIndex(Math.max(0, this.queue.entries.indexOf(entry)));
    this.appState.lastEvent = `added ${cacheEntry.track.title} to shared Queue`;
    this.syncQueueState();
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

  private async seedLocalCliArg(arg: string): Promise<void> {
    try {
      const track = await this.localCliTrackFromArg(arg);
      if (!track || this.tornDown) return;

      this.enqueueCliTrack(track);
      this.syncQueueState();
      this.notifyStateChanged();
    } catch (error) {
      if (this.tornDown) return;

      this.appState.lastEvent = error instanceof Error ? error.message : String(error);
      this.notifyStateChanged();
    }
  }

  private async localCliTrackFromArg(arg: string): Promise<QueueEntry["track"] | undefined> {
    const localProvider = this.appState.providers.local;
    if (isLocalProvider(localProvider)) return await localProvider.createTrackFromCliArg(arg);
    throw new Error("Local Provider cannot open CLI file arguments");
  }

  private enqueueCliTrack(track: QueueEntry["track"]): void {
    const entry = this.queue.enqueue(track);
    const index = this.queue.entries.indexOf(entry);
    this.selectQueueIndex(Math.max(0, index));
    this.appState.lastEvent = `added ${track.title} to shared Queue`;
  }

  private async togglePlayPause(): Promise<void> {
    if (this.blockPlaybackActionIfUnavailable()) return;

    if (!this.appState.playback.currentTrackIdentity) {
      this.appState.lastEvent = "nothing is playing";
      return;
    }

    const ok = await this.runPlayerCommand(() => this.player.togglePause());
    if (!ok) return;
    this.appState.lastEvent = this.appState.playback.status === "paused" ? "paused" : "resumed";
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

  private async refreshNavidromeConnection(): Promise<void> {
    const provider = this.appState.providers.navidrome;
    if (!isNavidromeProvider(provider)) return;

    const state = await provider.validateConnection();
    if (state.status === "connected") {
      try {
        await provider.listArtists();
      } catch (error) {
        this.appState.lastEvent = error instanceof Error ? error.message : String(error);
        return;
      }
    }
    this.appState.lastEvent = state.message;
  }

  private async refreshEnteredTarget(targetId: NavigationTargetId): Promise<void> {
    if (targetId === "navidrome") await this.refreshNavidromeConnection();
    if (targetId === OFFLINE_YOUTUBE_CACHE_PROVIDER_ID) this.refreshOfflineYouTubeCache();
    if (targetId === "youtube-url-download") await this.refreshHelperDependency("yt-dlp");
  }

  private async refreshNavidromeLibrary(): Promise<void> {
    const provider = this.appState.providers.navidrome;
    if (!isNavidromeProvider(provider)) {
      this.appState.lastEvent = "Navidrome Library Browser is unavailable";
      return;
    }

    const state = await provider.validateConnection();
    if (state.status !== "connected") {
      this.appState.lastEvent = state.message;
      return;
    }

    try {
      await provider.refreshLibraryBrowser();
    } catch (error) {
      this.appState.lastEvent = error instanceof Error ? error.message : String(error);
      return;
    }

    this.selectContentIndex("navidrome", 0);
    this.appState.lastEvent = "refreshed Navidrome Library Browser";
  }

  private async searchNavidromeTracks(query: string): Promise<void> {
    const provider = this.appState.providers.navidrome;
    if (!isNavidromeProvider(provider)) {
      this.appState.lastEvent = "Navidrome Library Browser is unavailable";
      return;
    }

    if (this.uiState.activeTargetId !== "navidrome") {
      this.updateUiState({
        activeTargetId: "navidrome",
        selectedTargetIndex: navigationTargetIndex("navidrome"),
        providerLocation: { providerId: "navidrome", path: [] },
      });
    }
    this.updateUiState({ focusedPane: "content" });

    try {
      const results = await provider.searchTracks(query);
      const entries = provider.getLibraryBrowserEntries();
      const firstResultIndex = entries.findIndex((entry) => entry.kind === "search-result");
      this.selectContentIndex("navidrome", firstResultIndex === -1 ? 0 : firstResultIndex);
      this.updateUiState({
        providerLocation: { providerId: "navidrome", path: ["search", query.trim()] },
      });
      this.appState.lastEvent = results.length === 0
        ? `Navidrome search found no Tracks for ${query.trim()}`
        : `Navidrome search found ${results.length} Tracks for ${query.trim()}`;
    } catch (error) {
      this.appState.lastEvent = error instanceof Error ? error.message : String(error);
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

  private selectedVisibleTrack() {
    const targetId = this.uiState.activeTargetId;
    const tracks = this.visibleTracks(targetId);
    const index = clampIndex(this.uiState.selectedContentIndexByTarget[targetId] ?? 0, tracks.length);
    return tracks[index];
  }

  private selectedNavidromeTrack() {
    const provider = this.appState.providers.navidrome;
    if (!isNavidromeProvider(provider)) return undefined;

    const entries = provider.getLibraryBrowserEntries();
    const index = clampIndex(this.uiState.selectedContentIndexByTarget.navidrome ?? 0, entries.length);
    const entry = entries[index];
    return entry ? provider.trackForLibraryBrowserEntry(entry) : undefined;
  }

  private visibleTracks(targetId: NavigationTargetId) {
    if (targetId === "queue") return [];
    return this.providerFor(targetId)?.listVisibleTracks() ?? [];
  }

  private visibleContentLength(targetId: NavigationTargetId): number {
    if (targetId === "navidrome") {
      const provider = this.providerFor(targetId);
      if (isNavidromeProvider(provider)) return provider.getLibraryBrowserEntries().length;
    }
    return this.visibleTracks(targetId).length;
  }

  private providerFor(targetId: NavigationTargetId): Provider | undefined {
    return this.appState.providers[targetId];
  }

  private syncQueueState(): void {
    this.appState.queue = this.queue.snapshot();
    this.uiStateStore.dispatch({
      type: "syncQueue",
      identities: this.queueIdentities(),
    });
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

function completedPlayThresholdSeconds(durationSeconds: number | null | undefined): number {
  return typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.min(240, durationSeconds / 2)
    : 240;
}

function navidromeLocationForEntry(entry: NavidromeLibraryBrowserEntry) {
  switch (entry.kind) {
    case "artists-root":
      return { providerId: "navidrome" as const, path: ["artists"] };
    case "artist":
      return { providerId: "navidrome" as const, path: ["artists", `artist:${entry.id}`] };
    case "album":
      return {
        providerId: "navidrome" as const,
        path: ["artists", `artist:${entry.artistId}`, `album:${entry.id}`],
      };
    case "playlists-root":
      return { providerId: "navidrome" as const, path: ["playlists"] };
    case "playlist":
      return { providerId: "navidrome" as const, path: ["playlists", `playlist:${entry.id}`] };
    default:
      return null;
  }
}
