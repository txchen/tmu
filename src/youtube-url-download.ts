import { OFFLINE_YOUTUBE_CACHE_PROVIDER_ID } from "./offline-youtube-cache";
import type {
  DependencyCommandRequest,
  DependencyCommandResult,
  DependencyCommandRunner,
} from "./dependencies";
import { nodeDependencyCommandRunner } from "./dependencies";
import type { TrackIdentity } from "./domain";

export type YouTubeUrlValidationResult =
  | { ok: true; url: string }
  | { ok: false; message: string };

export type IdentifiedYouTubeMetadata = {
  extractor: string;
  id: string;
  title: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
};

export type YouTubeIdentifyResult =
  | {
    ok: true;
    identity: TrackIdentity;
    metadata: IdentifiedYouTubeMetadata;
  }
  | { ok: false; message: string };

export type YouTubeIdentifyOptions = {
  command: string;
  timeoutMs: number;
  runner?: DependencyCommandRunner;
  cookiesFromBrowser?: string;
};

type YtDlpInfoJson = {
  extractor_key?: unknown;
  extractor?: unknown;
  id?: unknown;
  title?: unknown;
  artist?: unknown;
  uploader?: unknown;
  channel?: unknown;
  album?: unknown;
  duration?: unknown;
  is_live?: unknown;
  live_status?: unknown;
  _type?: unknown;
};

export function validateYouTubeUrlDownloadInput(input: string): YouTubeUrlValidationResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, message: "YouTube URL Download accepts a direct YouTube or YouTube Music URL" };
  }

  if (/^ytsearch(?:\d+|all|date)?:/i.test(trimmed)) {
    return { ok: false, message: "YouTube URL Download rejects ytsearch inputs; paste a direct YouTube or YouTube Music URL" };
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: "YouTube URL Download accepts direct YouTube or YouTube Music URLs, not search text" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "YouTube URL Download accepts direct YouTube or YouTube Music URLs" };
  }

  const host = normalizedHost(url.hostname);
  if (!isYouTubeHost(host)) {
    return { ok: false, message: "YouTube URL Download rejects non-YouTube sites" };
  }

  if (url.searchParams.has("list") || url.pathname === "/playlist") {
    return { ok: false, message: "YouTube URL Download rejects playlist URLs" };
  }

  if (url.pathname === "/results" || url.searchParams.has("search_query")) {
    return { ok: false, message: "YouTube URL Download rejects search URLs" };
  }

  if (isLivePath(url.pathname)) {
    return { ok: false, message: "YouTube URL Download rejects live streams" };
  }

  const accountLibraryMessage = accountLibraryRejection(url.pathname);
  if (accountLibraryMessage) return { ok: false, message: accountLibraryMessage };

  if (host === "youtu.be") {
    return firstPathSegment(url.pathname)
      ? { ok: true, url: url.toString() }
      : { ok: false, message: "YouTube URL Download accepts direct YouTube or YouTube Music URLs" };
  }

  if (url.pathname === "/watch" && nonEmptyQueryValue(url.searchParams.get("v"))) {
    return { ok: true, url: url.toString() };
  }

  if (/^\/(?:shorts|embed)\/[^/]+/.test(url.pathname)) {
    return { ok: true, url: url.toString() };
  }

  return { ok: false, message: "YouTube URL Download accepts direct YouTube or YouTube Music URLs only" };
}

export async function identifyYouTubeUrl(
  input: string,
  options: YouTubeIdentifyOptions,
): Promise<YouTubeIdentifyResult> {
  const validation = validateYouTubeUrlDownloadInput(input);
  if (!validation.ok) return validation;

  const runner = options.runner ?? nodeDependencyCommandRunner;
  const request = createYouTubeIdentifyRequest(validation.url, options);
  let result: DependencyCommandResult;
  try {
    result = await runner(request);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (result.exitCode !== 0) return { ok: false, message: identifyFailureMessage(result) };

  const parsed = parseYtDlpInfoJson(result.stdout);
  if (!parsed) return { ok: false, message: "yt-dlp identify failed: metadata output was not valid JSON" };
  if (parsed._type === "playlist") return { ok: false, message: "YouTube URL Download rejects playlist URLs" };
  if (isLiveMetadata(parsed)) return { ok: false, message: "YouTube URL Download rejects live streams" };

  const metadata = normalizeIdentifiedMetadata(parsed);
  if (!metadata) {
    return { ok: false, message: "yt-dlp identify failed: metadata did not include a supported extractor and ID" };
  }

  return {
    ok: true,
    identity: {
      providerId: OFFLINE_YOUTUBE_CACHE_PROVIDER_ID,
      stableId: `${metadata.extractor}:${metadata.id}`,
    },
    metadata,
  };
}

function createYouTubeIdentifyRequest(
  url: string,
  options: YouTubeIdentifyOptions,
): DependencyCommandRequest {
  return {
    helper: "yt-dlp",
    command: options.command,
    args: [
      "--dump-single-json",
      "--skip-download",
      "--no-playlist",
      ...cookiesFromBrowserArgs(options.cookiesFromBrowser),
      "--",
      url,
    ],
    timeoutMs: normalizeTimeoutMs(options.timeoutMs),
  };
}

function normalizeIdentifiedMetadata(info: YtDlpInfoJson): IdentifiedYouTubeMetadata | undefined {
  const extractor = stringValue(info.extractor_key) ?? stringValue(info.extractor);
  const normalizedExtractor = extractor?.trim().toLowerCase();
  const id = stringValue(info.id)?.trim();
  const title = stringValue(info.title)?.trim();
  if (!normalizedExtractor || !isSupportedYtDlpExtractor(normalizedExtractor) || !id || !title) return undefined;

  const metadata: IdentifiedYouTubeMetadata = {
    extractor: normalizedExtractor,
    id,
    title,
  };
  const artist = firstNonEmptyString(info.artist, info.uploader, info.channel);
  const album = stringValue(info.album)?.trim();
  const durationSeconds = numberValue(info.duration);

  if (artist) metadata.artist = artist;
  if (album) metadata.album = album;
  if (durationSeconds !== undefined) metadata.durationSeconds = durationSeconds;
  return metadata;
}

function identifyFailureMessage(result: DependencyCommandResult): string {
  const errorText = cleanProcessText(result.stderr);
  if (errorText && isExplanatoryYtDlpFailure(errorText)) return `yt-dlp identify failed: ${errorText}`;
  if (result.errorMessage && /timed?\s*out|timeout/i.test(result.errorMessage)) {
    return `yt-dlp identify timed out: ${result.errorMessage}`;
  }
  if (result.errorMessage) return `yt-dlp identify failed: ${result.errorMessage}`;
  if (errorText) return `yt-dlp identify failed: ${errorText}`;
  return "yt-dlp identify failed";
}

function isExplanatoryYtDlpFailure(text: string): boolean {
  return /\b(unavailable|restricted|region|country|bot|drm|age[- ]?restricted|age[- ]?gated|sign in|not a bot)\b/i
    .test(text);
}

function isSupportedYtDlpExtractor(extractor: string): boolean {
  return extractor === "youtube" || extractor === "youtubemusic";
}

function parseYtDlpInfoJson(stdout: string): YtDlpInfoJson | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as YtDlpInfoJson : null;
  } catch {
    return null;
  }
}

function isLiveMetadata(info: YtDlpInfoJson): boolean {
  if (info.is_live === true) return true;
  const liveStatus = stringValue(info.live_status)?.toLowerCase();
  return liveStatus === "is_live" || liveStatus === "is_upcoming";
}

function accountLibraryRejection(pathname: string): string | undefined {
  const segment = firstPathSegment(pathname);
  if (!segment) return undefined;
  if (segment.startsWith("@") || segment === "channel" || segment === "c" || segment === "user") {
    return "YouTube URL Download rejects channel URLs";
  }
  if (segment === "feed" || segment === "account" || segment === "library" || segment === "browse") {
    return "YouTube URL Download rejects account/library URLs";
  }
  return undefined;
}

function firstPathSegment(pathname: string): string | undefined {
  return pathname.split("/").find(Boolean)?.toLowerCase();
}

function isLivePath(pathname: string): boolean {
  return firstPathSegment(pathname) === "live";
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function isYouTubeHost(host: string): boolean {
  return host === "youtube.com"
    || host === "m.youtube.com"
    || host === "music.youtube.com"
    || host === "youtu.be";
}

function nonEmptyQueryValue(value: string | null): boolean {
  return Boolean(value?.trim());
}

function cookiesFromBrowserArgs(value: string | undefined): string[] {
  const normalized = value?.trim();
  return normalized ? ["--cookies-from-browser", normalized] : [];
}

function normalizeTimeoutMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 2000;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const normalized = stringValue(value)?.trim();
    if (normalized) return normalized;
  }
  return undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function cleanProcessText(value: string): string {
  return value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}
