import {
  identityKey,
  type AppIntent,
  type AppState,
  type PlayableTarget,
  type Track,
  type UiState,
} from "./domain";
import type { UiStateAction } from "./ui-state";

export type ActionContext = {
  readonly appState: Readonly<AppState>;
  readonly uiState: Readonly<UiState>;
  readonly selectedPlayableTarget?: PlayableTarget | null;
};

type ActionBinding = { key: string; label: string };

export type ActionDefinition = {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly bindings: readonly ActionBinding[];
  readonly applies: (context: ActionContext) => boolean;
  readonly enabled: (context: ActionContext) => boolean;
  readonly disabledReason: (context: ActionContext) => string | null;
  readonly createIntent: (context: ActionContext) => AppIntent | null;
};

export type ResolvedAction = {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly bindings: readonly string[];
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly intent: AppIntent | null;
};

export type ActionRegistry = readonly ActionDefinition[];

const always = () => true;
const neverDisabled = () => null;

export function createActionRegistry(): ActionRegistry {
  return [
    promptAction("provider.open-local-path", "Open Local Path", "local-open-path", (query) => ({
      type: "providerOperation", providerId: "local", operation: "open-path", path: query,
    })),
    promptAction("provider.search-navidrome", "Search Navidrome", "navidrome-search", (query) => ({
      type: "providerOperation", providerId: "navidrome", operation: "search", query,
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
      bindings: [{ key: "x", label: "x" }],
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
    {
      id: "provider.play-next",
      name: "Play Next",
      aliases: ["queue next", "add next"],
      bindings: [{ key: "\r", label: "Enter" }],
      applies: (context) => context.uiState.activeTargetId !== "queue" && selectedProviderTarget(context) !== null,
      enabled: (context) => selectedProviderTarget(context) !== null,
      disabledReason: (context) => selectedProviderTarget(context) ? null : "No playable target selected",
      createIntent: (context) => {
        const target = selectedProviderTarget(context);
        return target ? { type: "playNext", target } : null;
      },
    },
    {
      id: "provider.play-now",
      name: "Play Now",
      aliases: ["play immediately"],
      bindings: [{ key: "\x1b[13;2u", label: "Shift+Enter" }],
      applies: (context) => context.uiState.activeTargetId !== "queue" && selectedProviderTarget(context) !== null,
      enabled: (context) => selectedProviderTarget(context) !== null,
      disabledReason: (context) => selectedProviderTarget(context) ? null : "No playable target selected",
      createIntent: (context) => {
        const target = selectedProviderTarget(context);
        return target ? { type: "playNow", target } : null;
      },
    },
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
    simpleAction("player.toggle-play-pause", "Play / Pause / Resume", ["play", "pause", "resume"], " ", "Space", {
      type: "playerOperation", operation: "toggle-play-pause",
    }),
    simpleAction("player.stop", "Stop", [], "s", "s", { type: "playerOperation", operation: "stop" }),
    simpleAction("player.next", "Next Track", ["next"], "n", "n", { type: "playerOperation", operation: "next-track" }),
    simpleAction("player.previous", "Previous Track", ["previous"], "p", "p", { type: "playerOperation", operation: "previous-track" }),
    simpleAction("queue.shuffle", "Toggle Shuffle", ["shuffle"], "z", "z", { type: "playerOperation", operation: "toggle-shuffle" }),
    simpleAction("queue.repeat-all", "Toggle Repeat All", ["repeat"], "r", "r", { type: "playerOperation", operation: "toggle-repeat-all" }),
    simpleAction("queue.clear", "Clear Queue", ["empty queue"], "c", "c", { type: "clearQueue" }),
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

export type RootInputRouterOptions = {
  registry: ActionRegistry;
  appState: () => Readonly<AppState>;
  uiState: {
    readonly snapshot: Readonly<UiState>;
    dispatch(action: UiStateAction): Readonly<UiState>;
  };
  dispatchApp: (intent: AppIntent) => Promise<void> | void;
  now?: () => number;
  timers?: {
    setTimeout(callback: () => void, delayMs: number): unknown;
    clearTimeout(timer: unknown): void;
  };
};

export class RootInputRouter {
  private readonly registry: ActionRegistry;
  private readonly appState: () => Readonly<AppState>;
  private readonly uiState: RootInputRouterOptions["uiState"];
  private readonly dispatchApp: (intent: AppIntent) => Promise<void> | void;
  private readonly now: () => number;
  private readonly timers: NonNullable<RootInputRouterOptions["timers"]>;
  private pendingChordTimer: unknown | null = null;

  constructor(options: RootInputRouterOptions) {
    this.registry = options.registry;
    this.appState = options.appState;
    this.uiState = options.uiState;
    this.dispatchApp = options.dispatchApp;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    };
  }

  async route(key: string): Promise<boolean> {
    if (key === "\u0003") {
      await this.dispatchBinding(key);
      return true;
    }

    const overlay = this.uiState.snapshot.overlays.at(-1);
    if (overlay && isTextEntryFocus(overlay.focus)) {
      if (key === "\x1b") {
        this.uiState.dispatch({ type: "dismissOverlay", queueIdentities: queueIdentities(this.appState()) });
      } else if (key === "\x7f" || key === "\b") {
        this.uiState.dispatch({ type: "setQuery", query: overlay.query.slice(0, -1) });
      } else if (isPrintableKey(key)) {
        this.uiState.dispatch({ type: "setQuery", query: `${overlay.query}${key}` });
      }
      return true;
    }

    if (overlay && (key === "\x1b" || key === "q")) {
      this.uiState.dispatch({ type: "dismissOverlay", queueIdentities: queueIdentities(this.appState()) });
      return true;
    }
    if (overlay) return true;

    if (this.uiState.snapshot.activePrompt) {
      const query = this.uiState.snapshot.promptInput;
      if (key === "\r") {
        await this.dispatchBinding(key);
        this.uiState.dispatch({ type: "updateView", patch: { activePrompt: null, promptInput: "" } });
      } else if (key === "\x1b") this.uiState.dispatch({ type: "updateView", patch: { activePrompt: null, promptInput: "" } });
      else if (key === "\x7f" || key === "\b") this.uiState.dispatch({ type: "setQuery", query: query.slice(0, -1) });
      else if (isPrintableKey(key)) this.uiState.dispatch({ type: "setQuery", query: `${query}${key}` });
      return true;
    }

    const identities = queueIdentities(this.appState());
    if (key === "g") {
      const completing = Boolean(this.uiState.snapshot.pendingVimChord
        && this.now() <= this.uiState.snapshot.pendingVimChord.expiresAtMs);
      this.uiState.dispatch({ type: "pressVimG", atMs: this.now(), identities });
      this.clearPendingChordTimer();
      if (!completing) {
        this.pendingChordTimer = this.timers.setTimeout(() => {
          this.pendingChordTimer = null;
          this.uiState.dispatch({ type: "expireVimChord", atMs: this.now() });
        }, 751);
      }
      return true;
    }
    if (this.uiState.snapshot.pendingVimChord) {
      this.clearPendingChordTimer();
      this.uiState.dispatch({ type: "cancelVimChord" });
    }

    const context = { appState: this.appState(), uiState: this.uiState.snapshot };
    const action = actionForBinding(this.registry, key, context);
    if (!action) return false;
    if (!action.enabled || !action.intent) return true;
    await this.dispatchApp(action.intent);
    return true;
  }

  cancelPendingSequence(): void {
    this.clearPendingChordTimer();
    if (this.uiState.snapshot.pendingVimChord) this.uiState.dispatch({ type: "cancelVimChord" });
  }

  private async dispatchBinding(key: string): Promise<void> {
    const action = actionForBinding(this.registry, key, {
      appState: this.appState(),
      uiState: this.uiState.snapshot,
    });
    if (action?.enabled && action.intent) await this.dispatchApp(action.intent);
  }

  private clearPendingChordTimer(): void {
    if (this.pendingChordTimer === null) return;
    this.timers.clearTimeout(this.pendingChordTimer);
    this.pendingChordTimer = null;
  }
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
  return provider.listVisibleTracks()[context.uiState.selectedContentIndexByTarget[providerId] ?? 0] ?? null;
}

function queueIdentities(appState: Readonly<AppState>) {
  return appState.queue.entries.map((entry) => entry.track.identity);
}

function isTextEntryFocus(focus: UiState["overlays"][number]["focus"]): boolean {
  return focus === "search" || focus === "filter" || focus === "input";
}

function isPrintableKey(key: string): boolean {
  return key.length === 1 && key >= " " && key !== "\x7f";
}
