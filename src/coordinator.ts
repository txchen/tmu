import {
  NAVIGATION_TARGETS,
  clampIndex,
  navigationTargetIndex,
  sameIdentity,
  type AppIntent,
  type AppState,
  type Player,
  type PlayerPlaybackState,
  type Provider,
  type Queue,
  type QueueEntry,
  type NavigationTargetId,
  type UiState,
} from "./domain";
import {
  playbackHealthMessage,
  youtubeDownloadHealthMessage,
  type DependencyHealthState,
  type HelperName,
} from "./dependencies";
import { isNavidromeProvider } from "./navidrome";
import { isLocalProvider } from "./providers";
import {
  InMemoryLastQueueSnapshotPersistence,
  createLastQueueSnapshot,
  type LastQueueSnapshotPersistence,
} from "./snapshot";

export type DependencyHealthRefresh = (
  helper: HelperName,
  currentHealth: DependencyHealthState,
) => Promise<DependencyHealthState>;

export type AppCoordinatorOptions = {
  appState: AppState;
  uiState: UiState;
  queue: Queue;
  player: Player;
  refreshDependencyHealth?: DependencyHealthRefresh;
  snapshotPersistence?: LastQueueSnapshotPersistence;
};

export class AppCoordinator {
  readonly appState: AppState;
  readonly uiState: UiState;
  private readonly queue: Queue;
  private readonly player: Player;
  private readonly refreshDependencyHealth: DependencyHealthRefresh;
  private readonly snapshotPersistence: LastQueueSnapshotPersistence;
  private readonly unsubscribeFromPlayer: () => void;
  private readonly unsubscribeFromProviders: Array<() => void>;
  private readonly stateListeners = new Set<() => void>();
  private activeLocalOpen: AbortController | null = null;
  private tornDown = false;

  constructor(options: AppCoordinatorOptions) {
    this.appState = options.appState;
    this.uiState = options.uiState;
    this.queue = options.queue;
    this.player = options.player;
    this.refreshDependencyHealth = options.refreshDependencyHealth ?? (async (_helper, currentHealth) => currentHealth);
    this.snapshotPersistence = options.snapshotPersistence ?? new InMemoryLastQueueSnapshotPersistence();
    this.unsubscribeFromPlayer = this.player.onPlaybackStateChange((playback) => {
      this.mergePlayerPlayback(playback);
      this.notifyStateChanged();
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

  async start(cliArgs: readonly string[]): Promise<void> {
    const fileArgs = cliArgs.filter((arg) => arg.trim());
    if (fileArgs.length > 0) {
      this.appState.startupMode = "cli-seeded";
      this.uiState.activeTargetId = "queue";
      this.uiState.focusedPane = "queue";
      this.uiState.selectedTargetIndex = navigationTargetIndex("queue");
      this.appState.lastEvent = "CLI args seeded the shared Queue";
    } else {
      this.appState.startupMode = "empty";
      this.uiState.activeTargetId = "local";
      this.uiState.focusedPane = "targets";
      this.uiState.selectedTargetIndex = navigationTargetIndex("local");
      this.appState.lastEvent = "opened target switcher";
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
        case "cycleFocus":
          this.cycleFocus();
          return;
        case "enqueueSelectedTrack":
          await this.enqueueSelectedTrack();
          return;
        case "openLocalPathPrompt":
          this.openLocalPathPrompt();
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
          this.toggleShuffle();
          return;
        case "toggleRepeatAll":
          this.toggleRepeatAll();
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
    this.unsubscribeFromPlayer();
    for (const unsubscribe of this.unsubscribeFromProviders) unsubscribe();
    await this.player.teardown();
  }

  onStateChange(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private async selectNavigationTarget(targetId: NavigationTargetId): Promise<void> {
    this.uiState.activeTargetId = targetId;
    this.uiState.selectedTargetIndex = navigationTargetIndex(targetId);
    this.uiState.focusedPane = targetId === "queue" ? "queue" : "content";
    if (targetId === "navidrome") await this.refreshNavidromeConnection();
    if (targetId === "youtube-url-download") await this.refreshHelperDependency("yt-dlp");
    this.uiState.activePrompt = targetId === "youtube-url-download" && !youtubeDownloadHealthMessage(this.appState.dependencyHealth)
      ? "youtube-url"
      : null;
    if (!this.uiState.activePrompt) this.uiState.promptInput = "";
    this.appState.lastEvent = `switched to ${NAVIGATION_TARGETS[this.uiState.selectedTargetIndex]?.label ?? targetId}`;
  }

  private async moveSelection(delta: number): Promise<void> {
    if (this.uiState.focusedPane === "targets") {
      this.uiState.selectedTargetIndex = clampIndex(this.uiState.selectedTargetIndex + delta, NAVIGATION_TARGETS.length);
      this.uiState.activeTargetId = NAVIGATION_TARGETS[this.uiState.selectedTargetIndex]?.id ?? "local";
      if (this.uiState.activeTargetId === "navidrome") await this.refreshNavidromeConnection();
      if (this.uiState.activeTargetId === "youtube-url-download") await this.refreshHelperDependency("yt-dlp");
      this.appState.lastEvent = `selected ${NAVIGATION_TARGETS[this.uiState.selectedTargetIndex]?.label ?? "target"}`;
      return;
    }

    if (this.uiState.focusedPane === "queue" || this.uiState.activeTargetId === "queue") {
      this.uiState.selectedQueueIndex = clampIndex(this.uiState.selectedQueueIndex + delta, this.queue.entries.length);
      this.appState.lastEvent = "moved queue selection";
      return;
    }

    const targetId = this.uiState.activeTargetId;
    const current = this.uiState.selectedContentIndexByTarget[targetId] ?? 0;
    this.uiState.selectedContentIndexByTarget[targetId] = clampIndex(current + delta, this.visibleContentLength(targetId));
    this.appState.lastEvent = "moved Provider Browsing Surface selection";
  }

  private cycleFocus(): void {
    const next = this.uiState.focusedPane === "targets"
      ? "content"
      : this.uiState.focusedPane === "content"
        ? "queue"
        : "targets";
    this.uiState.focusedPane = next;
    this.appState.lastEvent = `focus ${next}`;
  }

  private async enqueueSelectedTrack(): Promise<void> {
    if (this.uiState.activeTargetId === "queue") {
      await this.startSelectedQueueEntry();
      return;
    }

    if (this.uiState.activeTargetId === "youtube-url-download") {
      await this.refreshHelperDependency("yt-dlp");
      const healthMessage = youtubeDownloadHealthMessage(this.appState.dependencyHealth);
      if (healthMessage) {
        this.uiState.activePrompt = null;
        this.appState.lastEvent = healthMessage;
        return;
      }

      this.appState.lastEvent = "would open YouTube URL prompt, download into Offline YouTube Cache, then enqueue";
      this.uiState.activePrompt = "youtube-url";
      return;
    }

    const selected = this.selectedVisibleTrack();
    if (!selected) {
      this.appState.lastEvent = "no Track selected";
      return;
    }

    const entry = this.queue.enqueue(selected);
    this.uiState.selectedQueueIndex = Math.max(0, this.queue.entries.indexOf(entry));
    this.appState.lastEvent = `added ${selected.title} to shared Queue`;
    this.syncQueueState();
  }

  private openLocalPathPrompt(): void {
    this.uiState.activeTargetId = "local";
    this.uiState.selectedTargetIndex = navigationTargetIndex("local");
    this.uiState.focusedPane = "content";
    this.uiState.activePrompt = "local-open-path";
    this.uiState.promptInput = "";
    this.appState.lastEvent = "opened Local path prompt";
  }

  private setPromptInput(value: string): void {
    if (!this.uiState.activePrompt) return;
    this.uiState.promptInput = value;
  }

  private async submitPrompt(): Promise<void> {
    if (this.uiState.activePrompt === "local-open-path") {
      const path = this.uiState.promptInput;
      this.uiState.activePrompt = null;
      this.uiState.promptInput = "";
      this.startLocalOpen(path);
      return;
    }

    if (this.uiState.activePrompt === "youtube-url") {
      this.uiState.activePrompt = null;
      this.uiState.promptInput = "";
      this.appState.lastEvent = "YouTube URL Download is not implemented yet";
    }
  }

  private cancelPrompt(): void {
    if (!this.uiState.activePrompt) return;

    this.uiState.activePrompt = null;
    this.uiState.promptInput = "";
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

  private async openLocalPath(path: string, signal?: AbortSignal): Promise<void> {
    const localProvider = this.appState.providers.local;
    if (!isLocalProvider(localProvider)) {
      this.appState.lastEvent = "Local Provider cannot open paths";
      return;
    }

    this.uiState.activeTargetId = "local";
    this.uiState.selectedTargetIndex = navigationTargetIndex("local");
    this.uiState.focusedPane = "content";
    this.uiState.activePrompt = null;
    this.uiState.promptInput = "";

    const result = await localProvider.createTracksFromOpenPath(path, {
      signal,
      softCap: this.appState.config.providers.local.directorySoftCap,
    });
    let selectedEntry: QueueEntry | undefined;
    for (const track of result.tracks) {
      selectedEntry = this.queue.enqueue(track);
    }

    if (selectedEntry) {
      this.uiState.selectedQueueIndex = Math.max(0, this.queue.entries.indexOf(selectedEntry));
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

    this.uiState.selectedQueueIndex = clampIndex(this.uiState.selectedQueueIndex, this.queue.entries.length);
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

    this.uiState.selectedQueueIndex = toIndex;
    this.appState.lastEvent = `moved ${moved.track.title}`;
    this.syncQueueState();
  }

  private clearQueue(): void {
    this.queue.clear();
    this.uiState.selectedQueueIndex = 0;
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

      this.uiState.selectedQueueIndex = this.queue.currentIndex;
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

    this.uiState.selectedQueueIndex = this.queue.currentIndex;
    await this.playQueueEntry(entry);
  }

  private toggleShuffle(): void {
    this.queue.setShuffle(!this.queue.snapshot().shuffle);
    this.appState.lastEvent = this.queue.snapshot().shuffle ? "shuffle on" : "shuffle off";
    this.syncQueueState();
  }

  private toggleRepeatAll(): void {
    this.queue.setRepeatAll(!this.queue.snapshot().repeatAll);
    this.appState.lastEvent = this.queue.snapshot().repeatAll ? "repeat all on" : "repeat all off";
    this.syncQueueState();
  }

  private async setVolume(percent: number, ready: boolean): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    if (!ready) {
      this.appState.volume = { percent: clamped, ready };
      this.appState.lastEvent = "volume unavailable";
      return;
    }

    if (this.blockPlaybackActionIfUnavailable()) return;
    const ok = await this.runPlayerCommand(() => this.player.setVolume(clamped));
    if (!ok) return;

    this.appState.volume = { percent: clamped, ready };
    this.appState.lastEvent = `volume ${clamped}%`;
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
    if (!snapshot) {
      this.appState.lastEvent = "no Last Queue Snapshot";
      return;
    }

    this.queue.restore(snapshot);
    await this.refreshRestoredLocalAvailability();
    this.appState.volume = snapshot.volume;
    this.uiState.selectedQueueIndex = snapshot.currentIndex >= 0
      ? snapshot.currentIndex
      : 0;
    this.appState.lastEvent = "restored Last Queue Snapshot";
    this.syncQueueState();
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
      this.mergePlayerPlayback(this.player.playback);
      this.appState.lastEvent = error instanceof Error ? error.message : String(error);
      this.syncQueueState();
      return false;
    }

    this.queue.markAvailability(entry.track.identity, { status: "available" });
    this.appState.playback = {
      ...this.player.playback,
      status: "playing",
      currentTrackIdentity: entry.track.identity,
    };
    this.appState.lastEvent = `started ${entry.track.title}`;
    this.syncQueueState();
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
    this.uiState.selectedQueueIndex = Math.max(0, index);
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

  private selectedVisibleTrack() {
    const targetId = this.uiState.activeTargetId;
    const tracks = this.visibleTracks(targetId);
    const index = clampIndex(this.uiState.selectedContentIndexByTarget[targetId] ?? 0, tracks.length);
    return tracks[index];
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
  }

  private notifyStateChanged(): void {
    for (const listener of this.stateListeners) listener();
  }
}
