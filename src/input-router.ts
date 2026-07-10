import {
  actionForBinding,
  type ActionIntent,
  type ActionRegistry,
  type UiActionIntent,
} from "./action-registry";
import {
  NAVIGATION_TARGETS,
  type AppIntent,
  type AppState,
  type LegacyAppIntent,
  type UiState,
} from "./domain";
import {
  queueHomeVisibleRows,
  selectedUnavailableQueueEntry,
  type UiStateAction,
} from "./ui-state";
import { overlayContentRows, providerNavigationRows } from "./provider-navigation";
import { globalSearchRows } from "./global-search";

export type RootInputRouterOptions = {
  registry: ActionRegistry;
  appState: () => Readonly<AppState>;
  uiState: {
    readonly snapshot: Readonly<UiState>;
    dispatch(action: UiStateAction): Readonly<UiState>;
  };
  dispatchApp: (intent: AppIntent) => Promise<void> | void;
  dispatchUiIntent?: (intent: LegacyAppIntent) => Promise<void> | void;
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
  private readonly dispatchUiIntent?: (intent: LegacyAppIntent) => Promise<void> | void;
  private readonly now: () => number;
  private readonly timers: NonNullable<RootInputRouterOptions["timers"]>;
  private pendingChordTimer: unknown | null = null;

  constructor(options: RootInputRouterOptions) {
    this.registry = options.registry;
    this.appState = options.appState;
    this.uiState = options.uiState;
    this.dispatchApp = options.dispatchApp;
    this.dispatchUiIntent = options.dispatchUiIntent;
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

    if (this.uiState.snapshot.terminal.tier === "terminal-too-small") return true;

    if (this.uiState.snapshot.pendingConfirmation) {
      await this.routeConfirmation(key);
      return true;
    }

    const overlay = this.uiState.snapshot.overlays.at(-1);
    if (overlay?.kind === "music-picker" && overlay.focus === "filter") {
      if (key === "\x1b" || key === "\r" || key === "\t") {
        this.uiState.dispatch({ type: "setOverlayFocus", focus: "search" });
      } else if (key === "p") {
        const providerIds = ["all", ...Object.values(this.appState().providers)
          .filter((provider) => provider.search && provider.getNavigationRoot().visible)
          .map((provider) => provider.id)];
        const current = providerIds.indexOf(overlay.providerFilter ?? "all");
        this.uiState.dispatch({ type: "setSearchProviderFilter", providerId: providerIds[(current + 1) % providerIds.length] ?? "all" });
      } else if (key === "t") {
        const types = ["all", "track", "artist", "album", "playlist"] as const;
        const current = types.indexOf(overlay.resultTypeFilter ?? "all");
        this.uiState.dispatch({ type: "setSearchResultTypeFilter", resultType: types[(current + 1) % types.length] ?? "all" });
      }
      return true;
    }
    if (overlay && isTextEntryFocus(overlay.focus)) {
      if (key === "\x1b") {
        if (overlay.kind === "music-picker" && overlay.focus === "search") {
          this.uiState.dispatch({ type: "setOverlayFocus", focus: "results" });
        } else {
          this.uiState.dispatch({ type: "dismissOverlay", queueIdentities: queueIdentities(this.appState()) });
        }
      } else if (key === "\r" && overlay.kind === "music-picker") {
        if (overlay.query.trim()) {
          const submission = this.dispatchApp({
            type: "globalSearch", operation: "submit", query: overlay.query,
            providerFilter: overlay.providerFilter ?? "all",
            resultTypeFilter: overlay.resultTypeFilter ?? "all",
          });
          this.uiState.dispatch({ type: "prepareSearchResults" });
          await submission;
        } else {
          this.uiState.dispatch({ type: "setOverlayFocus", focus: "results" });
        }
      } else if (key === "\x7f" || key === "\b") {
        const query = overlay.query.slice(0, -1);
        this.uiState.dispatch({ type: "setQuery", query });
        if (!query && this.appState().globalSearch.query) await this.clearGlobalSearch();
      } else if (key === "\x17") {
        const query = deletePreviousWord(overlay.query);
        this.uiState.dispatch({ type: "setQuery", query });
        if (!query && this.appState().globalSearch.query) await this.clearGlobalSearch();
      } else if (key === "\x15") {
        this.uiState.dispatch({ type: "setQuery", query: "" });
        if (this.appState().globalSearch.query) await this.clearGlobalSearch();
      } else if (key === "\t" && overlay.kind === "music-picker") {
        this.uiState.dispatch({ type: "setOverlayFocus", focus: "filter" });
      } else if (isPrintableKey(key)) {
        this.uiState.dispatch({ type: "setQuery", query: `${overlay.query}${key}` });
      }
      return true;
    }

    if (overlay?.kind === "music-picker" && overlay.focus === "results") {
      if (await this.routeProviderNavigation(key, overlay)) return true;
    }

    if (overlay && (key === "\x1b" || key === "q")) {
      this.uiState.dispatch({ type: "dismissOverlay", queueIdentities: queueIdentities(this.appState()) });
      return true;
    }
    if (overlay?.focus === "results" && (key === "\r" || key === "\x1b[13;2u")) {
      await this.dispatchBinding(key);
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
      if (key === "\x1b") return true;
    }

    const visibleRows = visibleQueueRows(this.uiState.snapshot, this.appState());
    const queueFocused = this.uiState.snapshot.focusedPane === "queue"
      && this.uiState.snapshot.activeTargetId === "queue";
    const movement = queueFocused ? listMovementForKey(key, visibleRows) : null;
    if (movement) {
      if (movement.kind === "boundary") {
        this.uiState.dispatch({
          type: "selectQueueBoundary",
          boundary: movement.boundary,
          identities,
          visibleRows,
        });
      } else {
        this.uiState.dispatch({
          type: "moveQueueSelection",
          delta: movement.delta,
          identities,
          visibleRows,
        });
      }
      return true;
    }

    const action = actionForBinding(this.registry, key, {
      appState: this.appState(),
      uiState: this.uiState.snapshot,
      selectedProviderId: selectedOverlayProviderId(this.appState(), this.uiState.snapshot),
    });
    if (!action) {
      const uiIntent = uiIntentForKey(key);
      if (uiIntent && this.dispatchUiIntent) {
        await this.dispatchUiIntent(uiIntent);
        return true;
      }
      return this.registry.some((definition) => definition.bindings.some((binding) => binding.key === key));
    }
    if (!action.enabled || !action.intent) return true;
    await this.dispatchIntent(action.intent);
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
      selectedProviderId: selectedOverlayProviderId(this.appState(), this.uiState.snapshot),
    });
    if (action?.enabled && action.intent) {
      await this.dispatchIntent(action.intent);
      this.syncQueueSelection();
    }
  }

  private async routeProviderNavigation(
    key: string,
    overlay: UiState["overlays"][number],
  ): Promise<boolean> {
    const searchRows = this.appState().globalSearch.query ? globalSearchRows(this.appState().globalSearch) : null;
    if (searchRows) return this.routeGlobalSearchResults(key, overlay, searchRows);
    if (key === "r" || key === "f") {
      this.cancelOverlayChord();
      await this.dispatchBinding(key);
      return true;
    }
    if (key === "/") {
      this.cancelOverlayChord();
      this.uiState.dispatch({ type: "setOverlayFocus", focus: "search" });
      return true;
    }
    const rows = providerNavigationRows(this.appState(), overlay.providerLocation ?? { providerId: null, path: [] });
    const terminal = this.uiState.snapshot.terminal;
    const visibleRows = overlayContentRows(overlay.kind, terminal.tier, terminal.columns, terminal.rows);
    const movement = listMovementForKey(key, visibleRows);
    if (movement) {
      this.cancelOverlayChord();
      if (movement.kind === "boundary") {
        this.uiState.dispatch({
          type: "selectOverlayBoundary", boundary: movement.boundary, rowCount: rows.length, visibleRows,
        });
      } else {
        this.uiState.dispatch({
          type: "moveOverlaySelection", delta: movement.delta, rowCount: rows.length, visibleRows,
        });
      }
      return true;
    }
    if (key === "g") {
      const completing = Boolean(this.uiState.snapshot.pendingVimChord
        && this.now() <= this.uiState.snapshot.pendingVimChord.expiresAtMs);
      if (completing) {
        this.clearPendingChordTimer();
        this.uiState.dispatch({ type: "selectOverlayBoundary", boundary: "first", rowCount: rows.length, visibleRows });
        this.uiState.dispatch({ type: "cancelVimChord" });
      } else {
        this.uiState.dispatch({ type: "pressVimG", atMs: this.now(), identities: [] });
        this.clearPendingChordTimer();
        this.pendingChordTimer = this.timers.setTimeout(() => {
          this.pendingChordTimer = null;
          this.uiState.dispatch({ type: "expireVimChord", atMs: this.now() });
        }, 751);
      }
      return true;
    }
    this.cancelOverlayChord();
    if (key === "h" || key === "\x1b[D" || key === "\x7f" || key === "\b") {
      const location = overlay.providerLocation ?? { providerId: null, path: [] };
      this.uiState.dispatch({
        type: "setProviderLocation",
        location: location.path.length > 0
          ? { providerId: location.providerId, path: location.path.slice(0, -1) }
          : { providerId: null, path: [] },
      });
      return true;
    }
    if (key === "l" || key === "\x1b[C" || key === "\r") {
      const selected = rows[overlay.selectedResultIndex ?? 0];
      if (!selected) {
        if (key === "\r") await this.dispatchBinding(key);
        return true;
      }
      const location = overlay.providerLocation ?? { providerId: null, path: [] };
      if (location.providerId === null) {
        this.uiState.dispatch({ type: "setProviderLocation", location: { providerId: selected.providerId as UiState["providerLocation"]["providerId"], path: [] } });
        return true;
      }
      if (selected.kind === "local-directory") {
        this.uiState.dispatch({
          type: "setProviderLocation",
          location: { providerId: location.providerId, path: [...location.path, selected.id] },
        });
        return true;
      }
      if (key === "\r") await this.dispatchBinding(key);
      return true;
    }
    return false;
  }

  private async routeGlobalSearchResults(
    key: string,
    overlay: UiState["overlays"][number],
    rows: ReturnType<typeof globalSearchRows>,
  ): Promise<boolean> {
    const terminal = this.uiState.snapshot.terminal;
    const visibleRows = overlayContentRows(overlay.kind, terminal.tier, terminal.columns, terminal.rows);
    const movement = listMovementForKey(key, visibleRows);
    if (movement) {
      this.uiState.dispatch(movement.kind === "boundary"
        ? { type: "selectOverlayBoundary", boundary: movement.boundary, rowCount: rows.length, visibleRows }
        : { type: "moveOverlaySelection", delta: movement.delta, rowCount: rows.length, visibleRows });
      return true;
    }
    if (key === "r") {
      const row = rows[overlay.selectedResultIndex ?? 0];
      const providerId = row?.kind === "provider-heading" || row?.kind === "provider-status" ? row.providerId
        : row?.kind === "result" ? row.result.providerId : undefined;
      if (providerId) await this.dispatchApp({ type: "globalSearch", operation: "retry", providerId });
      return true;
    }
    if (key === "/") {
      this.uiState.dispatch({ type: "setOverlayFocus", focus: "search" });
      return true;
    }
    return false;
  }

  private async clearGlobalSearch(): Promise<void> {
    await this.dispatchApp({ type: "globalSearch", operation: "clear" });
    this.uiState.dispatch({ type: "restoreProviderNavigation" });
  }

  private async dispatchIntent(intent: ActionIntent): Promise<void> {
    if (intent.type === "openOverlay") {
      this.uiState.dispatch({ type: "openOverlay", overlay: overlayForIntent(intent, this.uiState.snapshot) });
      return;
    }
    if (intent.type === "requestConfirmation") {
      this.uiState.dispatch({ type: "requestConfirmation", kind: intent.kind });
      return;
    }
    await this.dispatchApp(intent);
  }

  private cancelOverlayChord(): void {
    if (!this.uiState.snapshot.pendingVimChord) return;
    this.clearPendingChordTimer();
    this.uiState.dispatch({ type: "cancelVimChord" });
  }

  private async routeConfirmation(key: string): Promise<void> {
    const confirmation = this.uiState.snapshot.pendingConfirmation;
    if (!confirmation) return;

    if (key === "n" || key === "\x1b" || key === "q") {
      this.uiState.dispatch({ type: "cancelConfirmation" });
      return;
    }
    if (key === "h" || key === "\x1b[D") {
      this.uiState.dispatch({ type: "chooseConfirmation", choice: "cancel" });
      return;
    }
    if (key === "l" || key === "\x1b[C") {
      this.uiState.dispatch({ type: "chooseConfirmation", choice: "confirm" });
      return;
    }
    if (key === "\t") {
      this.uiState.dispatch({
        type: "chooseConfirmation",
        choice: confirmation.choice === "cancel" ? "confirm" : "cancel",
      });
      return;
    }
    if (key === "y" || (key === "\r" && confirmation.choice === "confirm")) {
      await this.dispatchApp({ type: "clearQueue" });
      this.uiState.dispatch({ type: "cancelConfirmation" });
      this.syncQueueSelection();
      return;
    }
    if (key === "\r") this.uiState.dispatch({ type: "cancelConfirmation" });
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

function uiIntentForKey(key: string): LegacyAppIntent | null {
  if (key === "\t") return { type: "cycleFocus" };
  if (key === "o") return { type: "openLocalPathPrompt" };
  if (key === "/") return { type: "openNavidromeSearchPrompt" };
  if (key === "\r") return { type: "activateSelectedContent" };
  if (key === "\x1b[A" || key === "\x1b[D") return { type: "moveSelection", delta: -1 };
  if (key === "\x1b[B" || key === "\x1b[C") return { type: "moveSelection", delta: 1 };
  if (/^[1-5]$/.test(key)) {
    const target = NAVIGATION_TARGETS[Number(key) - 1];
    if (target) return { type: "selectNavigationTarget", targetId: target.id };
  }
  return null;
}

function queueIdentities(appState: Readonly<AppState>) {
  return appState.queue.entries.map((entry) => entry.track.identity);
}

function selectedOverlayProviderId(appState: Readonly<AppState>, uiState: Readonly<UiState>): string | null {
  const overlay = uiState.overlays.at(-1);
  if (overlay?.kind !== "music-picker" || overlay.focus !== "results") return null;
  if (overlay.providerLocation?.providerId) return overlay.providerLocation.providerId;
  return providerNavigationRows(appState, { providerId: null, path: [] })[overlay.selectedResultIndex ?? 0]?.providerId ?? null;
}

function isTextEntryFocus(focus: UiState["overlays"][number]["focus"]): boolean {
  return focus === "search" || focus === "filter" || focus === "input";
}

function isPrintableKey(key: string): boolean {
  return key.length > 0 && [...key].every((character) => character >= " " && character !== "\x7f");
}

function overlayForIntent(intent: Extract<UiActionIntent, { type: "openOverlay" }>, uiState: Readonly<UiState>) {
  const memory = uiState.providerNavigationMemory;
  return {
    kind: intent.kind,
    focus: intent.focus,
    query: "",
    selectedIdentity: null,
    scroll: intent.kind === "music-picker" ? memory.scroll : 0,
    ...(intent.kind === "music-picker" ? {
      providerLocation: memory.location,
      selectedResultIndex: memory.selectedIndex,
      providerFilter: "all" as const,
      resultTypeFilter: "all" as const,
    } : {}),
  } as const;
}

function deletePreviousWord(value: string): string {
  return value.replace(/\s*\S+\s*$/, "");
}

function visibleQueueRows(uiState: Readonly<UiState>, appState: Readonly<AppState>): number {
  const selected = selectedUnavailableQueueEntry(appState.queue.entries, uiState.selectedQueueIdentity);
  return queueHomeVisibleRows(
    uiState.terminal.tier,
    uiState.terminal.rows,
    Boolean(selected),
  );
}

function listMovementForKey(key: string, visibleRows: number):
  | { kind: "relative"; delta: number }
  | { kind: "boundary"; boundary: "first" | "last" }
  | null {
  if (key === "j" || key === "\x1b[B") return { kind: "relative", delta: 1 };
  if (key === "k" || key === "\x1b[A") return { kind: "relative", delta: -1 };
  if (key === "G" || key === "\x1b[F") return { kind: "boundary", boundary: "last" };
  if (key === "\x1b[H") return { kind: "boundary", boundary: "first" };
  if (key === "\x04") return { kind: "relative", delta: Math.max(1, Math.floor(visibleRows / 2)) };
  if (key === "\x15") return { kind: "relative", delta: -Math.max(1, Math.floor(visibleRows / 2)) };
  if (key === "\x1b[6~") return { kind: "relative", delta: visibleRows };
  if (key === "\x1b[5~") return { kind: "relative", delta: -visibleRows };
  return null;
}
