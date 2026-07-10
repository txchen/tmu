import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type {
  DependencyCommandRequest,
  DependencyCommandResult,
  DependencyCommandRunner,
} from "./dependencies";
import { nodeDependencyCommandRunner } from "./dependencies";
import { YOUTUBE_CACHE_PROVIDER_ID, type TrackIdentity } from "./domain";
import {
  createYouTubeCacheProvider,
  writeYouTubeCacheMetadata,
  type YouTubeCacheProviderOptions,
} from "./youtube-cache";

export type YouTubeUrlValidationResult =
  | { ok: true; url: string; kind: "single" | "playlist" }
  | { ok: false; message: string };

export type IdentifiedYouTubeMetadata = {
  extractor: string;
  id: string;
  title: string;
  uploader: string;
  durationSeconds?: number;
  thumbnailUrl?: string;
};

type YouTubeIdentifyResult =
  | { ok: true; identity: TrackIdentity; metadata: IdentifiedYouTubeMetadata }
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

type YouTubeDownloadOptions = {
  url: string;
  command: string;
  cache: YouTubeCacheProviderOptions;
  metadata: IdentifiedYouTubeMetadata;
  cookiesFromBrowser?: string;
  progressThrottleMs: number;
  graceKillMs?: number;
  signal?: AbortSignal;
  runner?: YouTubeDownloadProcessRunner;
  onProgress?: (line: string) => void;
  now?: () => number;
};

type YouTubeDownloadResult =
  | { ok: true; mediaPath: string; metadataPath: string }
  | { ok: false; message: string; cancelled?: boolean; cleanup?: "complete" | "failed" };

export type DownloadBatchEntry =
  | { kind: "track"; url: string; metadata: IdentifiedYouTubeMetadata }
  | { kind: "unavailable"; title?: string; message: string };

export type YouTubeDownloadBatch = {
  sourceUrl: string;
  kind: "single" | "playlist";
  entries: readonly DownloadBatchEntry[];
};

const preparedDownloadBatches = new WeakSet<YouTubeDownloadBatch>();

export type PlaylistConfirmation = { title: string; itemCount: number };

export type PrepareYouTubeDownloadBatchResult =
  | { kind: "rejected"; message: string }
  | { kind: "ready"; batch: YouTubeDownloadBatch }
  | {
    kind: "confirmation-required";
    confirmation: PlaylistConfirmation;
    confirm(): YouTubeDownloadBatch;
    cancel(): { kind: "cancelled" };
  };

export type PrepareYouTubeDownloadBatchOptions = YouTubeIdentifyOptions;

export type DownloadBatchFailure = { index: number; title?: string; message: string };
export type DownloadBatchSummary = {
  downloaded: number;
  alreadyCached: number;
  failed: number;
  cancelled: number;
  failures: readonly DownloadBatchFailure[];
};

export type ExecuteYouTubeDownloadBatchOptions = {
  command: string;
  cache: YouTubeCacheProviderOptions;
  cookiesFromBrowser?: string;
  progressThrottleMs: number;
  graceKillMs?: number;
  signal?: AbortSignal;
  runner?: YouTubeDownloadProcessRunner;
  onProgress?: (entryIndex: number, line: string) => void;
  now?: () => number;
};

type YtDlpInfoJson = {
  extractor_key?: unknown;
  extractor?: unknown;
  id?: unknown;
  title?: unknown;
  artist?: unknown;
  uploader?: unknown;
  channel?: unknown;
  duration?: unknown;
  thumbnail?: unknown;
  is_live?: unknown;
  live_status?: unknown;
  _type?: unknown;
  url?: unknown;
  webpage_url?: unknown;
  playlist_count?: unknown;
  n_entries?: unknown;
  entries?: unknown;
};

export function validateYouTubeUrlDownloadInput(input: string): YouTubeUrlValidationResult {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return { ok: false, message: "YouTube Downloader accepts exactly one YouTube URL" };
  }
  if (/^ytsearch(?:\d+|all|date)?:/i.test(trimmed)) {
    return { ok: false, message: "YouTube Downloader rejects ytsearch inputs; paste one YouTube URL" };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: "YouTube Downloader accepts a URL, not a bare video ID or search text" };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !isYouTubeHost(normalizedHost(url.hostname))) {
    return { ok: false, message: "YouTube Downloader rejects non-YouTube URLs" };
  }
  if (url.pathname === "/results" || url.searchParams.has("search_query")) {
    return { ok: false, message: "YouTube Downloader rejects search URLs" };
  }
  if (isLivePath(url.pathname)) return { ok: false, message: "YouTube Downloader rejects live streams" };
  const accountMessage = accountLibraryRejection(url.pathname);
  if (accountMessage) return { ok: false, message: accountMessage };

  if (url.pathname === "/playlist" && nonEmptyQueryValue(url.searchParams.get("list"))) {
    return { ok: true, url: url.toString(), kind: "playlist" };
  }

  const host = normalizedHost(url.hostname);
  const isSingle = host === "youtu.be"
    ? Boolean(firstPathSegment(url.pathname))
    : (url.pathname === "/watch" && nonEmptyQueryValue(url.searchParams.get("v")))
      || /^\/(?:shorts|embed)\/[^/]+/.test(url.pathname);
  if (!isSingle) return { ok: false, message: "YouTube Downloader accepts video, Shorts, or explicit playlist URLs only" };
  if (host !== "youtu.be" && url.pathname === "/watch") {
    // A copied watch URL remains one video even when it came from a playlist page.
    url.searchParams.delete("list");
    url.searchParams.delete("index");
    url.searchParams.delete("start_radio");
  }
  return { ok: true, url: url.toString(), kind: "single" };
}

export async function prepareYouTubeDownloadBatch(
  input: string,
  options: PrepareYouTubeDownloadBatchOptions,
): Promise<PrepareYouTubeDownloadBatchResult> {
  const validation = validateYouTubeUrlDownloadInput(input);
  if (!validation.ok) return { kind: "rejected", message: validation.message };
  if (validation.kind === "single") {
    const identified = await identifyYouTubeUrl(validation.url, options);
    if (!identified.ok) return { kind: "rejected", message: identified.message };
    const batch: YouTubeDownloadBatch = {
        sourceUrl: validation.url,
        kind: "single",
        entries: [{ kind: "track", url: canonicalVideoUrl(identified.metadata.id), metadata: identified.metadata }],
    };
    preparedDownloadBatches.add(batch);
    return { kind: "ready", batch };
  }

  const result = await runDependencyCommand(createPlaylistPreflightRequest(validation.url, options), options);
  if (!result.ok) return { kind: "rejected", message: result.message };
  const playlist = parseJsonObject(result.result.stdout);
  if (!playlist || playlist._type !== "playlist") {
    return { kind: "rejected", message: "yt-dlp playlist preflight failed: metadata was not a playlist" };
  }
  const title = stringValue(playlist.title)?.trim() || "Untitled YouTube playlist";
  const rawEntries = Array.isArray(playlist.entries) ? playlist.entries : [];
  const knownCount = integerValue(playlist.playlist_count) ?? integerValue(playlist.n_entries);
  const entries = rawEntries.map(normalizePlaylistEntry);
  while (knownCount !== undefined && entries.length < knownCount) {
    entries.push({ kind: "unavailable", message: "YouTube playlist entry was unavailable during preflight" });
  }
  return {
    kind: "confirmation-required",
    confirmation: { title, itemCount: knownCount ?? entries.length },
    confirm: () => {
      const batch: YouTubeDownloadBatch = { sourceUrl: validation.url, kind: "playlist", entries };
      preparedDownloadBatches.add(batch);
      return batch;
    },
    cancel: () => ({ kind: "cancelled" }),
  };
}

export async function executeYouTubeDownloadBatch(
  batch: YouTubeDownloadBatch,
  options: ExecuteYouTubeDownloadBatchOptions,
): Promise<DownloadBatchSummary> {
  if (!preparedDownloadBatches.has(batch)) {
    throw new Error("YouTube Download Batch must be created by preflight and playlist confirmation before execution");
  }
  let downloaded = 0;
  let alreadyCached = 0;
  let failed = 0;
  let cancelled = 0;
  const failures: DownloadBatchFailure[] = [];

  for (let index = 0; index < batch.entries.length; index += 1) {
    if (options.signal?.aborted) {
      const remaining = classifyUnprocessedEntries(batch.entries, index, failures);
      failed += remaining.failed;
      cancelled += remaining.cancelled;
      break;
    }
    const entry = batch.entries[index]!;
    if (entry.kind === "unavailable") {
      failed += 1;
      failures.push({ index, ...(entry.title ? { title: entry.title } : {}), message: entry.message });
      continue;
    }

    const provider = createYouTubeCacheProvider(options.cache);
    const identity = { providerId: YOUTUBE_CACHE_PROVIDER_ID, stableId: entry.metadata.id };
    if (provider.findByIdentity(identity)) {
      alreadyCached += 1;
      continue;
    }

    const result = await downloadYouTubeUrl({
      url: entry.url,
      command: options.command,
      cache: options.cache,
      metadata: entry.metadata,
      cookiesFromBrowser: options.cookiesFromBrowser,
      progressThrottleMs: options.progressThrottleMs,
      graceKillMs: options.graceKillMs,
      signal: options.signal,
      runner: options.runner,
      onProgress: options.onProgress ? (line) => options.onProgress!(index, line) : undefined,
      now: options.now,
    });
    if (result.ok) {
      downloaded += 1;
    } else if (result.cancelled) {
      cancelled += 1;
      const remaining = classifyUnprocessedEntries(batch.entries, index + 1, failures);
      failed += remaining.failed;
      cancelled += remaining.cancelled;
      break;
    } else {
      failed += 1;
      failures.push({ index, title: entry.metadata.title, message: result.message });
    }
  }
  return { downloaded, alreadyCached, failed, cancelled, failures };
}

function classifyUnprocessedEntries(
  entries: readonly DownloadBatchEntry[],
  startIndex: number,
  failures: DownloadBatchFailure[],
): { failed: number; cancelled: number } {
  let failed = 0;
  let cancelled = 0;
  for (let index = startIndex; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.kind === "track") cancelled += 1;
    else {
      failed += 1;
      failures.push({ index, ...(entry.title ? { title: entry.title } : {}), message: entry.message });
    }
  }
  return { failed, cancelled };
}

async function identifyYouTubeUrl(input: string, options: YouTubeIdentifyOptions): Promise<YouTubeIdentifyResult> {
  const validation = validateYouTubeUrlDownloadInput(input);
  if (!validation.ok) return validation;
  if (validation.kind !== "single") return { ok: false, message: "A playlist requires preflight confirmation" };
  const outcome = await runDependencyCommand(createYouTubeIdentifyRequest(validation.url, options), options);
  if (!outcome.ok) return outcome;
  const parsed = parseJsonObject(outcome.result.stdout);
  if (!parsed) return { ok: false, message: "yt-dlp identify failed: metadata output was not valid JSON" };
  if (parsed._type === "playlist") return { ok: false, message: "yt-dlp identify unexpectedly returned a playlist" };
  if (isLiveMetadata(parsed)) return { ok: false, message: "YouTube Downloader rejects live streams" };
  const metadata = normalizeIdentifiedMetadata(parsed);
  if (!metadata) return { ok: false, message: "yt-dlp identify failed: metadata was incomplete" };
  return { ok: true, identity: { providerId: YOUTUBE_CACHE_PROVIDER_ID, stableId: metadata.id }, metadata };
}

async function downloadYouTubeUrl(options: YouTubeDownloadOptions): Promise<YouTubeDownloadResult> {
  const runner = options.runner ?? nodeYouTubeDownloadProcessRunner;
  const partialDir = join(options.cache.cacheDir, `.partial-${options.metadata.id}`);
  const outputTemplate = join(partialDir, `${options.metadata.id}.%(ext)s`);
  const progress = createDownloadProgressReporter(options);
  await rm(partialDir, { recursive: true, force: true });
  await mkdir(partialDir, { recursive: true });

  let result: YouTubeDownloadProcessResult;
  try {
    result = await runner({
      helper: "yt-dlp",
      command: options.command,
      args: [
        "--no-playlist", "--format", "bestaudio/best", "--continue", "--part",
        "--newline", "--progress", "--output", outputTemplate,
        ...cookiesFromBrowserArgs(options.cookiesFromBrowser), "--", options.url,
      ],
      graceKillMs: normalizeGraceKillMs(options.graceKillMs),
      signal: options.signal,
      onLine: progress.onLine,
    });
  } catch (error) {
    await rm(partialDir, { recursive: true, force: true });
    return { ok: false, message: `yt-dlp download failed: ${errorMessage(error)}` };
  }
  progress.flush();
  if (result.cancelled || options.signal?.aborted) return cancelledYouTubeDownload(partialDir);
  if (result.exitCode !== 0) {
    await rm(partialDir, { recursive: true, force: true });
    return { ok: false, message: downloadFailureMessage(result) };
  }

  const partialMediaPath = await findDownloadedMediaFile(partialDir, options.metadata.id);
  if (!partialMediaPath || !(await isNonEmptyFile(partialMediaPath))) {
    await rm(partialDir, { recursive: true, force: true });
    return { ok: false, message: "yt-dlp download failed: output file was missing or empty" };
  }
  if (options.signal?.aborted) return cancelledYouTubeDownload(partialDir);

  const extension = extname(partialMediaPath).slice(1).toLowerCase();
  const mediaPath = join(options.cache.cacheDir, `${options.metadata.id}.${extension}`);
  const provider = createYouTubeCacheProvider(options.cache);
  const incomplete = provider.listIncompleteEntries().find((candidate) => candidate.stem === options.metadata.id);
  const previousMediaBackup = join(partialDir, `.previous-${basename(mediaPath)}`);
  const hadPreviousMedia = await pathExists(mediaPath);
  if (hadPreviousMedia) await rename(mediaPath, previousMediaBackup);
  await rename(partialMediaPath, mediaPath);
  try {
    const metadataPath = await writeYouTubeCacheMetadata(options.cache, {
      videoId: options.metadata.id,
      title: options.metadata.title,
      uploader: options.metadata.uploader,
      ...(options.metadata.durationSeconds !== undefined ? { durationSeconds: options.metadata.durationSeconds } : {}),
      cachedAt: new Date((options.now ?? Date.now)()).toISOString(),
      mediaFileName: basename(mediaPath),
      container: extension,
      ...(options.metadata.thumbnailUrl ? { thumbnailUrl: options.metadata.thumbnailUrl } : {}),
    }, { signal: options.signal });
    for (const path of incomplete?.paths ?? []) {
      if (path !== mediaPath && path !== metadataPath) await rm(path, { force: true });
    }
    await rm(partialDir, { recursive: true, force: true });
    return { ok: true, mediaPath, metadataPath };
  } catch (error) {
    await rm(mediaPath, { force: true });
    if (hadPreviousMedia) await rename(previousMediaBackup, mediaPath).catch(() => undefined);
    if (options.signal?.aborted) return cancelledYouTubeDownload(partialDir);
    await rm(partialDir, { recursive: true, force: true });
    return { ok: false, message: `YouTube Cache metadata write failed: ${errorMessage(error)}` };
  }
}

export function parseYtDlpDownloadProgressLine(line: string): string | undefined {
  const cleaned = line.trim().replace(/\s+/g, " ");
  if (!cleaned) return undefined;
  const destination = cleaned.match(/^\[download\] Destination: (.+)$/i);
  if (destination?.[1]) return `download destination: ${basename(destination[1])}`;
  const percent = cleaned.match(/^\[download\].*?\b(\d+(?:\.\d+)?)%/i)?.[1];
  if (!percent) return undefined;
  const speed = cleaned.match(/\bat\s+([^\s]+\/s)\b/i)?.[1];
  const eta = cleaned.match(/\bETA\s+([^\s]+)/i)?.[1];
  return [`download ${percent}%`, speed ? `at ${speed}` : undefined, eta ? `ETA ${eta}` : undefined]
    .filter(Boolean).join(" ");
}

function createYouTubeIdentifyRequest(url: string, options: YouTubeIdentifyOptions): DependencyCommandRequest {
  return {
    helper: "yt-dlp", command: options.command,
    args: ["--dump-single-json", "--skip-download", "--no-playlist", ...cookiesFromBrowserArgs(options.cookiesFromBrowser), "--", url],
    timeoutMs: normalizeTimeoutMs(options.timeoutMs),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function createPlaylistPreflightRequest(url: string, options: YouTubeIdentifyOptions): DependencyCommandRequest {
  return {
    helper: "yt-dlp", command: options.command,
    args: ["--dump-single-json", "--skip-download", "--flat-playlist", "--yes-playlist", "--ignore-errors", ...cookiesFromBrowserArgs(options.cookiesFromBrowser), "--", url],
    timeoutMs: normalizeTimeoutMs(options.timeoutMs),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

async function runDependencyCommand(
  request: DependencyCommandRequest,
  options: YouTubeIdentifyOptions,
): Promise<{ ok: true; result: DependencyCommandResult } | { ok: false; message: string }> {
  try {
    const result = await (options.runner ?? nodeDependencyCommandRunner)(request);
    if (options.signal?.aborted) return { ok: false, message: "YouTube download cancelled" };
    if (result.exitCode !== 0) return { ok: false, message: identifyFailureMessage(result) };
    return { ok: true, result };
  } catch (error) {
    return { ok: false, message: options.signal?.aborted ? "YouTube download cancelled" : errorMessage(error) };
  }
}

function normalizePlaylistEntry(value: unknown): DownloadBatchEntry {
  if (!value || typeof value !== "object") return { kind: "unavailable", message: "Playlist item is unavailable" };
  const info = value as YtDlpInfoJson;
  const metadata = normalizeIdentifiedMetadata(info);
  if (!metadata) {
    const title = stringValue(info.title)?.trim();
    return { kind: "unavailable", ...(title ? { title } : {}), message: "Playlist item is private, deleted, or unavailable" };
  }
  return { kind: "track", url: canonicalVideoUrl(metadata.id), metadata };
}

function normalizeIdentifiedMetadata(info: YtDlpInfoJson): IdentifiedYouTubeMetadata | undefined {
  const extractor = (stringValue(info.extractor_key) ?? stringValue(info.extractor) ?? "youtube").trim().toLowerCase();
  const id = stringValue(info.id)?.trim();
  const title = stringValue(info.title)?.trim();
  const uploader = firstNonEmptyString(info.artist, info.uploader, info.channel) ?? "Unknown uploader";
  if (!isSupportedYtDlpExtractor(extractor) || !id || !isYouTubeVideoId(id) || !title) return undefined;
  const durationSeconds = numberValue(info.duration);
  const thumbnailUrl = stringValue(info.thumbnail)?.trim();
  return {
    extractor, id, title, uploader,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
  };
}

function createDownloadProgressReporter(options: YouTubeDownloadOptions) {
  const now = options.now ?? Date.now;
  const throttleMs = normalizeProgressThrottleMs(options.progressThrottleMs);
  let lastAt: number | undefined;
  let pending: string | undefined;
  return {
    onLine(line: string) {
      const parsed = parseYtDlpDownloadProgressLine(line);
      if (!parsed || !options.onProgress) return;
      const current = now();
      if (lastAt === undefined || current - lastAt >= throttleMs) {
        lastAt = current; pending = undefined; options.onProgress(parsed);
      } else pending = parsed;
    },
    flush() { if (pending && options.onProgress) options.onProgress(pending); },
  };
}

async function findDownloadedMediaFile(dir: string, stem: string): Promise<string | undefined> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const file = entries.filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .find((name) => name.startsWith(`${stem}.`) && !/\.(?:part|ytdl|tmp)$/i.test(name));
    return file ? join(dir, file) : undefined;
  } catch { return undefined; }
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try { const value = await stat(path); return value.isFile() && value.size > 0; } catch { return false; }
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function cancelledYouTubeDownload(partialDir: string): Promise<YouTubeDownloadResult> {
  try {
    await rm(partialDir, { recursive: true, force: true });
    return { ok: false, message: "YouTube download cancelled; partial files cleaned up", cancelled: true, cleanup: "complete" };
  } catch (error) {
    return { ok: false, message: `YouTube download cancelled; partial file cleanup failed: ${errorMessage(error)}`, cancelled: true, cleanup: "failed" };
  }
}

function identifyFailureMessage(result: DependencyCommandResult): string {
  const details = cleanProcessText(result.stderr) || result.errorMessage;
  return details ? `yt-dlp extraction failed: ${details}` : "yt-dlp extraction failed";
}
function downloadFailureMessage(result: YouTubeDownloadProcessResult): string {
  const details = cleanProcessText(result.stderr) || result.errorMessage;
  return details ? `yt-dlp download failed: ${details}` : "yt-dlp download failed";
}
function parseJsonObject(text: string): YtDlpInfoJson | undefined {
  try { const value = JSON.parse(text); return value && typeof value === "object" ? value : undefined; } catch { return undefined; }
}
function isLiveMetadata(info: YtDlpInfoJson): boolean {
  const status = stringValue(info.live_status)?.toLowerCase();
  return info.is_live === true || status === "is_live" || status === "is_upcoming";
}
function canonicalVideoUrl(id: string): string { return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`; }
function accountLibraryRejection(path: string): string | undefined {
  const segment = firstPathSegment(path);
  if (!segment) return undefined;
  if (segment.startsWith("@") || ["channel", "c", "user"].includes(segment)) return "YouTube Downloader rejects channel URLs";
  if (["feed", "account", "library", "browse"].includes(segment)) return "YouTube Downloader rejects account/library URLs";
  return undefined;
}
function firstPathSegment(path: string): string | undefined { return path.split("/").find(Boolean)?.toLowerCase(); }
function isLivePath(path: string): boolean { return firstPathSegment(path) === "live"; }
function normalizedHost(host: string): string { return host.toLowerCase().replace(/^www\./, ""); }
function isYouTubeHost(host: string): boolean { return ["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host); }
function nonEmptyQueryValue(value: string | null): boolean { return Boolean(value?.trim()); }
function cookiesFromBrowserArgs(value: string | undefined): string[] { return value?.trim() ? ["--cookies-from-browser", value.trim()] : []; }
function normalizeTimeoutMs(value: number): number { return Number.isFinite(value) && value > 0 ? Math.floor(value) : 2000; }
function normalizeProgressThrottleMs(value: number): number { return Number.isFinite(value) && value > 0 ? Math.floor(value) : 500; }
function normalizeGraceKillMs(value: number | undefined): number { return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 1500; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function firstNonEmptyString(...values: unknown[]): string | undefined { return values.map(stringValue).map((v) => v?.trim()).find(Boolean); }
function numberValue(value: unknown): number | undefined { const n = typeof value === "number" ? value : Number(value); return Number.isFinite(n) && n >= 0 ? n : undefined; }
function integerValue(value: unknown): number | undefined { const n = numberValue(value); return n === undefined ? undefined : Math.floor(n); }
function cleanProcessText(value: string): string { return value.split(/\r?\n/).map((v) => v.trim()).filter(Boolean).join(" "); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isSupportedYtDlpExtractor(value: string): boolean { return value === "youtube" || value === "youtubemusic"; }
function isYouTubeVideoId(value: string): boolean { return /^[A-Za-z0-9_-]{11}$/.test(value); }

export const nodeYouTubeDownloadProcessRunner: YouTubeDownloadProcessRunner = (request) => new Promise((resolve) => {
  const child = spawn(request.command, request.args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdoutLines = new LineReader(request.onLine);
  const stderrLines = new LineReader(request.onLine);
  let stdout = ""; let stderr = ""; let errorMessageValue: string | undefined;
  let cancelled = false; let killed = false; let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    cancelled = true;
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    timer = setTimeout(() => { if (child.exitCode === null) killed = child.kill("SIGKILL") || killed; }, request.graceKillMs);
  };
  child.stdout?.on("data", (chunk) => { const text = String(chunk); stdout += text; stdoutLines.push(text); });
  child.stderr?.on("data", (chunk) => { const text = String(chunk); stderr += text; stderrLines.push(text); });
  child.on("error", (error) => { errorMessageValue = error.message; });
  child.on("close", (code) => {
    if (timer) clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
    stdoutLines.flush(); stderrLines.flush();
    resolve({ exitCode: typeof code === "number" ? code : null, stdout, stderr, errorMessage: errorMessageValue, cancelled, killed });
  });
  if (request.signal?.aborted) abort(); else request.signal?.addEventListener("abort", abort, { once: true });
});

class LineReader {
  private buffered = "";
  constructor(private readonly onLine: (line: string) => void) {}
  push(text: string) { this.buffered += text; const lines = this.buffered.split(/\r?\n/); this.buffered = lines.pop() ?? ""; for (const line of lines) this.onLine(line); }
  flush() { if (this.buffered) this.onLine(this.buffered); this.buffered = ""; }
}
