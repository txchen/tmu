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
  const providerTracks = visibleProviderTracks(appState, uiState);
  const providerLines = providerTracks.map((track, index) => {
    const selected = index === selectedContentIndex(uiState);
    return row(`${track.title}  ${track.providerLabel}`, selected, uiState.focusedPane === "content");
  });
  const providerSurfaceHealthLines = providerSurfaceHealthLinesFor(appState, uiState.activeTargetId);

  return {
    title: "TMU",
    navigationTargets: NAVIGATION_TARGETS.map((target) => ({
      ...target,
      selected: target.id === uiState.activeTargetId,
      focused: uiState.focusedPane === "targets" && target.id === uiState.activeTargetId,
    })),
    providerSurface: {
      title: activeTarget.label,
      lines: [...providerSurfaceHealthLines, ...providerLines],
      emptyMessage: emptyMessageFor(activeTarget.id),
    },
    queuePlayer: {
      title: "Queue / Player",
      nowPlaying: nowPlaying(appState),
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

function selectedContentIndex(uiState: UiState): number {
  return uiState.selectedContentIndexByTarget[uiState.activeTargetId] ?? 0;
}

function emptyMessageFor(targetId: NavigationTarget["id"]): string {
  if (targetId === "queue") return "Queue is shown in the persistent Queue / Player region";
  if (targetId === "youtube-url-download") {
    return "Provider Browsing Surface placeholder for the YouTube URL Download Flow";
  }
  return "Provider Browsing Surface placeholder; provider behavior lands in later slices";
}

function providerSurfaceHealthLinesFor(appState: AppState, targetId: NavigationTarget["id"]): string[] {
  if (targetId !== "youtube-url-download") return [];

  const message = youtubeDownloadHealthMessage(appState.dependencyHealth);
  return message ? [`! ${message}`] : [];
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
  const current = appState.queue.entries.find((entry) =>
    sameIdentity(entry.track.identity, appState.playback.currentTrackIdentity),
  );
  if (!current || appState.playback.status === "idle" || appState.playback.status === "stopped") {
    return "Idle - add a Track to the shared Queue";
  }

  const verb = appState.playback.status === "paused" ? "Paused" : "Playing";
  return `${verb} ${current.track.title}`;
}

function queueLine(appState: AppState, uiState: UiState, entry: QueueEntry, index: number): string {
  const selected = index === clampIndex(uiState.selectedQueueIndex, appState.queue.entries.length);
  const active = sameIdentity(entry.track.identity, appState.playback.currentTrackIdentity);
  const status = active
    ? appState.playback.status
    : entry.availability.status === "unavailable"
      ? "unavailable"
      : "queued";
  return row(`${entry.track.title} [${status}]`, selected, uiState.focusedPane === "queue");
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
