import {
  identityKey,
  type AppIntent,
  type AppState,
  type PlayableTarget,
  type Track,
  type UiState,
} from "./domain";
import type { AppStateSnapshot } from "./state-publication";

export type ActionContext = {
  readonly appState: Readonly<AppState> | AppStateSnapshot;
  readonly uiState: Readonly<UiState>;
  readonly selectedPlayableTarget?: PlayableTarget | null;
};

export type UiActionIntent = {
  type: "openOverlay";
  kind: "music-picker" | "shortcut-help" | "command-palette" | "youtube-url";
  focus: "results" | "search" | "input";
} | {
  type: "requestConfirmation";
  kind: "clear-queue";
};

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
};

export type ResolvedAction = {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly bindings: readonly string[];
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly intent: ActionIntent | null;
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
    uiAction("help.open", "Help", ["shortcuts"], "?", "?", {
      type: "openOverlay", kind: "shortcut-help", focus: "search",
    }),
    uiAction("palette.open", "Commands", ["command palette"], ":", ":", {
      type: "openOverlay", kind: "command-palette", focus: "search",
    }),
    uiAction("download.open", "YouTube URL Download", ["download youtube"], "u", "u", {
      type: "openOverlay", kind: "youtube-url", focus: "input",
    }),
    promptAction("provider.open-local-path", "Open Local Path", "local-open-path", (query) => ({
      type: "providerOperation", providerId: "local", operation: "open-path", path: query,
    })),
    promptAction("provider.query-navidrome", "Query Navidrome Tracks", "navidrome-search", (query) => ({
      type: "providerOperation", providerId: "navidrome", operation: "browse-query", query,
    })),
    promptAction("download.start", "Download YouTube URL", "youtube-url", (url) => ({
      type: "downloadOperation", operation: "start", url,
    })),
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
      name: "Refresh Provider",
      aliases: ["reload provider"],
      bindings: [{ key: "f", label: "f" }],
      applies: (context) => context.uiState.activeTargetId === "navidrome",
      enabled: always,
      disabledReason: neverDisabled,
      createIntent: (context) => ({
        type: "providerOperation",
        providerId: context.uiState.activeTargetId,
        operation: "refresh",
      }),
    },
    boundAction("provider.cancel-open", "Cancel Local Open", ["cancel open"], [
      { key: "\x1b", label: "Esc" },
    ], { type: "providerOperation", providerId: "local", operation: "cancel-open" }),
    {
      id: "legacy.unsupported-enqueue",
      name: "Unsupported legacy enqueue binding",
      aliases: [],
      bindings: [{ key: "a", label: "a" }],
      applies: () => false,
      enabled: () => false,
      disabledReason: () => "Use Enter for Play Next",
      createIntent: () => null,
    },
    {
      id: "player.toggle-play-pause",
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
    simpleAction("queue.repeat-all", "Toggle Repeat All", ["repeat"], "r", "r", { type: "playerOperation", operation: "toggle-repeat-all" }),
    {
      id: "queue.clear",
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
    simpleAction("persistence.save", "Save Last Queue Snapshot", ["save queue"], "S", "S", {
      type: "persistenceOperation", operation: "save",
    }),
    simpleAction("persistence.restore", "Restore Last Queue Snapshot", ["restore queue"], "R", "R", {
      type: "persistenceOperation", operation: "restore",
    }),
    {
      id: "download.cancel",
      name: "Cancel YouTube Download",
      aliases: ["stop download"],
      bindings: [{ key: "d", label: "d" }],
      applies: (context) => context.appState.downloads.active,
      enabled: (context) => context.appState.downloads.active,
      disabledReason: () => "No YouTube download is active",
      createIntent: () => ({ type: "downloadOperation", operation: "cancel" }),
    },
    boundAction("app.quit", "Quit", ["exit"], [
      { key: "q", label: "q" },
      { key: "\u0003", label: "Ctrl-c" },
    ], { type: "playerOperation", operation: "quit" }),
  ];
}

export function discoveryActions(registry: ActionRegistry, context: ActionContext): ResolvedAction[] {
  return registry.filter((action) => action.applies(context)).map((action) => resolveAction(action, context));
}

export const footerActions = discoveryActions;
export const shortcutHelpActions = discoveryActions;
export const commandPaletteActions = discoveryActions;

export function actionForBinding(
  registry: ActionRegistry,
  key: string,
  context: ActionContext,
): ResolvedAction | null {
  const action = registry.find((candidate) => candidate.applies(context)
    && candidate.bindings.some((binding) => binding.key === key));
  return action ? resolveAction(action, context) : null;
}

function promptAction(
  id: string,
  name: string,
  prompt: NonNullable<UiState["activePrompt"]>,
  createIntent: (query: string) => AppIntent,
): ActionDefinition {
  return {
    id,
    name,
    aliases: [],
    bindings: [{ key: "\r", label: "Enter" }],
    applies: (context) => context.uiState.activePrompt === prompt,
    enabled: always,
    disabledReason: neverDisabled,
    createIntent: (context) => createIntent(context.uiState.promptInput),
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
    applies: (context) => context.uiState.activeTargetId === "queue",
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
    applies: (context) => context.uiState.activeTargetId !== "queue" && selectedProviderTarget(context) !== null,
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
  return boundAction(id, name, aliases, [{ key, label }], intent);
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
    name,
    aliases,
    bindings: [{ key, label }],
    applies: (context) => context.uiState.activeTargetId === "queue" && context.uiState.overlays.length === 0,
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
): ActionDefinition {
  return {
    id,
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
  };
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
  const providerId = context.uiState.activeTargetId;
  const provider = context.appState.providers[providerId];
  if (!provider) return null;
  const index = context.uiState.selectedContentIndexByTarget[providerId] ?? 0;
  if ("listVisibleTracks" in provider) {
    return provider.playableTargetAt?.(context.uiState.providerLocation, index)
      ?? provider.listVisibleTracks()[index]
      ?? null;
  }
  return provider.visibleTracks[index] ?? null;
}
