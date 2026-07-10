import {
  NAVIGATION_TARGETS,
  sameIdentity,
  type NavigationTargetId,
  type FocusedPane,
  type ConfirmationKind,
  type ProviderLocation,
  type ResponsiveTier,
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
  }
  | { type: "openOverlay"; overlay: Omit<PickerOverlay, "returnTo"> }
  | { type: "dismissOverlay"; queueIdentities?: readonly TrackIdentity[] }
  | { type: "setFocus"; focusedPane: FocusedPane }
  | { type: "setQuery"; query: string }
  | { type: "setFilter"; filterText: string }
  | { type: "setProviderLocation"; location: ProviderLocation }
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
    return action.queueIdentities
      ? repairQueueSelection(resized, action.queueIdentities, undefined, action.visibleQueueRows)
      : resized;
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
    return updateTopOverlay(state, (overlay) => ({ ...overlay, query: action.query }))
      ?? { ...state, promptInput: action.query };
  }

  if (action.type === "setFilter") {
    return updateTopOverlay(state, (overlay) => ({ ...overlay, filterText: action.filterText }))
      ?? { ...state, filterText: action.filterText };
  }

  if (action.type === "setProviderLocation") {
    return updateTopOverlay(state, (overlay) => ({ ...overlay, providerLocation: cloneProviderLocation(action.location) }))
      ?? { ...state, providerLocation: cloneProviderLocation(action.location) };
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
