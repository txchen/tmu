import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { YOUTUBE_CACHE_PROVIDER_ID } from "./domain";
import {
  writeYouTubeCacheMetadata,
  type YouTubeCacheProviderOptions,
} from "./youtube-cache";
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
  signal?: AbortSignal;
};

export type YouTubeDownloadProcessRequest = {
  helper: "yt-dlp";
  command: string;
  args: string[];
  graceKillMs: number;
  signal?: AbortSignal;
  onLine(line: string): void;
};

export type YouTubeDownloadProcessResult = DependencyCommandResult & {
  cancelled?: boolean;
  killed?: boolean;
};

export type YouTubeDownloadProcessRunner = (
  request: YouTubeDownloadProcessRequest,
) => Promise<YouTubeDownloadProcessResult>;

export type YouTubeMediaValidationResult =
  | { ok: true }
  | { ok: false; message: string };

export type YouTubeMediaValidator = (path: string) => Promise<YouTubeMediaValidationResult>;

export type FfprobeYouTubeMediaValidatorOptions = {
  command: string;
  timeoutMs: number;
  runner?: DependencyCommandRunner;
};

export type YouTubeDownloadOptions = {
  url: string;
  command: string;
  cache: YouTubeCacheProviderOptions;
  metadata: IdentifiedYouTubeMetadata;
  cookiesFromBrowser?: string;
  progressThrottleMs: number;
  graceKillMs?: number;
  signal?: AbortSignal;
  runner?: YouTubeDownloadProcessRunner;
  validateMedia: YouTubeMediaValidator;
  onProgress?: (line: string) => void;
  now?: () => number;
};

export type YouTubeDownloadResult =
  | {
    ok: true;
    mediaPath: string;
    metadataPath: string;
    sourceMetadataPath: string;
  }
  | {
    ok: false;
    message: string;
    cancelled?: boolean;
    cleanup?: "complete" | "failed";
  };

export type YouTubeDownloader = (options: YouTubeDownloadOptions) => Promise<YouTubeDownloadResult>;

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

type FfprobeAudioJson = {
  streams?: Array<{ codec_type?: unknown }>;
};

type YouTubeSourceMetadata = {
  version: 1;
  url: string;
  extractor: string;
  id: string;
  title: string;
  artist?: string;
  album?: string;
  durationSeconds?: number;
};

const YOUTUBE_SOURCE_METADATA_FILE_NAME = "source.json";

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
    if (options.signal?.aborted) return { ok: false, message: "YouTube download cancelled" };
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  if (options.signal?.aborted) return { ok: false, message: "YouTube download cancelled" };
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
      providerId: YOUTUBE_CACHE_PROVIDER_ID,
      stableId: metadata.id,
    },
    metadata,
  };
}

export async function downloadYouTubeUrl(options: YouTubeDownloadOptions): Promise<YouTubeDownloadResult> {
  const runner = options.runner ?? nodeYouTubeDownloadProcessRunner;
  const paths = youtubeDownloadPaths(options.cache, options.metadata);
  const progress = createDownloadProgressReporter(options);

  await mkdir(paths.mediaDir, { recursive: true });
  if (!await findDownloadedMediaFile(paths.mediaDir, paths.outputPrefix)) {
    await rm(paths.archivePath, { force: true });
  }
  const result = await runner({
    helper: "yt-dlp",
    command: options.command,
    args: createYouTubeDownloadArgs(options.url, options, paths),
    graceKillMs: normalizeGraceKillMs(options.graceKillMs),
    signal: options.signal,
    onLine: progress.onLine,
  });
  progress.flush();

  if (result.cancelled || options.signal?.aborted) {
    return cancelledYouTubeDownload(paths.entryDir);
  }

  if (result.exitCode !== 0) return { ok: false, message: downloadFailureMessage(result) };

  const mediaPath = await findDownloadedMediaFile(paths.mediaDir, paths.outputPrefix);
  if (!mediaPath) {
    return { ok: false, message: "yt-dlp download failed: downloaded media file was not found" };
  }

  if (options.signal?.aborted) return cancelledYouTubeDownload(paths.entryDir);
  const validation = await options.validateMedia(mediaPath);
  if (options.signal?.aborted) return cancelledYouTubeDownload(paths.entryDir);
  if (!validation.ok) return { ok: false, message: validation.message };

  const metadata = normalizedMetadataFields(options.metadata);
  if (options.signal?.aborted) return cancelledYouTubeDownload(paths.entryDir);
  let sourceMetadataPath: string;
  try {
    sourceMetadataPath = await writeYouTubeSourceMetadata(paths.sourceMetadataPath, {
      version: 1,
      url: options.url,
      ...metadata,
    }, { signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) return cancelledYouTubeDownload(paths.entryDir);
    throw error;
  }
  if (options.signal?.aborted) return cancelledYouTubeDownload(paths.entryDir);
  let metadataPath: string;
  try {
    metadataPath = await writeYouTubeCacheMetadata(options.cache, {
      version: 1,
      ...metadata,
      mediaFileName: basename(mediaPath),
    }, { signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) return cancelledYouTubeDownload(paths.entryDir);
    throw error;
  }
  if (options.signal?.aborted) return cancelledYouTubeDownload(paths.entryDir);

  return { ok: true, mediaPath, metadataPath, sourceMetadataPath };
}

export function createFfprobeYouTubeMediaValidator(
  options: FfprobeYouTubeMediaValidatorOptions,
): YouTubeMediaValidator {
  const runner = options.runner ?? nodeDependencyCommandRunner;
  return async (path: string): Promise<YouTubeMediaValidationResult> => {
    let result: DependencyCommandResult;
    try {
      result = await runner({
        helper: "ffprobe",
        command: options.command,
        args: [
          "-v",
          "error",
          "-select_streams",
          "a:0",
          "-show_entries",
          "stream=codec_type",
          "-of",
          "json",
          path,
        ],
        timeoutMs: normalizeTimeoutMs(options.timeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        message: `Downloaded media validation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (result.exitCode !== 0) {
      const details = cleanProcessText(result.stderr) || result.errorMessage || "ffprobe could not read the downloaded media";
      return { ok: false, message: `Downloaded media validation failed: ${details}` };
    }

    const parsed = parseFfprobeAudioJson(result.stdout);
    if (!parsed?.streams?.some((stream) => stream.codec_type === "audio")) {
      return { ok: false, message: "Downloaded media validation failed: no audio stream found" };
    }

    return { ok: true };
  };
}

export function parseYtDlpDownloadProgressLine(line: string): string | undefined {
  const cleaned = line.trim().replace(/\s+/g, " ");
  if (!cleaned) return undefined;

  const destination = cleaned.match(/^\[download\] Destination: (.+)$/i);
  if (destination?.[1]) return `download destination: ${basename(destination[1])}`;

  const percent = cleaned.match(/^\[download\].*?\b(\d+(?:\.\d+)?)%/i);
  if (!percent?.[1]) return undefined;

  const speed = cleaned.match(/\bat\s+([^\s]+\/s)\b/i)?.[1];
  const eta = cleaned.match(/\bETA\s+([^\s]+)/i)?.[1];
  return [
    `download ${percent[1]}%`,
    speed ? `at ${speed}` : undefined,
    eta ? `ETA ${eta}` : undefined,
  ].filter(Boolean).join(" ");
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
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function createYouTubeDownloadArgs(
  url: string,
  options: YouTubeDownloadOptions,
  paths: ReturnType<typeof youtubeDownloadPaths>,
): string[] {
  return [
    "--no-playlist",
    "--format",
    "bestaudio/best",
    "--continue",
    "--part",
    "--newline",
    "--progress",
    "--download-archive",
    paths.archivePath,
    "--output",
    paths.outputTemplate,
    ...cookiesFromBrowserArgs(options.cookiesFromBrowser),
    "--",
    url,
  ];
}

function youtubeDownloadPaths(cache: YouTubeCacheProviderOptions, metadata: IdentifiedYouTubeMetadata) {
  const entryDir = join(cache.cacheDir, metadata.extractor, metadata.id);
  const mediaDir = join(entryDir, cache.mediaDirName);
  const outputPrefix = `${metadata.extractor}-${metadata.id}`;
  return {
    entryDir,
    mediaDir,
    archivePath: join(entryDir, "download-archive.txt"),
    sourceMetadataPath: join(entryDir, YOUTUBE_SOURCE_METADATA_FILE_NAME),
    outputPrefix,
    outputTemplate: join(mediaDir, `${outputPrefix}.%(ext)s`),
  };
}

function normalizedMetadataFields(metadata: IdentifiedYouTubeMetadata): Omit<YouTubeSourceMetadata, "version" | "url"> {
  return {
    extractor: metadata.extractor,
    id: metadata.id,
    title: metadata.title,
    ...(metadata.artist ? { artist: metadata.artist } : {}),
    ...(metadata.album ? { album: metadata.album } : {}),
    ...(metadata.durationSeconds !== undefined ? { durationSeconds: metadata.durationSeconds } : {}),
  };
}

async function cancelledYouTubeDownload(entryDir: string): Promise<YouTubeDownloadResult> {
  try {
    await rm(entryDir, { recursive: true, force: true });
    return {
      ok: false,
      message: "YouTube download cancelled; partial files cleaned up",
      cancelled: true,
      cleanup: "complete",
    };
  } catch (error) {
    return {
      ok: false,
      message: `YouTube download cancelled; partial file cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      cancelled: true,
      cleanup: "failed",
    };
  }
}

async function writeYouTubeSourceMetadata(
  path: string,
  metadata: YouTubeSourceMetadata,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  throwIfAborted(options.signal);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;

  try {
    throwIfAborted(options.signal);
    await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", signal: options.signal });
    throwIfAborted(options.signal);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return path;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw cancelledError();
}

function cancelledError(): Error {
  return new Error("YouTube download cancelled");
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

function createDownloadProgressReporter(options: YouTubeDownloadOptions) {
  const onProgress = options.onProgress;
  const now = options.now ?? Date.now;
  const throttleMs = normalizeProgressThrottleMs(options.progressThrottleMs);
  let lastEmittedAt: number | null = null;
  let pending: string | null = null;

  return {
    onLine(line: string): void {
      const parsed = parseYtDlpDownloadProgressLine(line);
      if (!parsed || !onProgress) return;

      const currentTime = now();
      if (lastEmittedAt === null || currentTime - lastEmittedAt >= throttleMs) {
        lastEmittedAt = currentTime;
        pending = null;
        onProgress(parsed);
        return;
      }

      pending = parsed;
    },
    flush(): void {
      if (!pending || !onProgress) return;
      const flushed = pending;
      pending = null;
      lastEmittedAt = now();
      onProgress(flushed);
    },
  };
}

async function findDownloadedMediaFile(mediaDir: string, outputPrefix: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(mediaDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) =>
      name.startsWith(`${outputPrefix}.`)
      && !name.endsWith(".part")
      && !name.endsWith(".ytdl")
      && !name.endsWith(".tmp")
    )
    .sort();

  const fileName = candidates[0];
  return fileName ? join(mediaDir, fileName) : undefined;
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

function downloadFailureMessage(result: YouTubeDownloadProcessResult): string {
  const errorText = cleanProcessText(result.stderr);
  if (errorText) return `yt-dlp download failed: ${errorText}`;
  if (result.errorMessage) return `yt-dlp download failed: ${result.errorMessage}`;
  return "yt-dlp download failed";
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

function parseFfprobeAudioJson(stdout: string): FfprobeAudioJson | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed as FfprobeAudioJson : null;
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

function normalizeProgressThrottleMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 500;
}

function normalizeGraceKillMs(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : 1500;
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

export const nodeYouTubeDownloadProcessRunner: YouTubeDownloadProcessRunner = (request) => {
  return new Promise((resolve) => {
    const child = spawn(request.command, request.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutLines = new LineReader(request.onLine);
    const stderrLines = new LineReader(request.onLine);
    let stdout = "";
    let stderr = "";
    let errorMessage: string | undefined;
    let cancelled = false;
    let killed = false;
    let forceTimer: ReturnType<typeof setTimeout> | null = null;

    const clearForceTimer = () => {
      if (!forceTimer) return;
      clearTimeout(forceTimer);
      forceTimer = null;
    };
    const abort = () => {
      cancelled = true;
      if (child.exitCode !== null) return;

      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        if (child.exitCode !== null) return;
        killed = child.kill("SIGKILL") || killed;
      }, request.graceKillMs);
    };
    const cleanup = () => {
      clearForceTimer();
      request.signal?.removeEventListener("abort", abort);
    };

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      stdoutLines.push(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      stderrLines.push(text);
    });
    child.on("error", (error) => {
      errorMessage = error instanceof Error ? error.message : String(error);
    });
    child.on("close", (code) => {
      stdoutLines.flush();
      stderrLines.flush();
      cleanup();
      resolve({
        exitCode: typeof code === "number" ? code : null,
        stdout,
        stderr,
        errorMessage,
        cancelled,
        killed,
      });
    });

    if (request.signal?.aborted) {
      abort();
    } else {
      request.signal?.addEventListener("abort", abort, { once: true });
    }
  });
};

class LineReader {
  private buffered = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(text: string): void {
    this.buffered += text;
    const lines = this.buffered.split(/\r?\n/);
    this.buffered = lines.pop() ?? "";
    for (const line of lines) this.onLine(line);
  }

  flush(): void {
    if (!this.buffered) return;
    this.onLine(this.buffered);
    this.buffered = "";
  }
}
