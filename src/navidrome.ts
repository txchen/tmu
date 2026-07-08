import { createHash, randomBytes } from "node:crypto";
import type { TmuConfig } from "./config";
import type { PlaybackLocator, Provider, Track, TrackIdentity } from "./domain";

const NAVIDROME_PROVIDER_ID = "navidrome";
const SUBSONIC_RESPONSE_KEY = "subsonic-response";
const AUTH_ERROR_CODES = new Set([40, 41]);

export type NavidromeConfig = TmuConfig["providers"]["navidrome"];

export type NavidromeFetcher = (url: URL) => Promise<Response>;

export type NavidromeConnectionState =
  | { status: "missing-config"; message: string; missingFields: string[] }
  | { status: "checking"; message: string }
  | { status: "connected"; message: string; serverUrl: string }
  | { status: "auth-failure"; message: string }
  | { status: "api-failure"; message: string };

export type NavidromeArtist = {
  id: string;
  name: string;
  albumCount?: number;
  coverArtId?: string;
};

export type NavidromeAlbum = {
  id: string;
  name: string;
  artist?: string;
  trackCount?: number;
  coverArtId?: string;
};

export type NavidromeLibraryBrowserEntry =
  | { kind: "artists-root"; label: string; depth: 0 }
  | { kind: "artist"; id: string; label: string; albumCount?: number; coverArtId?: string; depth: 1 }
  | {
    kind: "album";
    id: string;
    artistId: string;
    label: string;
    artist?: string;
    trackCount?: number;
    coverArtId?: string;
    depth: 2;
  }
  | {
    kind: "track";
    id: string;
    artistId: string;
    albumId: string;
    label: string;
    track: Track;
    coverArtId?: string;
    depth: 3;
  }
  | { kind: "load-more-albums"; artistId: string; label: string; depth: 2 }
  | { kind: "load-more-tracks"; artistId: string; albumId: string; label: string; depth: 3 };

export type NavidromeProvider = Provider & {
  getConnectionState(): NavidromeConnectionState;
  getLibraryBrowserEntries(): readonly NavidromeLibraryBrowserEntry[];
  validateConnection(): Promise<NavidromeConnectionState>;
  listArtists(): Promise<readonly NavidromeArtist[]>;
  refreshArtists(): Promise<readonly NavidromeArtist[]>;
  listArtistAlbums(artistId: string): Promise<readonly NavidromeAlbum[]>;
  listAlbumTracks(albumId: string): Promise<readonly Track[]>;
  openLibraryBrowserEntry(entry: NavidromeLibraryBrowserEntry): Promise<void>;
  refreshLibraryBrowser(): Promise<void>;
  trackForLibraryBrowserEntry(entry: NavidromeLibraryBrowserEntry): Track | undefined;
};

export type NavidromeProviderOptions = {
  config: NavidromeConfig;
  fetcher?: NavidromeFetcher;
  saltFactory?: () => string;
  pageSize?: number;
};

type SubsonicEnvelope<T extends Record<string, unknown> = Record<string, unknown>> = {
  status?: unknown;
  version?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
  };
} & T;

type SubsonicResponsePayload<T extends Record<string, unknown> = Record<string, unknown>> = {
  [SUBSONIC_RESPONSE_KEY]?: SubsonicEnvelope<T>;
};

type NavidromeRequestKind = "auth" | "api";

export class NavidromeApiError extends Error {
  readonly kind: NavidromeRequestKind;
  readonly code?: number;

  constructor(kind: NavidromeRequestKind, message: string, options: { code?: number; cause?: unknown } = {}) {
    super(message);
    this.name = "NavidromeApiError";
    this.kind = kind;
    this.code = options.code;
    this.cause = options.cause;
  }
}

export function createNavidromeProvider(options: NavidromeProviderOptions): NavidromeProvider {
  return new SubsonicNavidromeProvider(options);
}

export function isNavidromeProvider(provider: Provider | undefined): provider is NavidromeProvider {
  return Boolean(provider)
    && typeof (provider as Partial<NavidromeProvider>).getConnectionState === "function"
    && typeof (provider as Partial<NavidromeProvider>).getLibraryBrowserEntries === "function"
    && typeof (provider as Partial<NavidromeProvider>).validateConnection === "function"
    && typeof (provider as Partial<NavidromeProvider>).listArtists === "function"
    && typeof (provider as Partial<NavidromeProvider>).refreshArtists === "function"
    && typeof (provider as Partial<NavidromeProvider>).listArtistAlbums === "function"
    && typeof (provider as Partial<NavidromeProvider>).listAlbumTracks === "function"
    && typeof (provider as Partial<NavidromeProvider>).openLibraryBrowserEntry === "function"
    && typeof (provider as Partial<NavidromeProvider>).refreshLibraryBrowser === "function"
    && typeof (provider as Partial<NavidromeProvider>).trackForLibraryBrowserEntry === "function";
}

export function navidromeServerId(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return String(value);
  return value == null ? "" : String(value);
}

export function navidromeConnectionStateLine(state: NavidromeConnectionState): string {
  switch (state.status) {
    case "connected":
      return `Navidrome: connected to ${state.serverUrl}; Library Browser ready`;
    case "checking":
      return `Navidrome: ${state.message}`;
    case "missing-config":
      return `! Navidrome missing config: ${state.message}`;
    case "auth-failure":
      return `! Navidrome auth failed: ${state.message}`;
    case "api-failure":
      return `! Navidrome API failed: ${state.message}`;
  }
}

class SubsonicNavidromeProvider implements NavidromeProvider {
  readonly id = NAVIDROME_PROVIDER_ID;
  readonly label = "Navidrome";
  readonly hint = "artists, albums, playlists";

  private readonly config: NavidromeConfig;
  private readonly fetcher: NavidromeFetcher;
  private readonly saltFactory: () => string;
  private readonly pageSize: number;
  private connectionState: NavidromeConnectionState;
  private artists: NavidromeArtist[] | null = null;
  private expandedArtistId: string | null = null;
  private expandedAlbumId: string | null = null;
  private readonly artistAlbums = new Map<string, NavidromeAlbum[]>();
  private readonly albumTracks = new Map<string, Track[]>();
  private readonly albumVisibleCounts = new Map<string, number>();
  private readonly trackVisibleCounts = new Map<string, number>();

  constructor(options: NavidromeProviderOptions) {
    this.config = options.config;
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.saltFactory = options.saltFactory ?? defaultSalt;
    this.pageSize = normalizePageSize(options.pageSize);
    this.connectionState = missingConfigState(this.config) ?? {
      status: "checking",
      message: "connection not validated",
    };
  }

  listVisibleTracks(): readonly Track[] {
    return [];
  }

  async resolvePlaybackLocator(identity: TrackIdentity): Promise<PlaybackLocator> {
    if (identity.providerId !== NAVIDROME_PROVIDER_ID) {
      throw new Error(`Navidrome Provider cannot resolve ${identity.providerId}`);
    }

    const missing = missingConfigState(this.config);
    if (missing) throw new Error(missing.message);

    const trackId = this.trackIdFromIdentity(identity);
    if (!trackId) {
      throw new Error("Navidrome Track Identity does not match this server");
    }

    const auth = authParameters(this.config, this.saltFactory);
    const url = this.buildUrl("stream", { id: trackId }, auth);
    return { kind: "url", url: url.toString() };
  }

  getConnectionState(): NavidromeConnectionState {
    return this.connectionState;
  }

  getLibraryBrowserEntries(): readonly NavidromeLibraryBrowserEntry[] {
    if (this.connectionState.status !== "connected") return [];

    const entries: NavidromeLibraryBrowserEntry[] = [
      { kind: "artists-root", label: "Artists", depth: 0 },
    ];

    for (const artist of this.artists ?? []) {
      entries.push({
        kind: "artist",
        id: artist.id,
        label: artist.name,
        albumCount: artist.albumCount,
        coverArtId: artist.coverArtId,
        depth: 1,
      });

      if (this.expandedArtistId !== artist.id) continue;

      const albums = this.artistAlbums.get(artist.id) ?? [];
      const visibleAlbumCount = Math.min(this.albumVisibleCounts.get(artist.id) ?? this.pageSize, albums.length);
      for (const album of albums.slice(0, visibleAlbumCount)) {
        entries.push({
          kind: "album",
          id: album.id,
          artistId: artist.id,
          label: album.name,
          artist: album.artist,
          trackCount: album.trackCount,
          coverArtId: album.coverArtId,
          depth: 2,
        });

        if (this.expandedAlbumId !== album.id) continue;

        const tracks = this.albumTracks.get(album.id) ?? [];
        const visibleTrackCount = Math.min(this.trackVisibleCounts.get(album.id) ?? this.pageSize, tracks.length);
        for (const track of tracks.slice(0, visibleTrackCount)) {
          entries.push({
            kind: "track",
            id: this.trackIdFromIdentity(track.identity) ?? track.identity.stableId,
            artistId: artist.id,
            albumId: album.id,
            label: track.title,
            track,
            coverArtId: track.coverArtId,
            depth: 3,
          });
        }

        if (visibleTrackCount < tracks.length) {
          entries.push({
            kind: "load-more-tracks",
            artistId: artist.id,
            albumId: album.id,
            label: "Load more tracks",
            depth: 3,
          });
        }
      }

      if (visibleAlbumCount < albums.length) {
        entries.push({
          kind: "load-more-albums",
          artistId: artist.id,
          label: "Load more albums",
          depth: 2,
        });
      }
    }

    return entries;
  }

  async validateConnection(): Promise<NavidromeConnectionState> {
    const missing = missingConfigState(this.config);
    if (missing) {
      this.connectionState = missing;
      return this.connectionState;
    }

    this.connectionState = {
      status: "checking",
      message: "validating connection with ping",
    };

    try {
      await this.requestSubsonic("ping");
      this.connectionState = {
        status: "connected",
        serverUrl: normalizedServerUrl(this.config.serverUrl),
        message: "ping succeeded",
      };
    } catch (error) {
      const apiError = toNavidromeApiError(error, this.config);
      this.connectionState = failedConnectionState(apiError);
    }

    return this.connectionState;
  }

  async listArtists(): Promise<readonly NavidromeArtist[]> {
    if (this.artists) return this.artists;

    try {
      const response = await this.requestSubsonic<{ artists?: unknown }>("getArtists");
      this.artists = parseArtists(response.artists);
      return this.artists;
    } catch (error) {
      const apiError = toNavidromeApiError(error, this.config);
      this.connectionState = failedConnectionState(apiError);
      throw apiError;
    }
  }

  async refreshArtists(): Promise<readonly NavidromeArtist[]> {
    this.artists = null;
    this.expandedArtistId = null;
    this.expandedAlbumId = null;
    this.artistAlbums.clear();
    this.albumTracks.clear();
    this.albumVisibleCounts.clear();
    this.trackVisibleCounts.clear();
    return await this.listArtists();
  }

  async listArtistAlbums(artistId: string): Promise<readonly NavidromeAlbum[]> {
    const cached = this.artistAlbums.get(artistId);
    if (cached) return cached;

    try {
      const response = await this.requestSubsonic<{ artist?: unknown }>("getArtist", { id: artistId });
      const albums = parseAlbums(response.artist);
      this.artistAlbums.set(artistId, albums);
      this.albumVisibleCounts.set(artistId, Math.min(this.pageSize, albums.length));
      return albums;
    } catch (error) {
      const apiError = toNavidromeApiError(error, this.config);
      this.connectionState = failedConnectionState(apiError);
      throw apiError;
    }
  }

  async listAlbumTracks(albumId: string): Promise<readonly Track[]> {
    const cached = this.albumTracks.get(albumId);
    if (cached) return cached;

    try {
      const response = await this.requestSubsonic<{ album?: unknown }>("getAlbum", { id: albumId });
      const tracks = parseTracks(response.album, normalizedServerUrl(this.config.serverUrl));
      this.albumTracks.set(albumId, tracks);
      this.trackVisibleCounts.set(albumId, Math.min(this.pageSize, tracks.length));
      return tracks;
    } catch (error) {
      const apiError = toNavidromeApiError(error, this.config);
      this.connectionState = failedConnectionState(apiError);
      throw apiError;
    }
  }

  async openLibraryBrowserEntry(entry: NavidromeLibraryBrowserEntry): Promise<void> {
    switch (entry.kind) {
      case "artists-root":
        await this.listArtists();
        this.expandedArtistId = null;
        this.expandedAlbumId = null;
        return;
      case "artist":
        this.expandedArtistId = entry.id;
        this.expandedAlbumId = null;
        await this.listArtistAlbums(entry.id);
        return;
      case "album":
        this.expandedArtistId = entry.artistId;
        this.expandedAlbumId = entry.id;
        await this.listAlbumTracks(entry.id);
        return;
      case "load-more-albums": {
        const albums = await this.listArtistAlbums(entry.artistId);
        const current = this.albumVisibleCounts.get(entry.artistId) ?? this.pageSize;
        this.albumVisibleCounts.set(entry.artistId, Math.min(current + this.pageSize, albums.length));
        return;
      }
      case "load-more-tracks": {
        const tracks = await this.listAlbumTracks(entry.albumId);
        const current = this.trackVisibleCounts.get(entry.albumId) ?? this.pageSize;
        this.trackVisibleCounts.set(entry.albumId, Math.min(current + this.pageSize, tracks.length));
        return;
      }
      case "track":
        return;
    }
  }

  async refreshLibraryBrowser(): Promise<void> {
    await this.refreshArtists();
  }

  trackForLibraryBrowserEntry(entry: NavidromeLibraryBrowserEntry): Track | undefined {
    return entry.kind === "track" ? entry.track : undefined;
  }

  private trackIdFromIdentity(identity: TrackIdentity): string | undefined {
    const prefix = `${this.label}:${normalizedServerUrl(this.config.serverUrl)}:track:`;
    if (!identity.stableId.startsWith(prefix)) return undefined;
    return identity.stableId.slice(prefix.length);
  }

  private async requestSubsonic<T extends Record<string, unknown> = Record<string, unknown>>(
    endpoint: string,
    params: Record<string, string> = {},
  ): Promise<SubsonicEnvelope<T>> {
    const missing = missingConfigState(this.config);
    if (missing) {
      throw new NavidromeApiError("api", missing.message);
    }

    const auth = authParameters(this.config, this.saltFactory);
    const url = this.buildUrl(endpoint, params, auth);
    const redactRequestSecrets = (text: string) => redactNavidromeSecretText(text, this.config, [auth.t, auth.s]);
    let response: Response;
    try {
      response = await this.fetcher(url);
    } catch (error) {
      throw new NavidromeApiError(
        "api",
        redactRequestSecrets(`request failed for ${endpoint}: ${errorMessage(error)}`),
        { cause: error },
      );
    }

    if (!response.ok) {
      throw new NavidromeApiError(
        "api",
        `HTTP ${response.status} ${response.statusText || "response"} from ${endpoint}`,
      );
    }

    let parsed: SubsonicResponsePayload<T>;
    try {
      parsed = await response.json() as SubsonicResponsePayload<T>;
    } catch (error) {
      throw new NavidromeApiError("api", `invalid JSON response from ${endpoint}`, { cause: error });
    }

    const subsonic = parsed[SUBSONIC_RESPONSE_KEY];
    if (!subsonic) {
      throw new NavidromeApiError("api", `missing ${SUBSONIC_RESPONSE_KEY} payload from ${endpoint}`);
    }

    if (subsonic.status !== "ok") {
      const code = numberValue(subsonic.error?.code);
      const rawMessage = typeof subsonic.error?.message === "string" && subsonic.error.message.trim()
        ? subsonic.error.message.trim()
        : `Subsonic ${endpoint} failed`;
      const message = redactRequestSecrets(code === undefined ? rawMessage : `${rawMessage} (code ${code})`);
      throw new NavidromeApiError(AUTH_ERROR_CODES.has(code ?? -1) ? "auth" : "api", message, { code });
    }

    return subsonic;
  }

  private buildUrl(endpoint: string, params: Record<string, string>, auth: Record<string, string>): URL {
    const url = new URL(`rest/${endpoint}.view`, withTrailingSlash(normalizedServerUrl(this.config.serverUrl)));
    for (const [key, value] of Object.entries({ ...params, ...auth })) {
      url.searchParams.set(key, value);
    }
    return url;
  }
}

export function authParameters(config: NavidromeConfig, saltFactory: () => string = defaultSalt): Record<string, string> {
  const salt = config.token && config.salt ? config.salt : config.salt || saltFactory();
  const token = config.token && config.salt ? config.token : md5(`${config.password ?? ""}${salt}`);

  return {
    u: config.username,
    t: token,
    s: salt,
    v: config.apiVersion,
    c: config.clientName,
    f: "json",
  };
}

export function redactNavidromeSecretText(
  text: string,
  config: NavidromeConfig,
  additionalSecrets: readonly string[] = [],
): string {
  return [config.password, config.token, config.salt, ...additionalSecrets]
    .filter((value): value is string => Boolean(value))
    .flatMap((secret) => [secret, encodeURIComponent(secret)])
    .reduce((redacted, secret) => redacted.split(secret).join("[redacted]"), text);
}

function parseArtists(value: unknown): NavidromeArtist[] {
  if (!isRecord(value)) return [];
  const indexes = Array.isArray(value.index) ? value.index : [];
  const artists: NavidromeArtist[] = [];

  for (const index of indexes) {
    if (!isRecord(index) || !Array.isArray(index.artist)) continue;

    for (const artist of index.artist) {
      if (!isRecord(artist)) continue;
      const id = navidromeServerId(artist.id);
      const name = stringValue(artist.name);
      if (!id || !name) continue;

      artists.push({
        id,
        name,
        albumCount: numberValue(artist.albumCount),
        coverArtId: artist.coverArt === undefined ? undefined : navidromeServerId(artist.coverArt),
      });
    }
  }

  return artists;
}

function parseAlbums(value: unknown): NavidromeAlbum[] {
  if (!isRecord(value)) return [];
  const rawAlbums = Array.isArray(value.album) ? value.album : [];
  const albums: NavidromeAlbum[] = [];

  for (const album of rawAlbums) {
    if (!isRecord(album)) continue;
    const id = navidromeServerId(album.id);
    const name = stringValue(album.name) ?? stringValue(album.title);
    if (!id || !name) continue;

    albums.push({
      id,
      name,
      artist: stringValue(album.artist),
      trackCount: numberValue(album.songCount),
      coverArtId: album.coverArt === undefined ? undefined : navidromeServerId(album.coverArt),
    });
  }

  return albums;
}

function parseTracks(value: unknown, serverUrl: string): Track[] {
  if (!isRecord(value)) return [];
  const rawTracks = Array.isArray(value.song)
    ? value.song
    : Array.isArray(value.child)
      ? value.child
      : [];
  const albumName = stringValue(value.name) ?? stringValue(value.title);
  const albumArtist = stringValue(value.artist);
  const tracks: Track[] = [];

  for (const rawTrack of rawTracks) {
    if (!isRecord(rawTrack)) continue;
    const id = navidromeServerId(rawTrack.id);
    const title = stringValue(rawTrack.title) ?? stringValue(rawTrack.name) ?? id;
    if (!id || !title) continue;

    const track: Track = {
      identity: {
        providerId: NAVIDROME_PROVIDER_ID,
        stableId: navidromeTrackStableId(serverUrl, id),
      },
      title,
      providerLabel: "Navidrome",
    };
    const artist = stringValue(rawTrack.artist) ?? albumArtist;
    const album = stringValue(rawTrack.album) ?? albumName;
    const durationSeconds = numberValue(rawTrack.duration);
    if (artist !== undefined) track.artist = artist;
    if (album !== undefined) track.album = album;
    if (durationSeconds !== undefined) track.durationSeconds = durationSeconds;
    if (rawTrack.coverArt !== undefined) track.coverArtId = navidromeServerId(rawTrack.coverArt);
    tracks.push(track);
  }

  return tracks;
}

function navidromeTrackStableId(serverUrl: string, trackId: string): string {
  return `Navidrome:${serverUrl}:track:${trackId}`;
}

function normalizePageSize(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return 50;
  return Math.max(1, Math.floor(value));
}

function missingConfigState(config: NavidromeConfig): NavidromeConnectionState | null {
  const missingFields: string[] = [];
  if (!config.enabled) missingFields.push("enabled");
  if (!config.serverUrl.trim()) missingFields.push("server URL");
  if (!config.username.trim()) missingFields.push("username");
  if (!hasPasswordMaterial(config)) missingFields.push("password or token+salt");
  if (!config.clientName.trim()) missingFields.push("client name");
  if (!config.apiVersion.trim()) missingFields.push("API version");

  if (missingFields.length === 0) return null;

  return {
    status: "missing-config",
    missingFields,
    message: `set ${missingFields.join(", ")}`,
  };
}

function hasPasswordMaterial(config: NavidromeConfig): boolean {
  if (config.password && config.password.trim()) return true;
  return Boolean(config.token?.trim() && config.salt?.trim());
}

function toNavidromeApiError(error: unknown, config: NavidromeConfig): NavidromeApiError {
  if (error instanceof NavidromeApiError) {
    return new NavidromeApiError(error.kind, redactNavidromeSecretText(error.message, config), {
      code: error.code,
      cause: error.cause,
    });
  }

  return new NavidromeApiError("api", redactNavidromeSecretText(errorMessage(error), config), { cause: error });
}

function failedConnectionState(error: NavidromeApiError): NavidromeConnectionState {
  return error.kind === "auth"
    ? { status: "auth-failure", message: error.message }
    : { status: "api-failure", message: error.message };
}

function normalizedServerUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function defaultSalt(): string {
  return randomBytes(8).toString("hex");
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

async function defaultFetcher(url: URL): Promise<Response> {
  return await fetch(url);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}
