import {
  NAVIGATION_TARGETS,
  clampIndex,
  sameIdentity,
  navigationTargetIndex,
  type AppState,
  type QueueEntry,
  type NavigationTarget,
  type Track,
  type UiState,
} from "./domain";
import { youtubeDownloadHealthMessage, type DependencyHealthState, type HelperDependencyHealth } from "./dependencies";
import { isNavidromeProvider, navidromeConnectionStateLine, type NavidromeLibraryBrowserEntry } from "./navidrome";
import { OFFLINE_YOUTUBE_CACHE_PROVIDER_ID, isOfflineYouTubeCacheProvider } from "./offline-youtube-cache";

export type RenderedNavigationTarget = NavigationTarget & {
  selected: boolean;
  focused: boolean;
};

export type RenderedShell = {
  title: string;
  navigationTargets: RenderedNavigationTarget[];
  providerSurface: {
    title: string;
    lines: string[];
    emptyMessage: string;
  };
  queuePlayer: {
    title: string;
    nowPlaying: string;
    playbackState: string;
    progress: string;
    modes: string;
    availability: string;
    lines: string[];
  };
  health: {
    title: string;
    lines: string[];
  };
  footer: string;
};

export function renderShell(appState: AppState, uiState: UiState): RenderedShell {
  const activeTarget = NAVIGATION_TARGETS[navigationTargetIndex(uiState.activeTargetId)] ?? NAVIGATION_TARGETS[0];
  const providerLines = providerTrackLines(appState, uiState);
  const providerSurfaceStatusLines = providerSurfaceStatusLinesFor(appState, uiState);
  const promptLines = providerSurfacePromptLines(uiState);
  const queueView = expandedQueueView(appState, uiState);

  return {
    title: "TMU",
    navigationTargets: NAVIGATION_TARGETS.map((target) => ({
      ...target,
      selected: target.id === uiState.activeTargetId,
      focused: uiState.focusedPane === "targets" && target.id === uiState.activeTargetId,
    })),
    providerSurface: {
      title: queueView?.title ?? activeTarget.label,
      lines: queueView?.lines ?? [...providerSurfaceStatusLines, ...promptLines, ...providerLines],
      emptyMessage: emptyMessageFor(activeTarget.id),
    },
    queuePlayer: {
      title: "Queue / Player Strip",
      nowPlaying: nowPlaying(appState),
      playbackState: playbackState(appState),
      progress: progressText(appState),
      modes: queueModes(appState),
      availability: queueAvailability(appState, uiState),
      lines: appState.queue.entries.map((entry, index) => queueLine(appState, uiState, entry, index)),
    },
    health: {
      title: "Dependency Health",
      lines: dependencyHealthLines(appState.dependencyHealth),
    },
    footer: `last: ${appState.lastEvent}`,
  };
}

export function renderShellText(appState: AppState, uiState: UiState): string {
  const shell = renderShell(appState, uiState);
  const targetRail = shell.navigationTargets
    .map((target) => `${target.selected ? ">" : " "} ${target.label}`)
    .join("\n");
  const providerLines = shell.providerSurface.lines.length
    ? shell.providerSurface.lines.join("\n")
    : `  ${shell.providerSurface.emptyMessage}`;
  const queueLines = shell.queuePlayer.lines.length
    ? shell.queuePlayer.lines.join("\n")
    : "  Empty queue";

  return [
    shell.title,
    "",
    "Targets                  Provider Browsing Surface",
    "----------------------   -------------------------",
    twoColumns(targetRail, `${shell.providerSurface.title}\n${providerLines}`, 25),
    "",
    shell.queuePlayer.title,
    "--------------",
    shell.queuePlayer.nowPlaying,
    shell.queuePlayer.playbackState,
    shell.queuePlayer.progress,
    shell.queuePlayer.modes,
    shell.queuePlayer.availability,
    queueLines,
    "",
    shell.health.title,
    "-----------------",
    shell.health.lines.map((line) => `  ${line}`).join("\n"),
    "",
    shell.footer,
  ].join("\n");
}

function visibleProviderTracks(appState: AppState, uiState: UiState): readonly Track[] {
  if (uiState.activeTargetId === "queue") return [];
  return appState.providers[uiState.activeTargetId]?.listVisibleTracks() ?? [];
}

function providerTrackLines(appState: AppState, uiState: UiState): string[] {
  if (uiState.activeTargetId === OFFLINE_YOUTUBE_CACHE_PROVIDER_ID) {
    const provider = appState.providers[OFFLINE_YOUTUBE_CACHE_PROVIDER_ID];
    if (isOfflineYouTubeCacheProvider(provider)) {
      return provider.listCacheEntries().map((entry, index) => {
        const selected = index === selectedContentIndex(uiState);
        const suffix = entry.availability.status === "unavailable"
          ? ` [unavailable: ${entry.availability.reason}]`
          : "";
        return row(
          `${entry.track.title}  ${entry.track.providerLabel}${suffix}`,
          selected,
          uiState.focusedPane === "content",
        );
      });
    }
  }

  return visibleProviderTracks(appState, uiState).map((track, index) => {
    const selected = index === selectedContentIndex(uiState);
    return row(`${track.title}  ${track.providerLabel}`, selected, uiState.focusedPane === "content");
  });
}

function expandedQueueView(
  appState: AppState,
  uiState: UiState,
): { title: string; lines: string[] } | null {
  if (uiState.activeTargetId !== "queue") return null;

  return {
    title: "Expanded Queue",
    lines: appState.queue.entries.map((entry, index) => expandedQueueLine(appState, uiState, entry, index)),
  };
}

function selectedContentIndex(uiState: UiState): number {
  return uiState.selectedContentIndexByTarget[uiState.activeTargetId] ?? 0;
}

function emptyMessageFor(targetId: NavigationTarget["id"]): string {
  if (targetId === "queue") return "Queue is empty";
  if (targetId === "youtube-url-download") {
    return "Provider Browsing Surface placeholder for the YouTube URL Download Flow";
  }
  if (targetId === "local") return "Provider Browsing Surface has no Local Tracks opened";
  if (targetId === "navidrome") return "Navidrome Library Browser has no loaded entries";
  if (targetId === OFFLINE_YOUTUBE_CACHE_PROVIDER_ID) return "Offline YouTube Cache has no cached Tracks";
  return "Provider Browsing Surface placeholder; provider behavior lands in later slices";
}

function providerSurfaceStatusLinesFor(appState: AppState, uiState: UiState): string[] {
  const targetId = uiState.activeTargetId;
  if (targetId === "navidrome") {
    const provider = appState.providers.navidrome;
    if (!isNavidromeProvider(provider)) return [];
    const state = provider.getConnectionState();
    return [
      navidromeConnectionStateLine(state),
      ...provider.getLibraryBrowserEntries().map((entry, index) => navidromeLibraryBrowserEntryLine(
        entry,
        index === selectedContentIndex(uiState),
        uiState.focusedPane === "content",
      )),
    ];
  }

  if (targetId !== "youtube-url-download") return [];

  const message = youtubeDownloadHealthMessage(appState.dependencyHealth);
  return message ? [`! ${message}`] : [];
}

function navidromeLibraryBrowserEntryLine(
  entry: NavidromeLibraryBrowserEntry,
  selected: boolean,
  focused: boolean,
): string {
  const prefix = "  ".repeat(entry.depth);
  const albumCount = entry.kind === "artist" && entry.albumCount !== undefined
    ? ` (${entry.albumCount} ${entry.albumCount === 1 ? "album" : "albums"})`
    : "";
  return row(`${prefix}${entry.label}${albumCount}`, selected, focused);
}

function providerSurfacePromptLines(uiState: UiState): string[] {
  if (uiState.activePrompt === "local-open-path") return [`Open local path: ${uiState.promptInput}`];
  if (uiState.activePrompt === "navidrome-search") return [`Navidrome search: ${uiState.promptInput}`];
  if (uiState.activePrompt === "youtube-url") return [`YouTube URL: ${uiState.promptInput}`];
  return [];
}

function dependencyHealthLines(health: DependencyHealthState): string[] {
  return [
    formatHelperLine(health.helpers.mpv, health.playback.enabled ? undefined : "playback disabled"),
    formatHelperLine(health.helpers.ffprobe, health.metadata.degraded ? "metadata degraded" : undefined),
    formatHelperLine(health.helpers["yt-dlp"], health.youtubeUrlDownload.enabled ? undefined : "YouTube URL Download disabled"),
  ];
}

function formatHelperLine(helper: HelperDependencyHealth, consequence: string | undefined): string {
  const version = helper.version ? ` (${helper.version})` : "";
  const suffix = consequence ? ` - ${consequence}` : "";
  return `${helper.name}: ${helper.status} at ${helper.command}${version}${suffix}`;
}

function nowPlaying(appState: AppState): string {
  const current = currentQueueEntry(appState);
  if (!current || appState.playback.status === "idle" || appState.playback.status === "stopped") {
    return "Idle - add a Track to the shared Queue";
  }

  if (appState.playback.status === "error") {
    const suffix = appState.playback.message ? ` - ${appState.playback.message}` : "";
    return `Error ${current.track.title}${suffix}`;
  }

  const verb = appState.playback.status === "paused" ? "Paused" : "Playing";
  return `${verb} ${current.track.title}`;
}

function playbackState(appState: AppState): string {
  return `State: ${appState.playback.status}`;
}

function progressText(appState: AppState): string {
  const current = currentQueueEntry(appState);
  const position = appState.playback.positionSeconds;
  const duration = appState.playback.durationSeconds ?? current?.track.durationSeconds;
  const hasPosition = typeof position === "number" && Number.isFinite(position);
  const hasDuration = typeof duration === "number" && Number.isFinite(duration);

  if (!hasPosition && !hasDuration) return "Progress: --:--";

  return `Progress: ${hasPosition ? formatDuration(position) : "--:--"} / ${hasDuration ? formatDuration(duration) : "--:--"}`;
}

function queueModes(appState: AppState): string {
  const shuffle = appState.queue.shuffle ? "on" : "off";
  const repeat = appState.queue.repeatAll ? "all" : "off";
  const volume = appState.volume.ready ? `${appState.volume.percent}%` : "not ready";
  return `Shuffle: ${shuffle} | Repeat: ${repeat} | Volume: ${volume}`;
}

function queueAvailability(appState: AppState, uiState: UiState): string {
  const selected = selectedQueueEntry(appState, uiState);
  const current = currentQueueEntry(appState);
  const entry = current ?? selected;
  if (!entry) return "Availability: no queued Tracks";

  return `Availability: ${entry.track.title} - ${availabilityText(entry.availability)}`;
}

function queueLine(appState: AppState, uiState: UiState, entry: QueueEntry, index: number): string {
  const state = queueRowState(appState, uiState, entry, index);
  return row(`${entry.track.title} [${state.status}]`, state.selected, state.focused);
}

function expandedQueueLine(appState: AppState, uiState: UiState, entry: QueueEntry, index: number): string {
  const state = queueRowState(appState, uiState, entry, index);
  const duration = typeof entry.track.durationSeconds === "number"
    ? ` - ${formatDuration(entry.track.durationSeconds)}`
    : "";
  const current = state.active ? " - current" : "";

  return row(
    `${index + 1}. ${entry.track.title} - ${entry.track.providerLabel}${duration} - ${state.status}${current}`,
    state.selected,
    state.focused,
  );
}

function queueRowState(appState: AppState, uiState: UiState, entry: QueueEntry, index: number) {
  const selected = index === clampIndex(uiState.selectedQueueIndex, appState.queue.entries.length);
  const active = sameIdentity(entry.track.identity, appState.playback.currentTrackIdentity);
  return {
    selected,
    active,
    focused: uiState.focusedPane === "queue",
    status: queueEntryStatus(appState, entry, active),
  };
}

function queueEntryStatus(appState: AppState, entry: QueueEntry, active: boolean): string {
  if (entry.availability.status === "unavailable") {
    return `unavailable: ${entry.availability.reason}`;
  }

  if (active) return appState.playback.status;
  if (entry.availability.status === "available") return "available";
  return "queued";
}

function currentQueueEntry(appState: AppState): QueueEntry | undefined {
  return appState.queue.entries.find((entry) =>
    sameIdentity(entry.track.identity, appState.playback.currentTrackIdentity),
  );
}

function selectedQueueEntry(appState: AppState, uiState: UiState): QueueEntry | undefined {
  return appState.queue.entries[clampIndex(uiState.selectedQueueIndex, appState.queue.entries.length)];
}

function availabilityText(availability: QueueEntry["availability"]): string {
  if (availability.status === "unavailable") return `unavailable: ${availability.reason}`;
  return availability.status;
}

function formatDuration(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function row(label: string, selected: boolean, focused: boolean): string {
  const cursor = selected ? ">" : " ";
  const focus = selected && focused ? "*" : " ";
  return `${cursor}${focus} ${label}`;
}

function twoColumns(left: string, right: string, leftWidth: number): string {
  const leftRows = left.split("\n");
  const rightRows = right.split("\n");
  const rows: string[] = [];
  const count = Math.max(leftRows.length, rightRows.length);
  for (let index = 0; index < count; index += 1) {
    rows.push(`${(leftRows[index] ?? "").padEnd(leftWidth)}${rightRows[index] ?? ""}`);
  }
  return rows.join("\n");
}
