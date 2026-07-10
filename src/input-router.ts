import { actionForBinding, type ActionRegistry } from "./action-registry";
import type { AppIntent, AppState, UiState } from "./domain";
import type { UiStateAction } from "./ui-state";

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

    const action = actionForBinding(this.registry, key, {
      appState: this.appState(),
      uiState: this.uiState.snapshot,
    });
    if (!action) {
      return this.registry.some((definition) => definition.bindings.some((binding) => binding.key === key));
    }
    if (!action.enabled || !action.intent) return true;
    await this.dispatchApp(action.intent);
    this.syncQueueSelection();
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
    if (action?.enabled && action.intent) {
      await this.dispatchApp(action.intent);
      this.syncQueueSelection();
    }
  }

  private syncQueueSelection(): void {
    this.uiState.dispatch({ type: "syncQueue", identities: queueIdentities(this.appState()) });
  }

  private clearPendingChordTimer(): void {
    if (this.pendingChordTimer === null) return;
    this.timers.clearTimeout(this.pendingChordTimer);
    this.pendingChordTimer = null;
  }
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
