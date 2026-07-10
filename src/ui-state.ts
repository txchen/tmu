import {
  NAVIGATION_TARGETS,
  sameIdentity,
  type NavigationTargetId,
  type FocusedPane,
  type ConfirmationKind,
  type ProviderLocation,
  type ResponsiveTier,
  type QueueEntry,
  type TrackIdentity,
  type PickerOverlay,
  type UiState,
} from "./domain";

export type InitialUiStateOptions = {
  columns?: number;
  rows?: number;
};

export type UiStateAction =
  | { type: "updateView"; patch: Partial<UiState> }
  | {
    type: "resize";
    columns: number;
    rows: number;
    queueIdentities?: readonly TrackIdentity[];
    visibleQueueRows?: number;
    overlayRowCount?: number;
    visibleOverlayRows?: number;
  }
  | { type: "openOverlay"; overlay: Omit<PickerOverlay, "returnTo"> }
  | { type: "dismissOverlay"; queueIdentities?: readonly TrackIdentity[] }
  | { type: "setFocus"; focusedPane: FocusedPane }
  | { type: "setQuery"; query: string }
  | { type: "setOverlayMessage"; message?: string }
  | { type: "setFilter"; filterText: string }
  | { type: "setProviderLocation"; location: ProviderLocation }
  | { type: "setOverlayFocus"; focus: PickerOverlay["focus"] }
  | { type: "prepareSearchResults" }
  | { type: "restoreProviderNavigation" }
  | { type: "setSearchProviderFilter"; providerId: "all" | string }
  | { type: "setSearchResultTypeFilter"; resultType: "all" | import("./domain").ProviderSearchResultType }
  | { type: "moveOverlaySelection"; delta: number; rowCount: number; visibleRows: number }
  | { type: "selectOverlayBoundary"; boundary: "first" | "last"; rowCount: number; visibleRows: number }
  | { type: "setScroll"; pane: FocusedPane; offset: number }
  | { type: "requestConfirmation"; kind: ConfirmationKind }
  | { type: "chooseConfirmation"; choice: "cancel" | "confirm" }
  | { type: "cancelConfirmation" }
  | { type: "pressVimG"; atMs: number; identities: readonly TrackIdentity[] }
  | { type: "expireVimChord"; atMs: number }
  | { type: "cancelVimChord" }
  | {
    type: "moveQueueSelection";
    delta: number;
    identities: readonly TrackIdentity[];
    visibleRows: number;
  }
  | {
    type: "selectQueueBoundary";
    boundary: "first" | "last";
    identities: readonly TrackIdentity[];
    visibleRows: number;
  }
  | {
    type: "syncQueue";
    identities: readonly TrackIdentity[];
    preferredIdentity?: TrackIdentity | null;
    visibleRows?: number;
  };

export function responsiveTier(columns: number, rows: number): ResponsiveTier {
  if (columns < 60 || rows < 16) return "terminal-too-small";
  if (columns >= 120) return "wide";
  if (columns >= 80) return "medium";
  return "narrow";
}

export function queueHomeVisibleRows(tier: ResponsiveTier, rows: number, hasExceptionalLine = false): number {
  const reservedRows = tier === "narrow" ? 4 + Number(hasExceptionalLine) : 3;
  return Math.max(1, rows - reservedRows);
}

export function selectedUnavailableQueueEntry(
  entries: readonly QueueEntry[],
  selectedIdentity: TrackIdentity | null,
): QueueEntry | undefined {
  return entries.find((entry) => sameIdentity(entry.track.identity, selectedIdentity)
    && entry.availability.status === "unavailable");
}

export function createInitialUiState(options: InitialUiStateOptions = {}): UiState {
  const selectedContentIndexByTarget = Object.fromEntries(
    NAVIGATION_TARGETS.map((target) => [target.id, 0]),
  ) as Record<NavigationTargetId, number>;
  const columns = options.columns ?? 120;
  const rows = options.rows ?? 30;

  return {
    activeTargetId: "local",
    focusedPane: "targets",
    selectedTargetIndex: 0,
    selectedContentIndexByTarget,
    selectedQueueIndex: 0,
    activePrompt: null,
    promptInput: "",
    filterText: "",
    scrollByPane: { targets: 0, content: 0, queue: 0 },
    overlays: [],
    selectedQueueIdentity: null,
    providerLocation: { providerId: null, path: [] },
    providerNavigationMemory: {
      location: { providerId: null, path: [] },
      selectedIndex: 0,
      scroll: 0,
    },
    terminal: { columns, rows, tier: responsiveTier(columns, rows) },
    pendingConfirmation: null,
    pendingVimChord: null,
  };
}

export function reduceUiState(state: UiState, action: UiStateAction): UiState {
  if (action.type === "resize") {
    const resized = {
      ...state,
      terminal: {
        columns: action.columns,
        rows: action.rows,
        tier: responsiveTier(action.columns, action.rows),
      },
    };
    const repaired = action.queueIdentities
      ? repairQueueSelection(resized, action.queueIdentities, undefined, action.visibleQueueRows)
      : resized;
    if (action.overlayRowCount === undefined || action.visibleOverlayRows === undefined) return repaired;
    const overlay = repaired.overlays.at(-1);
    if (!overlay) return repaired;
    const scroll = keepIndexVisible(
      overlay.scroll,
      overlay.selectedResultIndex ?? 0,
      action.visibleOverlayRows,
      action.overlayRowCount,
    );
    return updateTopOverlay(repaired, (value) => ({ ...value, scroll })) ?? repaired;
  }

  if (state.terminal.tier === "terminal-too-small") return state;

  if (action.type === "updateView") return { ...state, ...action.patch };

  if (action.type === "openOverlay") {
    return {
      ...state,
      overlays: [
        ...state.overlays,
        {
          ...action.overlay,
          returnTo: {
            focusedPane: state.focusedPane,
            query: state.promptInput,
            filterText: state.filterText,
            selectedQueueIdentity: state.selectedQueueIdentity,
            selectedQueueIndex: state.selectedQueueIndex,
            providerLocation: cloneProviderLocation(state.providerLocation),
            scrollByPane: { ...state.scrollByPane },
          },
        },
      ],
    };
  }

  if (action.type === "dismissOverlay") {
    const dismissed = state.overlays.at(-1);
    if (!dismissed) return state;
    const overlays = state.overlays.slice(0, -1);
    if (overlays.length > 0 || !dismissed.returnTo) return { ...state, overlays };
    const restored = {
      ...state,
      overlays,
      focusedPane: dismissed.returnTo.focusedPane,
      promptInput: dismissed.returnTo.query,
      filterText: dismissed.returnTo.filterText,
      selectedQueueIdentity: dismissed.returnTo.selectedQueueIdentity,
      selectedQueueIndex: dismissed.returnTo.selectedQueueIndex,
      providerLocation: cloneProviderLocation(dismissed.returnTo.providerLocation),
      scrollByPane: { ...dismissed.returnTo.scrollByPane },
    };
    return action.queueIdentities
      ? repairQueueSelection(restored, action.queueIdentities, restored.selectedQueueIdentity)
      : restored;
  }

  if (action.type === "setFocus") return { ...state, focusedPane: action.focusedPane };

  if (action.type === "setQuery") {
    return updateTopOverlay(state, (overlay) => ({
      ...overlay,
      query: action.query,
      ...((overlay.kind === "shortcut-help" || overlay.kind === "command-palette")
        ? { selectedResultIndex: 0, scroll: 0 }
        : {}),
    }))
      ?? { ...state, promptInput: action.query };
  }

  if (action.type === "setOverlayMessage") {
    return updateTopOverlay(state, (overlay) => ({ ...overlay, message: action.message })) ?? state;
  }

  if (action.type === "setFilter") {
    return updateTopOverlay(state, (overlay) => ({ ...overlay, filterText: action.filterText }))
      ?? { ...state, filterText: action.filterText };
  }

  if (action.type === "setProviderLocation") {
    const updated = updateTopOverlay(state, (overlay) => ({
      ...overlay,
      providerLocation: cloneProviderLocation(action.location),
      selectedResultIndex: 0,
      scroll: 0,
    }));
    if (updated) return {
      ...updated,
      providerNavigationMemory: {
        location: cloneProviderLocation(action.location), selectedIndex: 0, scroll: 0,
      },
    };
    return updated ?? {
      ...state,
      providerLocation: cloneProviderLocation(action.location),
      providerNavigationMemory: {
        location: cloneProviderLocation(action.location), selectedIndex: 0, scroll: 0,
      },
    };
  }

  if (action.type === "setOverlayFocus") {
    return updateTopOverlay(state, (overlay) => ({ ...overlay, focus: action.focus })) ?? state;
  }

  if (action.type === "prepareSearchResults") {
    return updateTopOverlay(state, (overlay) => ({ ...overlay, focus: "results", selectedResultIndex: 0, scroll: 0 })) ?? state;
  }

  if (action.type === "restoreProviderNavigation") {
    const memory = state.providerNavigationMemory;
    return updateTopOverlay(state, (overlay) => ({
      ...overlay,
      query: "",
      providerLocation: cloneProviderLocation(memory.location),
      selectedResultIndex: memory.selectedIndex,
      scroll: memory.scroll,
    })) ?? state;
  }

  if (action.type === "setSearchProviderFilter") {
    return updateTopOverlay(state, (overlay) => ({ ...overlay, providerFilter: action.providerId })) ?? state;
  }

  if (action.type === "setSearchResultTypeFilter") {
    return updateTopOverlay(state, (overlay) => ({ ...overlay, resultTypeFilter: action.resultType })) ?? state;
  }

  if (action.type === "moveOverlaySelection" || action.type === "selectOverlayBoundary") {
    const overlay = state.overlays.at(-1);
    if (!overlay) return state;
    const current = overlay.selectedResultIndex ?? 0;
    const selectedResultIndex = action.type === "moveOverlaySelection"
      ? clampIndex(current + action.delta, action.rowCount)
      : action.boundary === "first" ? 0 : Math.max(0, action.rowCount - 1);
    const scroll = keepIndexVisible(overlay.scroll, selectedResultIndex, action.visibleRows, action.rowCount);
    const updated = updateTopOverlay(state, (value) => ({ ...value, selectedResultIndex, scroll })) ?? state;
    return overlay.kind === "music-picker" && !overlay.query.trim() ? {
      ...updated,
      providerNavigationMemory: {
        location: cloneProviderLocation(overlay.providerLocation ?? { providerId: null, path: [] }),
        selectedIndex: selectedResultIndex,
        scroll,
      },
    } : updated;
  }

  if (action.type === "setScroll") {
    return {
      ...state,
      scrollByPane: { ...state.scrollByPane, [action.pane]: Math.max(0, action.offset) },
    };
  }

  if (action.type === "requestConfirmation") {
    return { ...state, pendingConfirmation: { kind: action.kind, choice: "cancel" } };
  }

  if (action.type === "chooseConfirmation") {
    return state.pendingConfirmation
      ? { ...state, pendingConfirmation: { ...state.pendingConfirmation, choice: action.choice } }
      : state;
  }

  if (action.type === "cancelConfirmation") return { ...state, pendingConfirmation: null };

  if (action.type === "pressVimG") {
    if (state.pendingVimChord && action.atMs <= state.pendingVimChord.expiresAtMs) {
      const atFirst = repairQueueSelection(
        { ...state, selectedQueueIndex: 0, selectedQueueIdentity: action.identities[0] ?? null, pendingVimChord: null },
        action.identities,
        action.identities[0] ?? null,
      );
      return atFirst;
    }
    return { ...state, pendingVimChord: { key: "g", expiresAtMs: action.atMs + 750 } };
  }

  if (action.type === "expireVimChord") {
    return state.pendingVimChord && action.atMs > state.pendingVimChord.expiresAtMs
      ? { ...state, pendingVimChord: null }
      : state;
  }

  if (action.type === "cancelVimChord") return { ...state, pendingVimChord: null };

  if (action.type === "moveQueueSelection") {
    const selectedQueueIndex = Math.max(
      0,
      Math.min(action.identities.length - 1, state.selectedQueueIndex + action.delta),
    );
    return repairQueueSelection(
      { ...state, selectedQueueIndex },
      action.identities,
      action.identities[selectedQueueIndex] ?? null,
      action.visibleRows,
    );
  }

  if (action.type === "selectQueueBoundary") {
    const selectedQueueIndex = action.boundary === "first" ? 0 : Math.max(0, action.identities.length - 1);
    return repairQueueSelection(
      { ...state, selectedQueueIndex },
      action.identities,
      action.identities[selectedQueueIndex] ?? null,
      action.visibleRows,
    );
  }

  if (action.type === "syncQueue") {
    return repairQueueSelection(
      state,
      action.identities,
      action.preferredIdentity,
      action.visibleRows,
    );
  }

  return state;
}

export class UiStateStore {
  private state: UiState;

  constructor(initialState: UiState = createInitialUiState()) {
    this.state = initialState;
  }

  get snapshot(): Readonly<UiState> {
    return this.state;
  }

  dispatch(action: UiStateAction): Readonly<UiState> {
    this.state = reduceUiState(this.state, action);
    return this.state;
  }
}

function updateTopOverlay(
  state: UiState,
  update: (overlay: PickerOverlay) => PickerOverlay,
): UiState | null {
  if (state.overlays.length === 0) return null;
  const overlays = [...state.overlays];
  const top = overlays.at(-1);
  if (!top) return null;
  overlays[overlays.length - 1] = update(top);
  return { ...state, overlays };
}

function cloneProviderLocation(location: ProviderLocation): ProviderLocation {
  return { providerId: location.providerId, path: [...location.path] };
}

function keepIndexVisible(scroll: number, index: number, visibleRows: number, rowCount: number): number {
  const pageSize = Math.max(1, Math.floor(visibleRows));
  const maximumScroll = Math.max(0, rowCount - pageSize);
  return Math.min(maximumScroll, Math.max(Math.min(scroll, index), index - pageSize + 1));
}

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, value));
}

function repairQueueSelection(
  state: UiState,
  identities: readonly TrackIdentity[],
  preferredIdentity: TrackIdentity | null | undefined,
  visibleRows = Number.POSITIVE_INFINITY,
): UiState {
  if (identities.length === 0) {
    return {
      ...state,
      selectedQueueIdentity: null,
      selectedQueueIndex: 0,
      scrollByPane: { ...state.scrollByPane, queue: 0 },
    };
  }

  const requested = preferredIdentity === undefined
    ? state.selectedQueueIdentity
    : preferredIdentity;
  const identityIndex = requested
    ? identities.findIndex((identity) => sameIdentity(identity, requested))
    : -1;
  const selectedQueueIndex = identityIndex >= 0
    ? identityIndex
    : Math.min(state.selectedQueueIndex, identities.length - 1);
  const selectedQueueIdentity = identities[selectedQueueIndex] ?? null;
  const pageSize = Math.max(1, Math.floor(visibleRows));
  const maximumScroll = Math.max(0, identities.length - pageSize);
  const scroll = Math.min(
    maximumScroll,
    Math.max(
      Math.min(state.scrollByPane.queue, selectedQueueIndex),
      selectedQueueIndex - pageSize + 1,
    ),
  );

  return {
    ...state,
    selectedQueueIdentity,
    selectedQueueIndex,
    scrollByPane: { ...state.scrollByPane, queue: scroll },
  };
}
