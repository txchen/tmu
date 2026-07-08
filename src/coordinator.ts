import {
  NAVIGATION_TARGETS,
  clampIndex,
  navigationTargetIndex,
  sameIdentity,
  type AppIntent,
  type AppState,
  type Player,
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
import { createLocalTrackFromCliArg } from "./providers";
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

  constructor(options: AppCoordinatorOptions) {
    this.appState = options.appState;
    this.uiState = options.uiState;
    this.queue = options.queue;
    this.player = options.player;
    this.refreshDependencyHealth = options.refreshDependencyHealth ?? (async (_helper, currentHealth) => currentHealth);
    this.snapshotPersistence = options.snapshotPersistence ?? new InMemoryLastQueueSnapshotPersistence();
    this.syncQueueState();
  }

  start(cliArgs: readonly string[]): void {
    for (const arg of cliArgs) {
      if (arg.trim()) this.queue.enqueue(createLocalTrackFromCliArg(arg));
    }

    if (cliArgs.length > 0) {
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

    this.syncQueueState();
  }

  async dispatch(intent: AppIntent): Promise<void> {
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
        this.setVolume(intent.percent, intent.ready);
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

        this.appState.playback = await this.player.stop();
        this.appState.lastEvent = "stopped";
        return;
      case "quit":
        this.appState.lastEvent = "quit requested";
        return;
    }
  }

  private async selectNavigationTarget(targetId: NavigationTargetId): Promise<void> {
    if (targetId === "youtube-url-download") await this.refreshHelperDependency("yt-dlp");

    this.uiState.activeTargetId = targetId;
    this.uiState.selectedTargetIndex = navigationTargetIndex(targetId);
    this.uiState.focusedPane = targetId === "queue" ? "queue" : "content";
    this.uiState.activePrompt = targetId === "youtube-url-download" && !youtubeDownloadHealthMessage(this.appState.dependencyHealth)
      ? "youtube-url"
      : null;
    this.appState.lastEvent = `switched to ${NAVIGATION_TARGETS[this.uiState.selectedTargetIndex]?.label ?? targetId}`;
  }

  private async moveSelection(delta: number): Promise<void> {
    if (this.uiState.focusedPane === "targets") {
      this.uiState.selectedTargetIndex = clampIndex(this.uiState.selectedTargetIndex + delta, NAVIGATION_TARGETS.length);
      this.uiState.activeTargetId = NAVIGATION_TARGETS[this.uiState.selectedTargetIndex]?.id ?? "local";
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
    this.uiState.selectedContentIndexByTarget[targetId] = clampIndex(current + delta, this.visibleTracks(targetId).length);
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

  private async startSelectedQueueEntry(): Promise<void> {
    if (this.blockPlaybackActionIfUnavailable()) return;

    const entry = this.queue.startAt(this.uiState.selectedQueueIndex);
    if (!entry) {
      this.appState.lastEvent = "Queue is empty";
      this.syncQueueState();
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

    const entry = this.queue.next();
    if (!entry) {
      this.appState.lastEvent = "end of Queue";
      this.syncQueueState();
      return;
    }

    this.uiState.selectedQueueIndex = this.queue.currentIndex;
    await this.playQueueEntry(entry);
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

  private setVolume(percent: number, ready: boolean): void {
    this.appState.volume = {
      percent: Math.max(0, Math.min(100, Math.round(percent))),
      ready,
    };
    this.appState.lastEvent = this.appState.volume.ready
      ? `volume ${this.appState.volume.percent}%`
      : "volume unavailable";
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
    this.appState.volume = snapshot.volume;
    this.uiState.selectedQueueIndex = snapshot.currentIndex >= 0
      ? snapshot.currentIndex
      : 0;
    this.appState.lastEvent = "restored Last Queue Snapshot";
    this.syncQueueState();
  }

  private async playQueueEntry(entry: QueueEntry): Promise<void> {
    const provider = this.appState.providers[entry.track.identity.providerId];
    if (!provider) {
      this.markUnavailable(entry, `Provider ${entry.track.identity.providerId} is unavailable`);
      return;
    }

    try {
      const locator = await provider.resolvePlaybackLocator(entry.track.identity);
      await this.player.load(locator);
      this.queue.markAvailability(entry.track.identity, { status: "available" });
      this.appState.playback = {
        status: "playing",
        currentTrackIdentity: entry.track.identity,
      };
      this.appState.lastEvent = `started ${entry.track.title}`;
      this.syncQueueState();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Playback Locator could not be resolved";
      this.markUnavailable(entry, message);
    }
  }

  private async togglePlayPause(): Promise<void> {
    if (this.blockPlaybackActionIfUnavailable()) return;

    if (!this.appState.playback.currentTrackIdentity) {
      this.appState.lastEvent = "nothing is playing";
      return;
    }

    const playback = await this.player.togglePause();
    this.appState.playback = {
      ...playback,
      currentTrackIdentity: this.appState.playback.currentTrackIdentity,
    };
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

  private providerFor(targetId: NavigationTargetId): Provider | undefined {
    return this.appState.providers[targetId];
  }

  private syncQueueState(): void {
    this.appState.queue = this.queue.snapshot();
  }
}
