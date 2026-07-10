import {
  identityKey,
  type AppIntent,
  type AppState,
  type PlayableTarget,
  type Track,
  type UiState,
} from "./domain";
import type { AppStateSnapshot } from "./state-publication";
import { globalSearchResultAt, globalSearchRetryProviderId, globalSearchRows } from "./global-search";

export type ActionContext = {
  readonly appState: Readonly<AppState> | AppStateSnapshot;
  readonly uiState: Readonly<UiState>;
  readonly selectedPlayableTarget?: PlayableTarget | null;
  readonly selectedProviderId?: string | null;
};

export type UiActionIntent = {
  type: "openOverlay";
  kind: "music-picker" | "shortcut-help" | "command-palette" | "youtube-url";
  focus: "results" | "search" | "input";
} | {
  type: "requestConfirmation";
  kind: "clear-queue" | "cancel-download" | "quit-download";
} | {
  type: "routeUi";
  operation: UiRouteOperation;
};

export type UiRouteOperation =
  | "move-down" | "move-up" | "first" | "last"
  | "half-page-down" | "half-page-up" | "page-down" | "page-up"
  | "open" | "back" | "dismiss" | "search-filters" | "retry" | "help-filter"
  | "cycle-provider-filter" | "cycle-result-type-filter";

export type ActionIntent = AppIntent | UiActionIntent;

type ActionBinding = { key: string; label: string };

export type ActionDefinition = {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly bindings: readonly ActionBinding[];
  readonly applies: (context: ActionContext) => boolean;
  readonly enabled: (context: ActionContext) => boolean;
  readonly disabledReason: (context: ActionContext) => string | null;
  readonly createIntent: (context: ActionContext) => ActionIntent | null;
  readonly scope: "context" | "global";
  readonly contextLayer?: "underlying" | "overlay" | "surface";
};

export type ResolvedAction = {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly bindings: readonly string[];
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly intent: ActionIntent | null;
  readonly scope: "context" | "global";
};

export type ActionRegistry = readonly ActionDefinition[];

const always = () => true;
const neverDisabled = () => null;

export function createActionRegistry(): ActionRegistry {
  return [
    uiAction("picker.open-navigation", "Music", ["browse", "providers"], "o", "o", {
      type: "openOverlay", kind: "music-picker", focus: "results",
    }),
    uiAction("picker.open-search", "Global Search", ["find music"], "/", "/", {
      type: "openOverlay", kind: "music-picker", focus: "search",
    }),
    discoveryUiAction("help.open", "Help", ["shortcuts"], "?", "?", {
      type: "openOverlay", kind: "shortcut-help", focus: "results",
    }),
    discoveryUiAction("palette.open", "Commands", ["command palette"], ":", ":", {
      type: "openOverlay", kind: "command-palette", focus: "search",
    }),
    {
      id: "download.open",
      scope: "context",
      name: "YouTube URL Download",
      aliases: ["download youtube"],
      bindings: [{ key: "u", label: "u" }],
      applies: (context) => context.uiState.activeTargetId === "queue" && context.uiState.overlays.length === 0,
      enabled: always,
      disabledReason: neverDisabled,
      createIntent: (context) => ({
        type: "openOverlay", kind: "youtube-url",
        focus: context.appState.downloads.active ? "results" : "input",
      }),
    },
    youtubeUrlDownloadAction(),
    routeAction("navigation.move-down", "Move Down", ["next row"], [
      { key: "j", label: "j" }, { key: "\x1b[B", label: "Down" },
    ], "move-down", isListContext),
    routeAction("navigation.move-up", "Move Up", ["previous row"], [
      { key: "k", label: "k" }, { key: "\x1b[A", label: "Up" },
    ], "move-up", isListContext),
    routeAction("navigation.first", "First Row", ["go to top"], [
      { key: "g", label: "gg" }, { key: "\x1b[H", label: "Home" },
    ], "first", isListContext),
    routeAction("navigation.last", "Last Row", ["go to bottom"], [
      { key: "G", label: "G" }, { key: "\x1b[F", label: "End" },
    ], "last", isListContext),
    routeAction("navigation.half-page-down", "Half Page Down", ["scroll down"], [
      { key: "\x04", label: "Ctrl-d" },
    ], "half-page-down", isListContext),
    routeAction("navigation.half-page-up", "Half Page Up", ["scroll up"], [
      { key: "\x15", label: "Ctrl-u" },
    ], "half-page-up", isListContext),
    routeAction("navigation.page-down", "Page Down", ["next page"], [
      { key: "\x1b[6~", label: "Page Down" },
    ], "page-down", isListContext),
    routeAction("navigation.page-up", "Page Up", ["previous page"], [
      { key: "\x1b[5~", label: "Page Up" },
    ], "page-up", isListContext),
    routeAction("navigation.open", "Open", ["inspect"], [
      { key: "l", label: "l" }, { key: "\x1b[C", label: "Right" },
    ], "open", isMusicResultsContext),
    routeAction("navigation.back", "Back", ["parent"], [
      { key: "h", label: "h" }, { key: "\x1b[D", label: "Left" },
      { key: "\x7f", label: "Backspace" },
    ], "back", isMusicResultsContext),
    routeAction("overlay.dismiss", "Dismiss Overlay", ["close"], [
      { key: "\x1b", label: "Esc" }, { key: "q", label: "q" },
    ], "dismiss", isNonTextOverlayContext, "overlay"),
    routeAction("search.filters", "Search Filters", ["filter results"], [
      { key: "f", label: "f" },
    ], "search-filters", isMusicResultsContext),
    routeAction("search.filter-provider", "Cycle Provider Filter", ["provider filter"], [
      { key: "p", label: "p" },
    ], "cycle-provider-filter", isMusicFilterContext, "surface"),
    routeAction("search.filter-result-type", "Cycle Result Type Filter", ["type filter"], [
      { key: "t", label: "t" },
    ], "cycle-result-type-filter", isMusicFilterContext, "surface"),
    routeAction("search.retry", "Retry", ["retry failed provider"], [
      { key: "r", label: "r" },
    ], "retry", canRetryContext),
    routeAction("help.filter", "Filter Help", ["search shortcuts"], [
      { key: "/", label: "/" },
    ], "help-filter", isHelpResultsContext, "surface"),
    queueTrackAction({
      id: "queue.play-next",
      name: "Play Next",
      aliases: ["queue next", "add next"],
      bindings: [{ key: "\r", label: "Enter" }],
      createIntent: (track) => ({ type: "playNext", target: track }),
    }),
    queueTrackAction({
      id: "queue.play-now",
      name: "Play Now",
      aliases: ["play immediately"],
      bindings: [{ key: "\x1b[13;2u", label: "Shift+Enter" }],
      createIntent: (track) => ({ type: "playNow", target: track }),
    }),
    queueTrackAction({
      id: "queue.remove",
      name: "Remove from Queue",
      aliases: ["delete track"],
      bindings: [{ key: "x", label: "x" }, { key: "\x1b[3~", label: "Delete" }],
      createIntent: (track) => ({ type: "removeQueueTrack", identity: track.identity }),
    }),
    queueTrackAction({
      id: "queue.move-down",
      name: "Move Track Down",
      aliases: ["reorder down"],
      bindings: [{ key: "J", label: "J" }],
      createIntent: (track) => ({ type: "moveQueueTrack", identity: track.identity, delta: 1 }),
    }),
    queueTrackAction({
      id: "queue.move-up",
      name: "Move Track Up",
      aliases: ["reorder up"],
      bindings: [{ key: "K", label: "K" }],
      createIntent: (track) => ({ type: "moveQueueTrack", identity: track.identity, delta: -1 }),
    }),
    providerTargetAction({
      id: "provider.play-next",
      name: "Play Next",
      aliases: ["queue next", "add next"],
      bindings: [{ key: "\r", label: "Enter" }],
      createIntent: (target) => ({ type: "playNext", target }),
    }),
    providerTargetAction({
      id: "provider.play-now",
      name: "Play Now",
      aliases: ["play immediately"],
      bindings: [{ key: "\x1b[13;2u", label: "Shift+Enter" }],
      createIntent: (target) => ({ type: "playNow", target }),
    }),
    {
      id: "provider.refresh",
      scope: "context",
      name: "Refresh Provider",
      aliases: ["reload provider"],
      bindings: [],
      applies: (context) => providerSupports(context, "refresh"),
      enabled: always,
      disabledReason: neverDisabled,
      createIntent: (context) => ({
        type: "providerOperation",
        providerId: selectedProviderId(context) ?? context.uiState.activeTargetId,
        operation: "refresh",
      }),
    },
    {
      id: "provider.retry",
      scope: "context",
      name: "Retry Provider",
      aliases: ["reconnect provider"],
      bindings: [],
      applies: (context) => providerSupports(context, "retry"),
      enabled: always,
      disabledReason: neverDisabled,
      createIntent: (context) => ({
        type: "providerOperation",
        providerId: selectedProviderId(context) ?? context.uiState.activeTargetId,
        operation: "retry",
      }),
    },
    boundAction("provider.cancel-open", "Cancel Local Open", ["cancel open"], [
      { key: "\x1b", label: "Esc" },
    ], { type: "providerOperation", providerId: "local", operation: "cancel-open" }),
    {
      id: "player.toggle-play-pause",
      scope: "global",
      name: "Play / Pause / Resume",
      aliases: ["play", "pause", "resume"],
      bindings: [{ key: " ", label: "Space" }],
      applies: always,
      enabled: (context) => Boolean(context.appState.playback.currentTrackIdentity || selectedQueueTrack(context)),
      disabledReason: () => "Queue is empty",
      createIntent: (context) => {
        if (context.appState.playback.currentTrackIdentity) {
          return { type: "playerOperation", operation: "toggle-play-pause" };
        }
        const track = selectedQueueTrack(context);
        return track ? { type: "playNow", target: track } : null;
      },
    },
    simpleAction("player.stop", "Stop", [], "s", "s", { type: "playerOperation", operation: "stop" }),
    simpleAction("player.next", "Next Track", ["next"], "n", "n", { type: "playerOperation", operation: "next-track" }),
    simpleAction("player.previous", "Previous Track", ["previous"], "p", "p", { type: "playerOperation", operation: "previous-track" }),
    simpleAction("queue.shuffle", "Toggle Shuffle", ["shuffle"], "z", "z", { type: "playerOperation", operation: "toggle-shuffle" }),
    paletteAction("queue.repeat-all", "Toggle Repeat All", ["repeat"], {
      type: "playerOperation", operation: "toggle-repeat-all",
    }),
    {
      id: "queue.clear",
      scope: "context",
      name: "Clear Queue",
      aliases: ["empty queue"],
      bindings: [{ key: "c", label: "c" }],
      applies: (context) => context.uiState.activeTargetId === "queue",
      enabled: (context) => context.appState.queue.entries.length > 0,
      disabledReason: () => "Queue is empty",
      createIntent: () => ({ type: "requestConfirmation", kind: "clear-queue" }),
    },
    simpleAction("player.seek-backward", "Seek Backward", ["rewind"], "[", "[", {
      type: "playerOperation", operation: "seek", seconds: -5,
    }),
    simpleAction("player.seek-forward", "Seek Forward", ["fast forward"], "]", "]", {
      type: "playerOperation", operation: "seek", seconds: 5,
    }),
    simpleAction("player.volume-down", "Volume Down", ["quieter"], "-", "-", {
      type: "playerOperation", operation: "adjust-volume", delta: -5,
    }),
    simpleAction("player.volume-up", "Volume Up", ["louder"], "+", "+", {
      type: "playerOperation", operation: "adjust-volume", delta: 5,
    }),
    {
      id: "download.cancel",
      scope: "context",
      name: "Cancel YouTube Download",
      aliases: ["stop download"],
      bindings: [{ key: "x", label: "x" }],
      contextLayer: "overlay",
      applies: (context) => context.appState.downloads.active
        && context.uiState.overlays.at(-1)?.kind === "youtube-url"
        && context.uiState.overlays.at(-1)?.focus === "results",
      enabled: (context) => context.appState.downloads.active,
      disabledReason: () => "No YouTube download is active",
      createIntent: () => ({ type: "requestConfirmation", kind: "cancel-download" }),
    },
    boundAction("app.quit", "Quit", ["exit"], [
      { key: "q", label: "q" },
      { key: "\u0003", label: "Ctrl-c" },
    ], { type: "playerOperation", operation: "quit" }, "global"),
  ];
}

function selectedProviderId(context: ActionContext): string | null {
  return context.selectedProviderId
    ?? context.uiState.overlays.at(-1)?.providerLocation?.providerId
    ?? (context.uiState.activeTargetId === "queue" ? null : context.uiState.activeTargetId);
}

function providerSupports(context: ActionContext, operation: "refresh" | "retry"): boolean {
  const providerId = selectedProviderId(context);
  return Boolean(providerId && context.appState.providers[providerId]?.capabilities.operations.includes(operation));
}

export function discoveryActions(registry: ActionRegistry, context: ActionContext): ResolvedAction[] {
  return registry
    .filter((action) => action.applies(contextForAction(action, context)))
    .map((action) => resolveAction(action, contextForAction(action, context)))
    .sort((left, right) => Number(left.scope === "global") - Number(right.scope === "global"));
}

export const footerActions = discoveryActions;
export const shortcutHelpActions = discoveryActions;
export const commandPaletteActions = discoveryActions;

export function searchDiscoveryActions(
  registry: ActionRegistry,
  context: ActionContext,
  query: string,
): ResolvedAction[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return discoveryActions(registry, context);
  return discoveryActions(registry, context).filter((action) => {
    const searchable = [action.name, ...action.aliases, ...action.bindings].join(" ").toLocaleLowerCase();
    return words.every((word) => searchable.includes(word));
  });
}

export function actionForBinding(
  registry: ActionRegistry,
  key: string,
  context: ActionContext,
): ResolvedAction | null {
  const candidates = [...registry].sort((left, right) =>
    contextLayerPriority(right.contextLayer) - contextLayerPriority(left.contextLayer));
  const action = candidates.find((candidate) => candidate.applies(contextForAction(candidate, context))
    && candidate.bindings.some((binding) => binding.key === key));
  return action ? resolveAction(action, contextForAction(action, context)) : null;
}

function youtubeUrlDownloadAction(): ActionDefinition {
  return {
    id: "download.start",
    scope: "context",
    name: "Download YouTube URL",
    aliases: [],
    bindings: [{ key: "\r", label: "Enter" }],
    applies: (context) => context.uiState.overlays.at(-1)?.kind === "youtube-url",
    enabled: always,
    disabledReason: neverDisabled,
    createIntent: (context) => ({
      type: "downloadOperation",
      operation: "start",
      url: context.uiState.overlays.at(-1)?.query ?? "",
    }),
  };
}

function queueTrackAction(options: {
  id: string;
  name: string;
  aliases: readonly string[];
  bindings: readonly ActionBinding[];
  createIntent: (track: Track) => AppIntent;
}): ActionDefinition {
  return {
    ...options,
    scope: "context",
    applies: (context) => context.uiState.activeTargetId === "queue"
      && context.uiState.overlays.length === 0,
    enabled: (context) => selectedQueueTrack(context) !== null,
    disabledReason: (context) => selectedQueueTrack(context) ? null : "Queue is empty",
    createIntent: (context) => {
      const track = selectedQueueTrack(context);
      return track ? options.createIntent(track) : null;
    },
  };
}

function providerTargetAction(options: {
  id: string;
  name: string;
  aliases: readonly string[];
  bindings: readonly ActionBinding[];
  createIntent: (target: PlayableTarget) => AppIntent;
}): ActionDefinition {
  return {
    ...options,
    scope: "context",
    applies: (context) => selectedProviderTarget(context) !== null
      && (context.uiState.activeTargetId !== "queue" || selectedOverlayTarget(context) !== null),
    enabled: (context) => selectedProviderTarget(context) !== null,
    disabledReason: (context) => selectedProviderTarget(context) ? null : "No playable target selected",
    createIntent: (context) => {
      const target = selectedProviderTarget(context);
      return target ? options.createIntent(target) : null;
    },
  };
}

function simpleAction(
  id: string,
  name: string,
  aliases: readonly string[],
  key: string,
  label: string,
  intent: AppIntent,
): ActionDefinition {
  return boundAction(id, name, aliases, [{ key, label }], intent, "global");
}

function paletteAction(
  id: string,
  name: string,
  aliases: readonly string[],
  intent: AppIntent,
): ActionDefinition {
  return boundAction(id, name, aliases, [], intent, "global");
}

function routeAction(
  id: string,
  name: string,
  aliases: readonly string[],
  bindings: readonly ActionBinding[],
  operation: UiRouteOperation,
  applies: (context: ActionContext) => boolean,
  contextLayer: ActionDefinition["contextLayer"] = "underlying",
): ActionDefinition {
  return {
    id, name, aliases, bindings, applies, scope: "context", contextLayer,
    enabled: always,
    disabledReason: neverDisabled,
    createIntent: () => ({ type: "routeUi", operation }),
  };
}

function uiAction(
  id: string,
  name: string,
  aliases: readonly string[],
  key: string,
  label: string,
  intent: UiActionIntent,
): ActionDefinition {
  return {
    id,
    scope: "context",
    name,
    aliases,
    bindings: [{ key, label }],
    applies: (context) => context.uiState.activeTargetId === "queue" && context.uiState.overlays.length === 0,
    enabled: always,
    disabledReason: neverDisabled,
    createIntent: () => intent,
  };
}

function discoveryUiAction(
  id: string,
  name: string,
  aliases: readonly string[],
  key: string,
  label: string,
  intent: UiActionIntent,
): ActionDefinition {
  return {
    id, name, aliases, bindings: [{ key, label }], scope: "global",
    applies: always,
    enabled: always,
    disabledReason: neverDisabled,
    createIntent: () => intent,
  };
}

function boundAction(
  id: string,
  name: string,
  aliases: readonly string[],
  bindings: readonly ActionBinding[],
  intent: AppIntent,
  scope: ActionDefinition["scope"] = "context",
): ActionDefinition {
  return {
    id,
    scope,
    name,
    aliases,
    bindings,
    applies: always,
    enabled: always,
    disabledReason: neverDisabled,
    createIntent: () => intent,
  };
}

function resolveAction(action: ActionDefinition, context: ActionContext): ResolvedAction {
  const enabled = action.enabled(context);
  return {
    id: action.id,
    name: action.name,
    aliases: [...action.aliases],
    bindings: action.bindings.map((binding) => binding.label),
    enabled,
    disabledReason: enabled ? null : action.disabledReason(context),
    intent: enabled ? action.createIntent(context) : null,
    scope: action.scope,
  };
}

function underlyingDiscoveryContext(context: ActionContext): ActionContext {
  const overlay = context.uiState.overlays.at(-1);
  if (overlay?.kind !== "shortcut-help" && overlay?.kind !== "command-palette") return context;
  return {
    ...context,
    uiState: { ...context.uiState, overlays: context.uiState.overlays.slice(0, -1) },
  };
}

function contextForAction(action: ActionDefinition, context: ActionContext): ActionContext {
  if (action.contextLayer === "overlay") return context;
  if (action.contextLayer === "surface") {
    return context.uiState.overlays.at(-1)?.kind === "command-palette"
      ? { ...context, uiState: { ...context.uiState, overlays: context.uiState.overlays.slice(0, -1) } }
      : context;
  }
  return underlyingDiscoveryContext(context);
}

function contextLayerPriority(layer: ActionDefinition["contextLayer"]): number {
  return layer === "overlay" ? 2 : layer === "surface" ? 1 : 0;
}

function isListContext(context: ActionContext): boolean {
  const overlay = context.uiState.overlays.at(-1);
  return overlay?.focus === "results"
    || (!overlay && context.uiState.activeTargetId === "queue" && context.uiState.focusedPane === "queue");
}

function isMusicResultsContext(context: ActionContext): boolean {
  const overlay = context.uiState.overlays.at(-1);
  return overlay?.kind === "music-picker" && overlay.focus === "results";
}

function isMusicFilterContext(context: ActionContext): boolean {
  const overlay = context.uiState.overlays.at(-1);
  return overlay?.kind === "music-picker" && overlay.focus === "filter";
}

function isNonTextOverlayContext(context: ActionContext): boolean {
  const overlay = context.uiState.overlays.at(-1);
  return Boolean(overlay && (overlay.focus === "results"
    || overlay.kind === "command-palette"
    || overlay.kind === "youtube-url"));
}

function isHelpResultsContext(context: ActionContext): boolean {
  const overlay = context.uiState.overlays.at(-1);
  return overlay?.kind === "shortcut-help" && overlay.focus === "results";
}

function canRetryContext(context: ActionContext): boolean {
  const overlay = context.uiState.overlays.at(-1);
  if (overlay?.kind !== "music-picker" || overlay.focus !== "results") return false;
  if (context.appState.globalSearch.query) {
    return Boolean(globalSearchRetryProviderId(
      globalSearchRows(context.appState.globalSearch)[overlay.selectedResultIndex ?? 0],
    ));
  }
  return providerSupports(context, "retry");
}

function selectedQueueTrack(context: ActionContext): Track | null {
  const selectedKey = context.uiState.selectedQueueIdentity
    ? identityKey(context.uiState.selectedQueueIdentity)
    : null;
  if (!selectedKey) return null;
  return context.appState.queue.entries.find((entry) => identityKey(entry.track.identity) === selectedKey)?.track ?? null;
}

function selectedProviderTarget(context: ActionContext): PlayableTarget | null {
  if (context.selectedPlayableTarget) return context.selectedPlayableTarget;
  const overlay = context.uiState.overlays.at(-1);
  if (overlay?.focus === "results") return selectedOverlayTarget(context);
  const providerId = context.uiState.activeTargetId;
  const index = context.uiState.selectedContentIndexByTarget[providerId] ?? 0;
  return providerTargetAt(context, providerId, context.uiState.providerLocation, index);
}

function selectedOverlayTarget(context: ActionContext): PlayableTarget | null {
  const overlay = context.uiState.overlays.at(-1);
  if (overlay?.focus === "results" && context.appState.globalSearch.query) {
    return globalSearchResultAt(context.appState.globalSearch, overlay.selectedResultIndex ?? 0)?.target ?? null;
  }
  const location = overlay?.focus === "results" ? overlay.providerLocation : undefined;
  const providerId = location?.providerId;
  if (!overlay || !location || !providerId) return null;
  return providerTargetAt(context, providerId, location, overlay.selectedResultIndex ?? 0);
}

function providerTargetAt(
  context: ActionContext,
  providerId: string,
  location: UiState["providerLocation"],
  index: number,
): PlayableTarget | null {
  const provider = context.appState.providers[providerId];
  if (!provider) return null;
  if ("listVisibleTracks" in provider) {
    if (provider.playableTargetAt) return provider.playableTargetAt(location, index) ?? null;
    return provider.listVisibleTracks()[index] ?? null;
  }
  return provider.visibleTracks[index] as Track | undefined ?? null;
}
