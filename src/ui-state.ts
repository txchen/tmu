import {
  clampIndex,
  sameIdentity,
  type ResponsiveTier,
  type TrackIdentity,
  type UiState,
} from "./domain";

export type InitialUiStateOptions = {
  columns?: number;
  rows?: number;
};

export type UiStateAction =
  | { type: "syncQueue"; identities: readonly TrackIdentity[]; preferredIdentity?: TrackIdentity | null }
  | { type: "resize"; columns: number; rows: number; queueIdentities?: readonly TrackIdentity[] }
  | { type: "switchTab"; tab: UiState["activeTab"] }
  | { type: "setLibraryQuery"; query: string }
  | { type: "setDownloaderInput"; value: string }
  | { type: "selectQueue"; index: number; identities: readonly TrackIdentity[] }
  | { type: "openOverlay"; kind: "shortcut-help" | "command-palette" }
  | { type: "dismissOverlay" }
  | { type: "requestConfirmation"; kind: import("./domain").ConfirmationKind }
  | { type: "cancelConfirmation" };

export function createInitialUiState(options: InitialUiStateOptions = {}): UiState {
  const columns = options.columns ?? 100;
  const rows = options.rows ?? 30;
  return {
    activeTab: "playback",
    selectedQueueIndex: 0,
    queueScroll: 0,
    overlays: [],
    selectedQueueIdentity: null,
    library: { query: "", selectedIndex: 0, scroll: 0 },
    downloader: { urlInput: "", selectedBatchIndex: 0, scroll: 0 },
    terminal: { columns, rows, tier: responsiveTier(columns, rows) },
    pendingConfirmation: null,
    pendingVimChord: null,
  };
}

export function reduceUiState(state: UiState, action: UiStateAction): UiState {
  switch (action.type) {
    case "syncQueue": {
      const preferred = action.preferredIdentity;
      const currentIndex = preferred
        ? action.identities.findIndex((identity) => sameIdentity(identity, preferred))
        : action.identities.findIndex((identity) => sameIdentity(identity, state.selectedQueueIdentity));
      const selectedQueueIndex = currentIndex >= 0
        ? currentIndex
        : clampIndex(state.selectedQueueIndex, action.identities.length);
      return {
        ...state,
        selectedQueueIndex,
        selectedQueueIdentity: action.identities[selectedQueueIndex] ?? null,
      };
    }
    case "resize":
      return {
        ...state,
        terminal: {
          columns: action.columns,
          rows: action.rows,
          tier: responsiveTier(action.columns, action.rows),
        },
      };
    case "switchTab":
      return { ...state, activeTab: action.tab };
    case "setLibraryQuery":
      return { ...state, library: { ...state.library, query: action.query, selectedIndex: 0, scroll: 0 } };
    case "setDownloaderInput":
      return { ...state, downloader: { ...state.downloader, urlInput: action.value } };
    case "selectQueue": {
      const index = clampIndex(action.index, action.identities.length);
      return {
        ...state,
        selectedQueueIndex: index,
        selectedQueueIdentity: action.identities[index] ?? null,
      };
    }
    case "openOverlay":
      return { ...state, overlays: [...state.overlays, { kind: action.kind, focus: "search", query: "", scroll: 0 }] };
    case "dismissOverlay":
      return { ...state, overlays: state.overlays.slice(0, -1) };
    case "requestConfirmation":
      return { ...state, pendingConfirmation: { kind: action.kind, choice: "cancel" } };
    case "cancelConfirmation":
      return { ...state, pendingConfirmation: null };
  }
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

export function responsiveTier(columns: number, rows: number): ResponsiveTier {
  if (columns < 60 || rows < 16) return "terminal-too-small";
  if (columns < 90) return "narrow";
  if (columns < 120) return "medium";
  return "wide";
}

export function queueHomeVisibleRows(
  _tier: ResponsiveTier,
  terminalRows: number,
  hasExceptionalGuidance = false,
): number {
  return Math.max(1, terminalRows - (hasExceptionalGuidance ? 7 : 5));
}

export function selectedUnavailableQueueEntry(
  entries: readonly import("./domain").QueueEntry[],
  identity: TrackIdentity | null,
) {
  const entry = entries.find((candidate) => sameIdentity(candidate.track.identity, identity));
  return entry?.availability.status === "unavailable" ? entry : undefined;
}
