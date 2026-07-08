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

export type NavidromeLibraryBrowserEntry =
  | { kind: "artists-root"; label: string; depth: 0 }
  | { kind: "artist"; id: string; label: string; albumCount?: number; depth: 1 };

export type NavidromeProvider = Provider & {
  getConnectionState(): NavidromeConnectionState;
  getLibraryBrowserEntries(): readonly NavidromeLibraryBrowserEntry[];
  validateConnection(): Promise<NavidromeConnectionState>;
  listArtists(): Promise<readonly NavidromeArtist[]>;
};

export type NavidromeProviderOptions = {
  config: NavidromeConfig;
  fetcher?: NavidromeFetcher;
  saltFactory?: () => string;
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
    && typeof (provider as Partial<NavidromeProvider>).listArtists === "function";
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
  private connectionState: NavidromeConnectionState;
  private artists: NavidromeArtist[] | null = null;

  constructor(options: NavidromeProviderOptions) {
    this.config = options.config;
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.saltFactory = options.saltFactory ?? defaultSalt;
    this.connectionState = missingConfigState(this.config) ?? {
      status: "checking",
      message: "connection not validated",
    };
  }

  listVisibleTracks(): readonly Track[] {
    return [];
  }

  async resolvePlaybackLocator(_identity: TrackIdentity): Promise<PlaybackLocator> {
    throw new Error("Navidrome playback is not available until the artist/album playback slice");
  }

  getConnectionState(): NavidromeConnectionState {
    return this.connectionState;
  }

  getLibraryBrowserEntries(): readonly NavidromeLibraryBrowserEntry[] {
    if (this.connectionState.status !== "connected") return [];

    return [
      { kind: "artists-root", label: "Artists", depth: 0 },
      ...(this.artists ?? []).map((artist): NavidromeLibraryBrowserEntry => ({
        kind: "artist",
        id: artist.id,
        label: artist.name,
        albumCount: artist.albumCount,
        depth: 1,
      })),
    ];
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
