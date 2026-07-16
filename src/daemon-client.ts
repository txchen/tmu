import type { AppCoordinator, AppStateChangeReason } from "./coordinator";
import type { AppIntent, AppState, ConfirmationKind, TrackIdentity, UiState } from "./domain";
import { createInitialUiState } from "./state";
import { StatePublicationGate, type AppStateSnapshot, type DeepReadonly } from "./state-publication";
import { UiStateStore, type UiStateAction } from "./ui-state";

export type SharedState = Omit<AppStateSnapshot, "appErrors" | "operationFeedback" | "activePlaylistContent" | "playlists"> & {
  readonly playingPlaylistContent: AppStateSnapshot["activePlaylistContent"];
  readonly playlists: Omit<AppStateSnapshot["playlists"], "activePlaylistId"> & { readonly playingPlaylistId: string };
};

export type SharedStateSnapshot = Readonly<{
  revision: number;
  state: DeepReadonly<SharedState>;
}>;

export type ClientUiState = UiState & { viewedPlaylistId: string };

export type CommandFeedback = Readonly<{
  requestId: string;
  status: "success" | "error" | "stale-confirmation";
  message: string;
  revision: number;
}>;

export type DaemonNotice = Readonly<{ message: string; revision: number }>;
export type DaemonLifecycle = "starting" | "ready" | "terminating" | "stopped";

export type ConfirmationChallenge = Readonly<{
  token: string;
  kind: ConfirmationKind | "shutdown-daemon";
  targetId: string;
  revision: number;
  impact: string;
  expiresAt: number;
}>;

export type SharedCommand =
  | { type: "intent"; intent: AppIntent; playlistId?: string }
  | { type: "createPlaylist"; name: string }
  | { type: "viewPlaylist"; playlistId: string }
  | { type: "adjustVolume"; delta: number }
  | { type: "setVolume"; percent: number }
  | { type: "background"; operation: "enter" | "retry" | "setEnabled" | "setSound" | "adjustVolume"; value?: boolean | string | 1 | -1 }
  | { type: "broadcastNotice"; message: string };

export interface DaemonClient {
  readonly id: string;
  readonly snapshot: SharedStateSnapshot;
  readonly uiState: Readonly<ClientUiState>;
  dispatchUi(action: UiStateAction): Readonly<ClientUiState>;
  submit(command: SharedCommand): Promise<CommandFeedback>;
  requestChallenge(request: { kind: ConfirmationChallenge["kind"]; targetId: string }): Promise<ConfirmationChallenge>;
  confirmChallenge(token: string): Promise<CommandFeedback>;
  cancelChallenge(token: string): Promise<void>;
  onSnapshot(listener: (snapshot: SharedStateSnapshot) => void): () => void;
  onFeedback(listener: (feedback: CommandFeedback) => void): () => void;
  onNotice(listener: (notice: DaemonNotice) => void): () => void;
  disconnect(): void;
}

/** The only application-facing surface consumed by the terminal UI. */
export interface TuiDaemonClient {
  readonly quitIsClientOnly?: boolean;
  readonly appState: AppState;
  readonly uiState: Readonly<UiState>;
  readonly viewedPlaylistId?: string;
  disconnect?(): void;
  dispatch(intent: AppIntent): Promise<void>;
  dispatchUi(action: UiStateAction): Readonly<UiState>;
  playlistTrackIdentities(): readonly TrackIdentity[];
  onStateChange(listener: (reason: AppStateChangeReason) => void): () => void;
  onDaemonShutdown?(listener: (message: string) => void): () => void;
  enterBackgroundSounds(): Promise<void>;
  retryBackgroundSounds(): Promise<void>;
  setBackgroundSoundsEnabled(value: boolean): Promise<void>;
  setBackgroundSound(id: string): Promise<void>;
  adjustBackgroundSoundsVolume(delta: 1 | -1): void;
  confirmProtected?(kind: ConfirmationChallenge["kind"], targetId: string, intent: AppIntent): Promise<void>;
  requestShutdownChallenge?(): Promise<string>;
  confirmShutdown?(): Promise<void>;
  cancelShutdown?(): Promise<void>;
}

type ClientRecord = {
  ui: UiStateStore;
  viewedPlaylistId: string;
  snapshots: Set<(snapshot: SharedStateSnapshot) => void>;
  feedback: Set<(feedback: CommandFeedback) => void>;
  notices: Set<(notice: DaemonNotice) => void>;
};

type StoredChallenge = ConfirmationChallenge & { clientId: string };

export class InProcessDaemonApplication {
  private readonly clients = new Map<string, ClientRecord>();
  private readonly challenges = new Map<string, StoredChallenge>();
  private commandTail: Promise<unknown> = Promise.resolve();
  private revision = 0;
  private currentSnapshot!: SharedStateSnapshot;
  private lastFingerprint = "";
  private unsubscribe?: () => void;
  private publication?: StatePublicationGate;
  private lifecycle: DaemonLifecycle = "starting";
  private shutdownListener?: () => void;
  private operationalLog?: (message: string) => void;
  private lastOperationalEvent = "";

  constructor(private readonly coordinator: AppCoordinator, private readonly now: () => number = Date.now) {}

  async start(): Promise<void> {
    await this.coordinator.start();
    const lowPower = this.coordinator.appState.config.lowPower;
    const publicationUi = createInitialUiState();
    this.publication = new StatePublicationGate({
      readState: () => ({ appState: this.coordinator.appState, uiState: publicationUi }),
      cadence: {
        playbackCadenceMs: lowPower.playbackProgressMs,
        downloadProgressMs: lowPower.downloadProgressThrottleMs,
        providerProgressMs: lowPower.libraryProgressThrottleMs,
      },
    });
    this.publication.subscribe((snapshot) => this.publish(snapshot.appState));
    this.publish(this.publication.publishInitial().appState, true);
    this.unsubscribe = this.coordinator.onStateChange((reason) => this.onCoordinatorChange(reason));
    this.lifecycle = "ready";
  }

  async connect(): Promise<DaemonClient> {
    if (this.lifecycle !== "ready") throw new Error("TMU Daemon is shutting down");
    if (!this.currentSnapshot) throw new Error("Daemon application has not started");
    const id = crypto.randomUUID();
    const viewedPlaylistId = this.currentSnapshot.state.playlists.playingPlaylistId;
    this.clients.set(id, {
      ui: new UiStateStore(createInitialUiState()), viewedPlaylistId,
      snapshots: new Set(), feedback: new Set(), notices: new Set(),
    });
    return new InProcessDaemonClient(this, id);
  }

  async connectTui(): Promise<TuiDaemonClient> {
    return new TuiDaemonClientAdapter(await this.connect(), false);
  }

  async teardown(): Promise<void> {
    this.lifecycle = "stopped";
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.publication?.stop();
    this.clients.clear();
    this.challenges.clear();
    await this.commandTail.catch(() => undefined);
    await this.coordinator.teardown();
    const cleanupFailure = [...this.coordinator.appState.appErrors].reverse().find((message) => message.startsWith("Coordinator cleanup failed:"));
    if (cleanupFailure) throw new Error(cleanupFailure);
  }

  record(id: string): ClientRecord {
    const record = this.clients.get(id);
    if (!record) throw new Error("DaemonClient is disconnected");
    return record;
  }

  snapshot(): SharedStateSnapshot { return this.currentSnapshot; }

  submit(clientId: string, command: SharedCommand): Promise<CommandFeedback> {
    this.record(clientId);
    if (this.lifecycle !== "ready") return Promise.resolve(this.deliverFeedback(clientId, crypto.randomUUID(), "error", "TMU Daemon is shutting down"));
    const requestId = crypto.randomUUID();
    const execute = () => this.execute(clientId, requestId, command);
    const result = this.commandTail.then(execute, execute);
    this.commandTail = result.catch(() => undefined);
    return result;
  }

  requestChallenge(clientId: string, request: { kind: ConfirmationChallenge["kind"]; targetId: string }): Promise<ConfirmationChallenge> {
    this.record(clientId);
    if (this.lifecycle !== "ready") return Promise.reject(new Error("TMU Daemon is shutting down"));
    if (request.kind === "accept-playlist" && this.coordinator.playlistDownloadConfirmationOwner !== clientId) {
      return Promise.reject(new Error("Playlist download Confirmation Challenge belongs to another client"));
    }
    const challenge: StoredChallenge = Object.freeze({
      ...request, clientId, token: crypto.randomUUID(), revision: this.revision,
      impact: this.challengeImpact(request.kind, request.targetId), expiresAt: this.now() + 30_000,
    });
    this.challenges.set(challenge.token, challenge);
    return Promise.resolve(challenge);
  }

  confirmChallenge(clientId: string, token: string): Promise<CommandFeedback> {
    try { this.record(clientId); }
    catch (error) { return Promise.reject(error); }
    const challenge = this.challenges.get(token);
    if (!challenge) return Promise.resolve(this.deliverFeedback(clientId, crypto.randomUUID(), "stale-confirmation", "Confirmation Challenge is no longer available"));
    if (challenge.clientId !== clientId) return Promise.reject(new Error("Confirmation Challenge belongs to another client"));
    this.challenges.delete(token);
    let currentImpact: string;
    try { currentImpact = this.challengeImpact(challenge.kind, challenge.targetId); }
    catch { currentImpact = ""; }
    if (challenge.expiresAt <= this.now() || currentImpact !== challenge.impact) {
      return Promise.resolve(this.deliverFeedback(clientId, crypto.randomUUID(), "stale-confirmation", "Confirmation Challenge is stale; review the current impact"));
    }
    const protectedCommand = commandForChallenge(challenge);
    if (protectedCommand) {
      const requestId = crypto.randomUUID();
      const execute = () => {
        let queuedImpact: string;
        try { queuedImpact = this.challengeImpact(challenge.kind, challenge.targetId); }
        catch { queuedImpact = ""; }
        if (queuedImpact !== challenge.impact) {
          return this.deliverFeedback(clientId, requestId, "stale-confirmation", "Confirmation Challenge is stale; review the current impact");
        }
        return this.execute(clientId, requestId, protectedCommand, true);
      };
      const result = this.commandTail.then(execute, execute);
      this.commandTail = result.catch(() => undefined);
      return result;
    }
    if (challenge.kind === "shutdown-daemon") {
      this.beginShutdown(clientId);
      return Promise.resolve(this.deliverFeedback(clientId, crypto.randomUUID(), "success", "TMU Daemon shutdown started"));
    }
    return Promise.resolve(this.deliverFeedback(clientId, crypto.randomUUID(), "success", `confirmed ${challenge.kind}`));
  }

  cancelChallenge(clientId: string, token: string): Promise<void> {
    const challenge = this.challenges.get(token);
    if (challenge?.clientId === clientId) this.challenges.delete(token);
    return Promise.resolve();
  }

  disconnect(clientId: string): void {
    this.clients.delete(clientId);
    this.coordinator.disconnectDaemonClient(clientId);
    for (const [token, challenge] of this.challenges) if (challenge.clientId === clientId) this.challenges.delete(token);
  }

  get status(): Readonly<{ lifecycle: DaemonLifecycle; clientCount: number; snapshot: SharedStateSnapshot }> {
    return { lifecycle: this.lifecycle, clientCount: this.clients.size, snapshot: this.currentSnapshot };
  }

  onShutdown(listener: () => void): void { this.shutdownListener = listener; }
  onOperationalLog(listener: (message: string) => void): void { this.operationalLog = listener; }

  async persistFinalSnapshot(): Promise<void> { await this.coordinator.persistFinalSnapshot(); }

  requestOperationalShutdown(): void {
    if (this.lifecycle !== "ready") return;
    this.beginShutdown();
  }

  private beginShutdown(requestingClientId?: string): void {
    if (this.lifecycle !== "ready") return;
    this.lifecycle = "terminating";
    this.challenges.clear();
    const notice = Object.freeze({
      message: requestingClientId ? "TMU Daemon is shutting down at a peer client's request" : "TMU Daemon is shutting down",
      revision: this.revision,
    });
    for (const client of this.clients.values()) for (const listener of client.notices) listener(notice);
    this.shutdownListener?.();
  }

  private async execute(clientId: string, requestId: string, command: SharedCommand, confirmed = false): Promise<CommandFeedback> {
    try {
      if (command.type === "viewPlaylist") {
        const client = this.record(clientId);
        if (!this.currentSnapshot.state.playlists.playlists.some((playlist) => playlist.id === command.playlistId)) throw new Error("Playlist is missing");
        client.viewedPlaylistId = command.playlistId;
        return this.deliverFeedback(clientId, requestId, "success", "changed Viewed Playlist");
      }
      if (command.type === "createPlaylist") {
        const playlistId = await this.coordinator.createSharedPlaylist(command.name);
        const client = this.clients.get(clientId);
        if (client) client.viewedPlaylistId = playlistId;
        return this.deliverFeedback(clientId, requestId, "success", `created Playlist ${command.name.trim()}`);
      }
      if (command.type === "adjustVolume") {
        await this.coordinator.dispatch({ type: "playerOperation", operation: "set-volume", percent: this.coordinator.appState.volume.percent + command.delta, ready: true });
        return this.deliverFeedback(clientId, requestId, "success", "adjusted volume");
      }
      if (command.type === "setVolume") {
        await this.coordinator.dispatch({ type: "playerOperation", operation: "set-volume", percent: command.percent, ready: true });
        return this.deliverFeedback(clientId, requestId, "success", "set volume");
      }
      if (command.type === "broadcastNotice") {
        const notice = Object.freeze({ message: command.message, revision: this.revision });
        for (const client of this.clients.values()) for (const listener of client.notices) listener(notice);
        return this.deliverFeedback(clientId, requestId, "success", command.message);
      }
      if (command.type === "background") {
        if (command.operation === "enter") await this.coordinator.enterBackgroundSounds();
        else if (command.operation === "retry") await this.coordinator.retryBackgroundSounds();
        else if (command.operation === "setEnabled") await this.coordinator.setBackgroundSoundsEnabled(command.value === true);
        else if (command.operation === "setSound") await this.coordinator.setBackgroundSound(String(command.value));
        else this.coordinator.adjustBackgroundSoundsVolume(command.value === -1 ? -1 : 1);
        return this.deliverFeedback(clientId, requestId, "success", `completed Background Sounds ${command.operation}`);
      }
      if (command.intent.type === "downloadOperation" && command.intent.operation === "start") {
        this.coordinator.startDaemonDownload(command.intent.url, clientId);
        return this.deliverFeedback(clientId, requestId, "success", "submitted YouTube URL to the Download Pipeline");
      }
      if (!confirmed && isProtectedIntent(command.intent)) {
        throw new Error(`${command.intent.type} requires a Confirmation Challenge`);
      }
      if (command.intent.type === "switchPlaylist") {
        throw new Error("Viewed Playlist is client-local; use viewPlaylist");
      }
      if (isPlaylistTargetedIntent(command.intent)) {
        const playlistId = command.playlistId ?? this.clients.get(clientId)?.viewedPlaylistId;
        if (!playlistId) throw new Error("A stable Playlist identity is required");
        await this.coordinator.dispatchPlaylistIntent(playlistId, command.intent);
      } else {
        await this.coordinator.dispatch(command.intent);
      }
      return this.deliverFeedback(clientId, requestId, "success", this.coordinator.appState.lastEvent);
    } catch (error) {
      const feedback = this.deliverFeedback(clientId, requestId, "error", error instanceof Error ? error.message : String(error));
      return feedback;
    }
  }

  private deliverFeedback(clientId: string, requestId: string, status: CommandFeedback["status"], message: string): CommandFeedback {
    const feedback = Object.freeze({ requestId, status, message, revision: this.revision });
    const client = this.clients.get(clientId);
    if (client) for (const listener of client.feedback) listener(feedback);
    if (status !== "success") this.operationalLog?.(`command failure: ${message}`);
    return feedback;
  }

  private onCoordinatorChange(reason: AppStateChangeReason): void {
    this.publication?.notify(reason);
    const event = this.coordinator.appState.lastEvent;
    if (event !== this.lastOperationalEvent && /(?:Download Batch|downloaded|recovery|persist|failed|failure)/i.test(event)) {
      this.lastOperationalEvent = event;
      this.operationalLog?.(event);
    }
  }

  private publish(selected: AppStateSnapshot, force = false): void {
    const { appErrors: _legacyErrors, operationFeedback: _feedback, activePlaylistContent, playlists, ...state } = selected;
    const { activePlaylistId, ...playlistState } = playlists;
    const shared = {
      ...state,
      playingPlaylistContent: activePlaylistContent,
      playlists: { ...playlistState, playingPlaylistId: activePlaylistId },
    } as SharedState;
    const fingerprint = JSON.stringify(shared);
    if (!force && fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;
    this.revision += 1;
    this.currentSnapshot = deepFreeze({ revision: this.revision, state: shared as DeepReadonly<SharedState> });
    for (const [id, client] of this.clients) {
      if (!shared.playlists.playlists.some((playlist) => playlist.id === client.viewedPlaylistId)) {
        client.viewedPlaylistId = shared.playlists.playingPlaylistId;
      }
      for (const listener of client.snapshots) listener(this.currentSnapshot);
      for (const [token, challenge] of this.challenges) {
        if (challenge.clientId !== id) continue;
        try {
          if (this.challengeImpact(challenge.kind, challenge.targetId) !== challenge.impact) this.challenges.delete(token);
        } catch { this.challenges.delete(token); }
      }
    }
  }

  private challengeImpact(kind: ConfirmationChallenge["kind"], targetId: string): string {
    if (kind === "delete-playlist" || kind === "clear-playlist") {
      const playlist = this.currentSnapshot.state.playlists.playlists.find((item) => item.id === targetId);
      if (!playlist) throw new Error(`Playlist is missing: ${targetId}`);
      const action = kind === "delete-playlist" ? "Delete" : "Clear";
      const playing = playlist.id === this.currentSnapshot.state.playlists.playingPlaylistId ? "; shared playback will stop" : "";
      return `${action} Playlist ${playlist.name} containing ${playlist.entries.length} Tracks${playing}`;
    }
    const downloads = this.currentSnapshot.state.downloads;
    if (kind === "cancel-download") {
      if (!downloads.activeBatch) throw new Error("There is no active Download Batch");
      return `Cancel active Download Batch ${downloads.activeBatch.id} containing ${downloads.activeBatch.itemCount} source items`;
    }
    if (kind === "remove-pending-download") {
      const batch = downloads.pendingBatches.find((item) => item.id === Number(targetId));
      if (!batch) throw new Error(`Pending Download Batch is missing: ${targetId}`);
      return `Remove pending Download Batch ${batch.id} containing ${batch.itemCount} source items`;
    }
    if (kind === "accept-playlist") {
      const confirmation = downloads.confirmation;
      if (!confirmation) throw new Error("There is no playlist download awaiting acceptance");
      return `Accept playlist ${confirmation.title} containing ${confirmation.itemCount} source items`;
    }
    if (kind === "delete-cache" || kind === "cleanup-cache") {
      const cache = this.currentSnapshot.state.cacheConfirmation;
      if (!cache || cache.stem !== targetId) throw new Error(`Cache Entry is not awaiting confirmation: ${targetId}`);
      return `${kind === "delete-cache" ? "Delete" : "Clean"} Cache Entry ${cache.title ?? cache.stem}${cache.stopsPlayback ? "; shared playback will stop" : ""}`;
    }
    if (kind === "quit-downloads") {
      return `Cancel ${downloads.activeBatch ? 1 : 0} active and ${downloads.pendingBatches.length} pending Download Batches`;
    }
    const playing = this.currentSnapshot.state.playback.currentTrackIdentity ? "active playback" : "no active playback";
    return `Shut down TMU Daemon with ${playing}, ${downloads.activeBatch ? 1 : 0} active and ${downloads.pendingBatches.length} pending downloads, and ${this.clients.size} connected clients`;
  }
}

class InProcessDaemonClient implements DaemonClient {
  constructor(private readonly application: InProcessDaemonApplication, readonly id: string) {}
  get snapshot() { return this.application.snapshot(); }
  get uiState(): Readonly<ClientUiState> {
    const record = this.application.record(this.id);
    return { ...record.ui.snapshot, viewedPlaylistId: record.viewedPlaylistId };
  }
  dispatchUi(action: UiStateAction): Readonly<ClientUiState> {
    const record = this.application.record(this.id);
    record.ui.dispatch(action);
    return this.uiState;
  }
  submit(command: SharedCommand) { return this.application.submit(this.id, command); }
  requestChallenge(request: { kind: ConfirmationChallenge["kind"]; targetId: string }) { return this.application.requestChallenge(this.id, request); }
  confirmChallenge(token: string) { return this.application.confirmChallenge(this.id, token); }
  cancelChallenge(token: string) { return this.application.cancelChallenge(this.id, token); }
  onSnapshot(listener: (snapshot: SharedStateSnapshot) => void) { return subscribe(this.application.record(this.id).snapshots, listener); }
  onFeedback(listener: (feedback: CommandFeedback) => void) { return subscribe(this.application.record(this.id).feedback, listener); }
  onNotice(listener: (notice: DaemonNotice) => void) { return subscribe(this.application.record(this.id).notices, listener); }
  disconnect() { this.application.disconnect(this.id); }
}

export class TuiDaemonClientAdapter implements TuiDaemonClient {
  private feedbackRevision = 0;
  private latestFeedback: AppState["operationFeedback"];
  private readonly errors: string[] = [];
  private readonly stateListeners = new Set<(reason: AppStateChangeReason) => void>();
  private readonly shutdownListeners = new Set<(message: string) => void>();
  private shutdownChallenge?: ConfirmationChallenge;
  constructor(private readonly client: DaemonClient, readonly quitIsClientOnly = true) {
    client.onSnapshot(() => this.notifyState("state"));
    client.onFeedback((feedback) => {
      this.feedbackRevision += 1;
      this.latestFeedback = {
        level: feedback.status === "success" ? "success" : "error",
        message: feedback.message, revision: this.feedbackRevision,
      };
      if (feedback.status !== "success") this.errors.splice(0, this.errors.length, feedback.message);
      this.notifyState("state");
    });
    client.onNotice((notice) => {
      this.errors.splice(0, this.errors.length, notice.message);
      this.notifyState("state");
      if (notice.message.includes("shutting down")) for (const listener of this.shutdownListeners) listener(notice.message);
    });
  }
  get appState(): AppState {
    const shared = structuredClone(this.client.snapshot.state);
    const viewed = shared.playlists.playlists.find((playlist) => playlist.id === this.client.uiState.viewedPlaylistId)
      ?? shared.playlists.playlists.find((playlist) => playlist.id === shared.playlists.playingPlaylistId)!;
    return {
      ...shared,
      providers: providerFacades(shared.providers),
      activePlaylistContent: { entries: [...viewed.entries], currentIndex: viewed.currentIndex, repeatAll: viewed.repeatAll },
      playlists: { playlists: [...shared.playlists.playlists] as AppState["playlists"]["playlists"], activePlaylistId: shared.playlists.playingPlaylistId },
      appErrors: [...this.errors].slice(-20),
      operationFeedback: this.latestFeedback,
    } as unknown as AppState;
  }
  get uiState(): Readonly<UiState> { return this.client.uiState; }
  get viewedPlaylistId(): string { return this.client.uiState.viewedPlaylistId; }
  disconnect(): void { this.client.disconnect(); }
  async dispatch(intent: AppIntent): Promise<void> {
    if (intent.type === "switchPlaylist") {
      await this.client.submit({ type: "viewPlaylist", playlistId: intent.playlistId });
    } else if (intent.type === "createPlaylist") {
      await this.client.submit({ type: "createPlaylist", name: intent.name });
    } else {
      await this.client.submit({ type: "intent", intent, playlistId: this.client.uiState.viewedPlaylistId });
    }
  }
  dispatchUi(action: UiStateAction): Readonly<UiState> { return this.client.dispatchUi(action); }
  playlistTrackIdentities(): readonly TrackIdentity[] {
    const viewedId = this.client.uiState.viewedPlaylistId;
    return this.client.snapshot.state.playlists.playlists.find((playlist) => playlist.id === viewedId)?.entries.map((entry) => entry.track.identity) ?? [];
  }
  onStateChange(listener: (reason: AppStateChangeReason) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  onDaemonShutdown(listener: (message: string) => void): () => void {
    this.shutdownListeners.add(listener);
    return () => this.shutdownListeners.delete(listener);
  }
  async enterBackgroundSounds() { await this.client.submit({ type: "background", operation: "enter" }); }
  async retryBackgroundSounds() { await this.client.submit({ type: "background", operation: "retry" }); }
  async setBackgroundSoundsEnabled(value: boolean) { await this.client.submit({ type: "background", operation: "setEnabled", value }); }
  async setBackgroundSound(id: string) { await this.client.submit({ type: "background", operation: "setSound", value: id }); }
  adjustBackgroundSoundsVolume(delta: 1 | -1) { void this.client.submit({ type: "background", operation: "adjustVolume", value: delta }); }
  async confirmProtected(kind: ConfirmationChallenge["kind"], targetId: string, _intent: AppIntent): Promise<void> {
    const challenge = await this.client.requestChallenge({ kind, targetId });
    await this.client.confirmChallenge(challenge.token);
  }
  async requestShutdownChallenge(): Promise<string> {
    this.shutdownChallenge = await this.client.requestChallenge({ kind: "shutdown-daemon", targetId: "daemon" });
    return this.shutdownChallenge.impact;
  }
  async confirmShutdown(): Promise<void> {
    const challenge = this.shutdownChallenge;
    if (!challenge) throw new Error("Shutdown Confirmation Challenge is missing");
    this.shutdownChallenge = undefined;
    await this.client.confirmChallenge(challenge.token);
  }
  async cancelShutdown(): Promise<void> {
    const challenge = this.shutdownChallenge;
    this.shutdownChallenge = undefined;
    if (challenge) await this.client.cancelChallenge(challenge.token);
  }
  private notifyState(reason: AppStateChangeReason): void {
    for (const listener of this.stateListeners) listener(reason);
  }
}

export function adaptDaemonClientForTui(client: DaemonClient): TuiDaemonClient {
  return new TuiDaemonClientAdapter(client);
}

function subscribe<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isPlaylistTargetedIntent(intent: AppIntent): boolean {
  return ["playSelected", "playNext", "playNow", "addToPlaylist", "removePlaylistTrack", "movePlaylistTrack", "clearPlaylist"].includes(intent.type)
    || (intent.type === "playerOperation" && intent.operation === "randomize-playlist");
}

function isProtectedIntent(intent: AppIntent): boolean {
  return intent.type === "deletePlaylist"
    || intent.type === "clearPlaylist"
    || (intent.type === "cacheOperation" && intent.operation === "confirm")
    || (intent.type === "downloadOperation" && ["cancel", "cancel-active", "remove-pending", "confirm-playlist", "confirm-quit"].includes(intent.operation));
}

function commandForChallenge(challenge: StoredChallenge): SharedCommand | null {
  switch (challenge.kind) {
    case "delete-playlist":
      return { type: "intent", intent: { type: "deletePlaylist", playlistId: challenge.targetId } };
    case "clear-playlist":
      return { type: "intent", playlistId: challenge.targetId, intent: { type: "clearPlaylist" } };
    case "cancel-download":
      return { type: "intent", intent: { type: "downloadOperation", operation: "cancel-active" } };
    case "remove-pending-download":
      return { type: "intent", intent: { type: "downloadOperation", operation: "remove-pending", batchId: Number(challenge.targetId) } };
    case "delete-cache":
    case "cleanup-cache":
      return { type: "intent", intent: { type: "cacheOperation", operation: "confirm" } };
    case "accept-playlist":
      return { type: "intent", intent: { type: "downloadOperation", operation: "confirm-playlist" } };
    case "quit-downloads":
      return { type: "intent", intent: { type: "downloadOperation", operation: "confirm-quit" } };
    case "shutdown-daemon":
      return null;
  }
}

function providerFacades(providers: SharedState["providers"]): AppState["providers"] {
  return Object.fromEntries(Object.entries(providers).map(([id, provider]) => {
    const tracks = provider.tracks as AppState["playlists"]["playlists"][number]["entries"][number]["track"][];
    const search = (query: string) => tracks.filter((track) => [track.title, track.artist, track.identity.stableId]
      .some((value) => value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
    const base = { id: provider.id, label: provider.label, listTracks: () => tracks, searchTracks: search,
      resolvePlaybackLocator: async () => { throw new Error("Playback locators are daemon-owned"); } };
    if (!provider.cacheEntries) return [id, base];
    const entries = provider.cacheEntries as unknown as import("./youtube-cache").YouTubeCacheEntry[];
    const incomplete = (provider.incompleteEntries ?? []) as unknown as import("./youtube-cache").IncompleteYouTubeCacheEntry[];
    return [id, { ...base,
      refresh: () => undefined, listCacheEntries: () => entries, listIncompleteEntries: () => incomplete,
      findByIdentity: (identity: TrackIdentity) => entries.find((entry) => entry.track.identity.providerId === identity.providerId && entry.track.identity.stableId === identity.stableId),
      renameTrack: async () => { throw new Error("Cache mutations are daemon-owned"); },
      deleteCacheEntry: async () => { throw new Error("Cache mutations are daemon-owned"); },
      cleanupIncompleteEntry: async () => { throw new Error("Cache mutations are daemon-owned"); },
    }];
  }));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
