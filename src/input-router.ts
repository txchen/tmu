import {
  actionForBinding,
  searchDiscoveryActions,
  type ActionIntent,
  type ActionRegistry,
  type UiRouteOperation,
  type UiActionIntent,
} from "./action-registry";
import {
  type AppIntent,
  type AppState,
  type UiState,
  type GlobalSearchProviderId,
  isProviderId,
} from "./domain";
import {
  queueHomeVisibleRows,
  selectedUnavailableQueueEntry,
  type UiStateAction,
} from "./ui-state";
import { overlayContentRows, providerNavigationRows } from "./provider-navigation";
import {
  globalSearchResultAt,
  globalSearchRows,
  globalSearchRetryProviderId,
  isNavigableGlobalSearchResult,
} from "./global-search";

export type RootInputRouterOptions = {
  registry: ActionRegistry;
  appState: () => Readonly<AppState>;
  uiState: {
    readonly snapshot: Readonly<UiState>;
    dispatch(action: UiStateAction): Readonly<UiState>;
  };
  dispatchApp: (intent: AppIntent) => Promise<void> | void;
  requestQuit?: () => void;
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
  private readonly requestQuit?: () => void;
  private readonly now: () => number;
  private readonly timers: NonNullable<RootInputRouterOptions["timers"]>;
  private pendingChordTimer: unknown | null = null;

  constructor(options: RootInputRouterOptions) {
    this.registry = options.registry;
    this.appState = options.appState;
    this.uiState = options.uiState;
    this.dispatchApp = options.dispatchApp;
    this.requestQuit = options.requestQuit;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    };
  }

  async route(key: string, requestedUiOperation?: UiRouteOperation): Promise<boolean> {
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
    const resolvedBinding = requestedUiOperation ? null : actionForBinding(this.registry, key, {
      appState: this.appState(), uiState: this.uiState.snapshot,
      selectedProviderId: selectedOverlayProviderId(this.appState(), this.uiState.snapshot),
    });
    const uiOperation = requestedUiOperation
      ?? (resolvedBinding?.intent?.type === "routeUi" ? resolvedBinding.intent.operation : null);
    const chordEligible = !overlay || !isTextEntryFocus(overlay.focus);
    if (this.uiState.snapshot.pendingVimChord && !(chordEligible && uiOperation === "first" && key === "g")) {
      this.cancelOverlayChord();
      if (key === "\x1b") return true;
    }
    if (overlay?.kind === "music-picker" && overlay.focus === "filter") {
      if (key === "\x1b" || key === "\r" || key === "\t") {
        this.uiState.dispatch({ type: "setOverlayFocus", focus: "search" });
      } else if (uiOperation === "cycle-provider-filter") {
        const providerIds: Array<"all" | GlobalSearchProviderId> = ["all", ...Object.values(this.appState().providers)
          .flatMap((provider) => isProviderId(provider.id) && provider.search && provider.getNavigationRoot().visible
            ? [provider.id]
            : [])];
        const current = providerIds.indexOf(overlay.providerFilter ?? "all");
        this.uiState.dispatch({ type: "setSearchProviderFilter", providerId: providerIds[(current + 1) % providerIds.length] ?? "all" });
      } else if (uiOperation === "cycle-result-type-filter") {
        const types = ["all", "track", "artist", "album", "playlist"] as const;
        const current = types.indexOf(overlay.resultTypeFilter ?? "all");
        this.uiState.dispatch({ type: "setSearchResultTypeFilter", resultType: types[(current + 1) % types.length] ?? "all" });
      }
      return true;
    }
    if (overlay && isTextEntryFocus(overlay.focus)) {
      if ((overlay.kind === "shortcut-help" || overlay.kind === "command-palette")
        && isDiscoveryTextNavigationKey(key) && movementForUiOperation(uiOperation, 1)) {
        this.moveDiscoverySelection(uiOperation, overlay);
        return true;
      }
      if (key === "\x1b") {
        if (overlay.kind === "music-picker" && overlay.focus === "search") {
          this.uiState.dispatch({ type: "setOverlayFocus", focus: "results" });
        } else if (overlay.kind === "shortcut-help") {
          this.uiState.dispatch({ type: "setOverlayFocus", focus: "results" });
        } else {
          this.uiState.dispatch({ type: "dismissOverlay", queueIdentities: queueIdentities(this.appState()) });
        }
      } else if (key === "\r" && overlay.kind === "command-palette") {
        await this.invokeDiscoverySelection(overlay);
      } else if (key === "\t" && overlay.kind === "command-palette") {
        this.uiState.dispatch({ type: "setOverlayFocus", focus: "results" });
      } else if (key === "\r" && overlay.kind === "youtube-url") {
        await this.dispatchBinding(key);
        if (this.appState().downloads.active) this.uiState.dispatch({ type: "setOverlayFocus", focus: "results" });
      } else if (key === "\r" && overlay.kind === "shortcut-help") {
        this.uiState.dispatch({ type: "setOverlayFocus", focus: "results" });
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
      } else if (key === "\t" && overlay.kind === "music-picker") {
        this.uiState.dispatch({ type: "setOverlayFocus", focus: "filter" });
      } else {
        const query = editText(overlay.query, key);
        if (query !== null) {
          this.uiState.dispatch({ type: "setQuery", query });
          if (!query && this.appState().globalSearch.query) await this.clearGlobalSearch();
        }
      }
      return true;
    }

    if (overlay?.kind === "shortcut-help" || overlay?.kind === "command-palette") {
      const actions = this.discoveryRows(overlay.query);
      const visibleRows = overlayContentRows(overlay.kind,
        this.uiState.snapshot.terminal.tier, this.uiState.snapshot.terminal.columns,
        this.uiState.snapshot.terminal.rows);
      if (this.routeOverlayRowMovement(uiOperation, actions.length, visibleRows, key)) return true;
      if (overlay.kind === "shortcut-help" && uiOperation === "help-filter") {
        this.uiState.dispatch({ type: "setOverlayFocus", focus: "search" });
        return true;
      }
      if (overlay.kind === "command-palette" && key === "\r") {
        await this.invokeDiscoverySelection(overlay);
        return true;
      }
      if (overlay.kind === "command-palette" && (key === "\t" || key === "/")) {
        this.uiState.dispatch({ type: "setOverlayFocus", focus: "search" });
        return true;
      }
    }

    if (overlay && resolvedBinding?.intent?.type === "openOverlay"
      && (resolvedBinding.intent.kind === "shortcut-help" || resolvedBinding.intent.kind === "command-palette")) {
      await this.dispatchIntent(resolvedBinding.intent);
      return true;
    }

    if (overlay?.kind === "music-picker" && overlay.focus === "results") {
      if (await this.routeProviderNavigation(key, overlay, uiOperation)) return true;
    }

    if (overlay && uiOperation === "dismiss") {
      if (overlay.kind === "music-picker" && this.appState().globalSearch.query) {
        await this.dispatchApp({ type: "globalSearch", operation: "clear" });
      }
      this.uiState.dispatch({ type: "dismissOverlay", queueIdentities: queueIdentities(this.appState()) });
      return true;
    }
    if (overlay?.focus === "results"
      && (resolvedBinding?.intent?.type === "playNext" || resolvedBinding?.intent?.type === "playNow")) {
      await this.dispatchIntent(resolvedBinding.intent);
      return true;
    }
    if (overlay && resolvedBinding?.intent?.type === "requestConfirmation") {
      await this.dispatchIntent(resolvedBinding.intent);
      return true;
    }
    if (overlay) return true;

    const identities = queueIdentities(this.appState());
    const visibleRows = visibleQueueRows(this.uiState.snapshot, this.appState());
    if (this.routeVimFirstChord(uiOperation, key, () => {
      this.uiState.dispatch({ type: "selectQueueBoundary", boundary: "first", identities, visibleRows });
    })) return true;
    const movement = movementForUiOperation(uiOperation, visibleRows);
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

    const action = resolvedBinding;
    if (!action) {
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
    uiOperation: UiRouteOperation | null,
  ): Promise<boolean> {
    if (uiOperation === "search-filters") {
      this.cancelOverlayChord();
      this.uiState.dispatch({ type: "setOverlayFocus", focus: "filter" });
      return true;
    }
    const searchRows = this.appState().globalSearch.query ? globalSearchRows(this.appState().globalSearch) : null;
    if (searchRows) return this.routeGlobalSearchResults(key, overlay, searchRows, uiOperation);
    if (uiOperation === "retry") {
      this.cancelOverlayChord();
      const providerId = selectedOverlayProviderId(this.appState(), this.uiState.snapshot);
      if (providerId) await this.dispatchApp({ type: "providerOperation", providerId, operation: "retry" });
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
    if (this.routeOverlayRowMovement(uiOperation, rows.length, visibleRows, key)) return true;
    this.cancelOverlayChord();
    if (uiOperation === "back") {
      const location = overlay.providerLocation ?? { providerId: null, path: [] };
      this.uiState.dispatch({
        type: "setProviderLocation",
        location: location.path.length > 0
          ? { providerId: location.providerId, path: location.path.slice(0, -1) }
          : { providerId: null, path: [] },
      });
      return true;
    }
    if (uiOperation === "open" || key === "\r") {
      const selected = rows[overlay.selectedResultIndex ?? 0];
      if (!selected) {
        if (key === "\r") await this.dispatchBinding(key);
        return true;
      }
      const location = overlay.providerLocation ?? { providerId: null, path: [] };
      if (location.providerId === null) {
        this.uiState.dispatch({ type: "setProviderLocation", location: { providerId: selected.providerId, path: [] } });
        return true;
      }
      if (selected.kind === "local-directory") {
        this.uiState.dispatch({
          type: "setProviderLocation",
          location: { providerId: "local", path: [...location.path, { kind: "local-directory", path: selected.id }] },
        });
        return true;
      }
      if (location.providerId === "navidrome"
        && (uiOperation === "open" || selected.kind === "navigation" || selected.kind === "artist")) {
        await this.dispatchApp({
          type: "providerOperation",
          providerId: "navidrome",
          operation: "open-entry",
          location,
          index: overlay.selectedResultIndex ?? 0,
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
    uiOperation: UiRouteOperation | null,
  ): Promise<boolean> {
    const terminal = this.uiState.snapshot.terminal;
    const visibleRows = overlayContentRows(overlay.kind, terminal.tier, terminal.columns, terminal.rows);
    if (this.routeOverlayRowMovement(uiOperation, rows.length, visibleRows, key)) return true;
    if (uiOperation === "retry") {
      const row = rows[overlay.selectedResultIndex ?? 0];
      const providerId = globalSearchRetryProviderId(row);
      if (providerId) await this.dispatchApp({ type: "globalSearch", operation: "retry", providerId });
      return true;
    }
    if (key === "\r" || uiOperation === "open") {
      const result = globalSearchResultAt(this.appState().globalSearch, overlay.selectedResultIndex ?? 0);
      const opensNavigation = isNavigableGlobalSearchResult(result)
        && (result.type === "artist" || key !== "\r");
      if (opensNavigation) {
        await this.dispatchApp({ type: "globalSearch", operation: "open", result });
        return true;
      }
    }
    if (key === "/") {
      this.uiState.dispatch({ type: "setOverlayFocus", focus: "search" });
      return true;
    }
    return false;
  }

  private routeOverlayRowMovement(
    uiOperation: UiRouteOperation | null,
    rowCount: number,
    visibleRows: number,
    key?: string,
  ): boolean {
    if (this.routeVimFirstChord(uiOperation, key, () => {
      this.uiState.dispatch({ type: "selectOverlayBoundary", boundary: "first", rowCount, visibleRows });
    })) return true;
    const movement = movementForUiOperation(uiOperation, visibleRows);
    if (!movement) return false;
    this.cancelOverlayChord();
    this.uiState.dispatch(movement.kind === "boundary"
      ? { type: "selectOverlayBoundary", boundary: movement.boundary, rowCount, visibleRows }
      : { type: "moveOverlaySelection", delta: movement.delta, rowCount, visibleRows });
    return true;
  }

  private routeVimFirstChord(
    uiOperation: UiRouteOperation | null,
    key: string | undefined,
    complete: () => void,
  ): boolean {
    if (uiOperation !== "first" || key !== "g") return false;
    const completing = Boolean(this.uiState.snapshot.pendingVimChord
      && this.now() <= this.uiState.snapshot.pendingVimChord.expiresAtMs);
    if (completing) {
      this.cancelOverlayChord();
      complete();
      return true;
    }
    this.uiState.dispatch({ type: "pressVimG", atMs: this.now(), identities: [] });
    this.clearPendingChordTimer();
    this.pendingChordTimer = this.timers.setTimeout(() => {
      this.pendingChordTimer = null;
      this.uiState.dispatch({ type: "expireVimChord", atMs: this.now() });
    }, 751);
    return true;
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
    if (intent.type === "routeUi") {
      await this.route("", intent.operation);
      return;
    }
    if (intent.type === "playerOperation" && intent.operation === "quit") {
      if (this.appState().downloads.active) {
        this.uiState.dispatch({ type: "requestConfirmation", kind: "quit-download" });
        return;
      }
      await this.quitApp();
      return;
    }
    await this.dispatchApp(intent);
  }

  private discoveryRows(query: string) {
    return searchDiscoveryActions(this.registry, {
      appState: this.appState(), uiState: this.uiState.snapshot,
      selectedProviderId: selectedOverlayProviderId(this.appState(), this.uiState.snapshot),
    }, query);
  }

  private moveDiscoverySelection(operation: UiRouteOperation | null, overlay: UiState["overlays"][number]): void {
    const actions = this.discoveryRows(overlay.query);
    const visibleRows = overlayContentRows(overlay.kind,
      this.uiState.snapshot.terminal.tier, this.uiState.snapshot.terminal.columns,
      this.uiState.snapshot.terminal.rows);
    this.routeOverlayRowMovement(operation, actions.length, visibleRows);
  }

  private async invokeDiscoverySelection(overlay: UiState["overlays"][number]): Promise<void> {
    const selected = this.discoveryRows(overlay.query)[overlay.selectedResultIndex ?? 0];
    if (!selected?.enabled || !selected.intent) return;
    this.uiState.dispatch({ type: "dismissOverlay", queueIdentities: queueIdentities(this.appState()) });
    await this.dispatchIntent(selected.intent);
    this.syncQueueSelection();
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
      if (confirmation.kind === "clear-queue") {
        await this.dispatchApp({ type: "clearQueue" });
      } else if (confirmation.kind === "cancel-download") {
        await this.dispatchApp({ type: "downloadOperation", operation: "cancel" });
      } else {
        await this.quitApp();
      }
      this.uiState.dispatch({ type: "cancelConfirmation" });
      this.syncQueueSelection();
      return;
    }
    if (key === "\r") this.uiState.dispatch({ type: "cancelConfirmation" });
  }

  private syncQueueSelection(): void {
    this.uiState.dispatch({ type: "syncQueue", identities: queueIdentities(this.appState()) });
  }

  private async quitApp(): Promise<void> {
    try {
      await this.dispatchApp({ type: "playerOperation", operation: "quit" });
    } finally {
      this.requestQuit?.();
    }
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

function isDiscoveryTextNavigationKey(key: string): boolean {
  return ["\x1b[A", "\x1b[B", "\x1b[H", "\x1b[F", "\x1b[5~", "\x1b[6~"].includes(key);
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

function editText(value: string, key: string): string | null {
  if (key === "\x7f" || key === "\b") return value.slice(0, -1);
  if (key === "\x17") return deletePreviousWord(value);
  if (key === "\x15") return "";
  return isPrintableKey(key) ? `${value}${key}` : null;
}

function visibleQueueRows(uiState: Readonly<UiState>, appState: Readonly<AppState>): number {
  const selected = selectedUnavailableQueueEntry(appState.queue.entries, uiState.selectedQueueIdentity);
  return queueHomeVisibleRows(
    uiState.terminal.tier,
    uiState.terminal.rows,
    Boolean(selected),
  );
}

function movementForUiOperation(operation: UiRouteOperation | null, visibleRows: number):
  | { kind: "relative"; delta: number }
  | { kind: "boundary"; boundary: "first" | "last" }
  | null {
  if (operation === "move-down") return { kind: "relative", delta: 1 };
  if (operation === "move-up") return { kind: "relative", delta: -1 };
  if (operation === "last") return { kind: "boundary", boundary: "last" };
  if (operation === "first") return { kind: "boundary", boundary: "first" };
  if (operation === "half-page-down") return { kind: "relative", delta: Math.max(1, Math.floor(visibleRows / 2)) };
  if (operation === "half-page-up") return { kind: "relative", delta: -Math.max(1, Math.floor(visibleRows / 2)) };
  if (operation === "page-down") return { kind: "relative", delta: visibleRows };
  if (operation === "page-up") return { kind: "relative", delta: -visibleRows };
  return null;
}
