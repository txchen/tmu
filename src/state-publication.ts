import type { AppState, Track, UiState } from "./domain";
import type { IncompleteYouTubeCacheEntry, YouTubeCacheEntry } from "./youtube-cache";

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ProviderStateSnapshot = {
  readonly id: string;
  readonly label: string;
  readonly tracks: readonly DeepReadonly<Track>[];
  readonly cacheEntries?: readonly DeepReadonly<YouTubeCacheEntry>[];
  readonly incompleteEntries?: readonly DeepReadonly<IncompleteYouTubeCacheEntry>[];
};

export type AppStateSnapshot = DeepReadonly<Omit<AppState, "providers">> & {
  readonly providers: Readonly<Record<string, ProviderStateSnapshot>>;
};

export type PublicationSnapshot = {
  readonly appState: AppStateSnapshot;
  readonly uiState: DeepReadonly<UiState>;
};

export type PublicationCause = "input" | "resize" | "playback" | "error" | "state";

export type PublicationCadence = {
  /** Null keeps playback-position-only changes out of the reactive view. */
  playbackCadenceMs: number | null;
  downloadProgressMs: number;
  providerProgressMs: number;
};

export type PublicationTimers = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
};

export type StatePublicationGateOptions = {
  readState(): { appState: AppState; uiState: UiState };
  cadence: PublicationCadence;
  timers?: Partial<PublicationTimers>;
};

type ProgressKind = "playback" | "download" | "provider";

type PendingPublication = {
  timer: unknown;
  dueAt: number;
};

type SemanticFingerprint = {
  full: string;
  withoutPlaybackPosition: string;
  playbackPosition: string;
  withoutDownloadProgress: string;
  downloadProgress: string;
  withoutProviderProgress: string;
  providerProgress: string;
};

const MIN_PUBLICATION_CADENCE_MS = 500;

export function selectAppStateSnapshot(appState: AppState): AppStateSnapshot {
  const { providers, ...serializableState } = appState;
  const snapshot = {
    ...structuredClone(serializableState),
    providers: Object.fromEntries(
      Object.entries(providers).map(([providerId, provider]) => {
        const cache = provider as Partial<import("./youtube-cache").YouTubeCacheProvider>;
        return [providerId, {
          id: provider.id, label: provider.label, tracks: structuredClone(provider.listTracks()),
          ...(typeof cache.listCacheEntries === "function" ? { cacheEntries: structuredClone(cache.listCacheEntries()) } : {}),
          ...(typeof cache.listIncompleteEntries === "function" ? { incompleteEntries: structuredClone(cache.listIncompleteEntries()) } : {}),
        }];
      }),
    ),
  } as AppStateSnapshot;
  return deepFreeze(snapshot);
}

export function selectUiStateSnapshot(uiState: UiState): DeepReadonly<UiState> {
  return deepFreeze(structuredClone(uiState));
}

export function selectPublicationSnapshot(
  appState: AppState,
  uiState: UiState,
): PublicationSnapshot {
  return deepFreeze({
    appState: selectAppStateSnapshot(appState),
    uiState: selectUiStateSnapshot(uiState),
  });
}

/**
 * Converts mutable application services into immutable, semantic view data.
 * It schedules only trailing work in response to observed changes; it never
 * creates an idle loop or a recurring playback timer.
 */
export class StatePublicationGate {
  private readonly readState: StatePublicationGateOptions["readState"];
  private readonly cadence: Record<ProgressKind, number | null>;
  private readonly timers: PublicationTimers;
  private readonly listeners = new Set<(snapshot: PublicationSnapshot) => void>();
  private readonly pending: Partial<Record<ProgressKind, PendingPublication>> = {};
  private latestSnapshot: PublicationSnapshot | null = null;
  private latestFingerprint: SemanticFingerprint | null = null;
  private observedFingerprint: SemanticFingerprint | null = null;
  private lastPublishedAt: Record<ProgressKind, number | null> = {
    playback: null,
    download: null,
    provider: null,
  };

  constructor(options: StatePublicationGateOptions) {
    const customTimers = options.timers;
    this.readState = options.readState;
    this.cadence = {
      playback: options.cadence.playbackCadenceMs === null
        ? null
        : normalizeCadence(options.cadence.playbackCadenceMs),
      download: normalizeCadence(options.cadence.downloadProgressMs),
      provider: normalizeCadence(options.cadence.providerProgressMs),
    };
    this.timers = {
      now: () => customTimers?.now?.() ?? Date.now(),
      setTimeout: (callback, delayMs) => customTimers?.setTimeout
        ? customTimers.setTimeout(callback, delayMs)
        : setTimeout(callback, delayMs),
      clearTimeout: (timer) => {
        if (customTimers?.clearTimeout) customTimers.clearTimeout(timer);
        else clearTimeout(timer as ReturnType<typeof setTimeout>);
      },
    };
  }

  get snapshot(): PublicationSnapshot | null {
    return this.latestSnapshot;
  }

  subscribe(listener: (snapshot: PublicationSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishInitial(): PublicationSnapshot {
    const snapshot = this.capture();
    const semanticFingerprint = fingerprint(snapshot);
    if (semanticFingerprint.full !== this.latestFingerprint?.full) {
      this.publish(snapshot, semanticFingerprint);
    }
    return this.latestSnapshot ?? snapshot;
  }

  notify(cause: PublicationCause = "state"): void {
    const candidate = this.capture();
    const candidateFingerprint = fingerprint(candidate);
    const previousFingerprint = this.observedFingerprint;
    this.observedFingerprint = candidateFingerprint;

    if (cause === "input") {
      if (candidateFingerprint.full !== this.latestFingerprint?.full) {
        this.publish(candidate, candidateFingerprint);
      }
      return;
    }
    if (!previousFingerprint) {
      this.publish(candidate, candidateFingerprint);
      return;
    }
    if (previousFingerprint.full === candidateFingerprint.full) return;
    if (cause === "error") {
      this.publish(candidate, candidateFingerprint);
      return;
    }

    const progressKind = progressOnlyChange(previousFingerprint, candidateFingerprint);
    if (!progressKind) {
      this.publish(candidate, candidateFingerprint);
      return;
    }
    if (progressKind === "playback" && this.cadence.playback === null) return;

    this.schedule(progressKind);
  }

  stop(): void {
    for (const kind of ["playback", "download", "provider"] as const) {
      this.clearPending(kind);
    }
  }

  private capture(): PublicationSnapshot {
    const { appState, uiState } = this.readState();
    return selectPublicationSnapshot(appState, uiState);
  }

  private schedule(kind: ProgressKind): void {
    const cadence = this.cadence[kind];
    if (cadence === null) return;
    const now = this.timers.now();
    const lastPublishedAt = this.lastPublishedAt[kind];
    const delay = lastPublishedAt === null
      ? 0
      : Math.max(0, cadence - (now - lastPublishedAt));

    if (delay === 0) {
      this.publishLatestIfChanged();
      return;
    }

    const dueAt = now + delay;
    const pending = this.pending[kind];
    if (pending && pending.dueAt <= dueAt) return;
    this.clearPending(kind);
    this.pending[kind] = {
      dueAt,
      timer: this.timers.setTimeout(() => {
        delete this.pending[kind];
        this.publishLatestIfChanged();
      }, delay),
    };
  }

  private publishLatestIfChanged(): void {
    const candidate = this.capture();
    const candidateFingerprint = fingerprint(candidate);
    if (candidateFingerprint.full === this.latestFingerprint?.full) return;
    this.publish(candidate, candidateFingerprint);
  }

  private publish(
    snapshot: PublicationSnapshot,
    semanticFingerprint = fingerprint(snapshot),
  ): void {
    for (const kind of ["playback", "download", "provider"] as const) {
      this.clearPending(kind);
    }
    this.latestSnapshot = snapshot;
    this.latestFingerprint = semanticFingerprint;
    this.observedFingerprint = semanticFingerprint;
    const now = this.timers.now();
    this.lastPublishedAt = { playback: now, download: now, provider: now };
    for (const listener of this.listeners) listener(snapshot);
  }

  private clearPending(kind: ProgressKind): void {
    const pending = this.pending[kind];
    if (!pending) return;
    this.timers.clearTimeout(pending.timer);
    delete this.pending[kind];
  }
}

function fingerprint(snapshot: PublicationSnapshot): SemanticFingerprint {
  const { appState, uiState } = snapshot;
  const withoutPlaybackPosition = {
    ...appState,
    playback: { ...appState.playback, positionSeconds: undefined },
  };
  const withoutDownloadProgress = {
    ...appState,
    downloads: { ...appState.downloads, lines: [] },
    lastEvent: undefined,
  };
  const withoutProviderProgress = {
    ...appState,
    providers: providersWithoutDisplayMetadata(appState.providers),
    activePlaylistContent: playlistWithoutDisplayMetadata(appState.activePlaylistContent),
    lastEvent: undefined,
  };

  return {
    full: JSON.stringify(snapshot),
    withoutPlaybackPosition: JSON.stringify({ appState: withoutPlaybackPosition, uiState }),
    playbackPosition: JSON.stringify(appState.playback.positionSeconds),
    withoutDownloadProgress: JSON.stringify({ appState: withoutDownloadProgress, uiState }),
    downloadProgress: JSON.stringify({ downloads: appState.downloads, lastEvent: appState.lastEvent }),
    withoutProviderProgress: JSON.stringify({ appState: withoutProviderProgress, uiState }),
    providerProgress: JSON.stringify({
      providers: providerDisplayMetadata(appState.providers),
      activePlaylistContent: playlistDisplayMetadata(appState.activePlaylistContent),
      lastEvent: appState.lastEvent,
    }),
  };
}

function progressOnlyChange(
  previous: SemanticFingerprint,
  next: SemanticFingerprint,
): ProgressKind | null {
  if (
    previous.withoutPlaybackPosition === next.withoutPlaybackPosition
    && previous.playbackPosition !== next.playbackPosition
  ) return "playback";
  if (
    previous.withoutDownloadProgress === next.withoutDownloadProgress
    && previous.downloadProgress !== next.downloadProgress
  ) return "download";
  if (
    previous.withoutProviderProgress === next.withoutProviderProgress
    && previous.providerProgress !== next.providerProgress
  ) return "provider";
  return null;
}

function providersWithoutDisplayMetadata(providers: AppStateSnapshot["providers"]) {
  return Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id, {
    id: provider.id,
    label: provider.label,
    tracks: provider.tracks.map((track) => ({ identity: track.identity })),
  }]));
}

function providerDisplayMetadata(providers: AppStateSnapshot["providers"]) {
  return Object.fromEntries(Object.entries(providers).map(([id, provider]) => [id,
    provider.tracks.map(({ identity: _identity, ...display }) => display),
  ]));
}

function playlistWithoutDisplayMetadata(playlist: AppStateSnapshot["activePlaylistContent"]) {
  return {
    ...playlist,
    entries: playlist.entries.map((entry) => ({
      identity: entry.track.identity,
      availability: entry.availability,
    })),
  };
}

function playlistDisplayMetadata(playlist: AppStateSnapshot["activePlaylistContent"]) {
  return playlist.entries.map(({ track }) => {
    const { identity: _identity, ...display } = track;
    return display;
  });
}

function normalizeCadence(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.max(MIN_PUBLICATION_CADENCE_MS, Math.round(value))
    : MIN_PUBLICATION_CADENCE_MS;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
