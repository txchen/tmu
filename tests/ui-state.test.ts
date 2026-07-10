import { describe, expect, test } from "bun:test";
import { UiStateStore, createInitialUiState, reduceUiState } from "../src/ui-state";

const alpha = { providerId: "local", stableId: "alpha" };
const beta = { providerId: "navidrome", stableId: "beta" };
const gamma = { providerId: "local", stableId: "gamma" };

describe("UI State reducer", () => {
  test("resets discovery selection when its search query changes", () => {
    let state = createInitialUiState();
    state = reduceUiState(state, {
      type: "openOverlay",
      overlay: {
        kind: "command-palette", focus: "search", query: "", selectedIdentity: null,
        selectedResultIndex: 7, scroll: 5,
      },
    });

    state = reduceUiState(state, { type: "setQuery", query: "play" });

    expect(state.overlays.at(-1)).toMatchObject({ query: "play", selectedResultIndex: 0, scroll: 0 });
  });

  test("classifies responsive tiers and preserves context while the terminal is too small", () => {
    let state = createInitialUiState({ columns: 120, rows: 30 });

    expect(state.terminal.tier).toBe("wide");
    state = reduceUiState(state, { type: "resize", columns: 100, rows: 30 });
    expect(state.terminal.tier).toBe("medium");
    state = reduceUiState(state, { type: "resize", columns: 70, rows: 30 });
    expect(state.terminal.tier).toBe("narrow");

    state = reduceUiState(state, {
      type: "openOverlay",
      overlay: { kind: "music-picker", focus: "search", query: "moon", selectedIdentity: null, scroll: 2 },
    });
    const contextBeforeFreeze = state.overlays;
    state = reduceUiState(state, { type: "resize", columns: 59, rows: 30 });
    expect(state.terminal.tier).toBe("terminal-too-small");

    const frozen = reduceUiState(state, { type: "setQuery", query: "must not apply" });
    expect(frozen).toBe(state);

    state = reduceUiState(state, { type: "resize", columns: 80, rows: 16 });
    expect(state.terminal.tier).toBe("medium");
    expect(state.overlays).toEqual(contextBeforeFreeze);
  });

  test("repairs Queue selection and scroll by Track Identity across restore, reorder, removal, and resize", () => {
    let state = createInitialUiState();
    state = reduceUiState(state, {
      type: "syncQueue",
      identities: [alpha, beta, gamma],
      preferredIdentity: beta,
      visibleRows: 2,
    });
    expect(state.selectedQueueIdentity).toEqual(beta);
    expect(state.selectedQueueIndex).toBe(1);

    state = reduceUiState(state, {
      type: "syncQueue",
      identities: [gamma, alpha, beta],
      visibleRows: 2,
    });
    expect(state.selectedQueueIndex).toBe(2);
    expect(state.queueScroll).toBe(1);

    state = reduceUiState(state, {
      type: "syncQueue",
      identities: [gamma, alpha],
      visibleRows: 2,
    });
    expect(state.selectedQueueIdentity).toEqual(alpha);
    expect(state.selectedQueueIndex).toBe(1);

    state = reduceUiState(state, {
      type: "resize",
      columns: 60,
      rows: 16,
      queueIdentities: [gamma, alpha],
      visibleQueueRows: 1,
    });
    expect(state.selectedQueueIdentity).toEqual(alpha);
    expect(state.queueScroll).toBe(1);
  });

  test("minimally repairs Provider navigation scroll when overlay geometry changes", () => {
    let state = createInitialUiState();
    state = reduceUiState(state, {
      type: "openOverlay",
      overlay: {
        kind: "music-picker", focus: "results", query: "", selectedIdentity: null,
        selectedResultIndex: 9, scroll: 0, providerLocation: { providerId: "local", path: [] },
      },
    });
    state = reduceUiState(state, {
      type: "resize", columns: 70, rows: 16, overlayRowCount: 10, visibleOverlayRows: 3,
    });
    expect(state.overlays.at(-1)?.scroll).toBe(7);
    state = reduceUiState(state, {
      type: "resize", columns: 100, rows: 24, overlayRowCount: 10, visibleOverlayRows: 8,
    });
    expect(state.overlays.at(-1)?.scroll).toBe(2);
  });

  test("dismisses layered overlays and restores the exact prior Queue and Provider context", () => {
    let state = createInitialUiState();
    state = reduceUiState(state, {
      type: "setProviderLocation",
      location: { providerId: "local", path: [{ kind: "album", id: "albums" }] },
    });
    state = reduceUiState(state, {
      type: "syncQueue", identities: [alpha, beta], preferredIdentity: beta, visibleRows: 1,
    });

    state = reduceUiState(state, {
      type: "openOverlay",
      overlay: {
        kind: "music-picker",
        focus: "search",
        query: "new query",
        filterText: "Albums",
        providerLocation: { providerId: "navidrome", path: [{ kind: "artist", id: "1" }] },
        selectedIdentity: alpha,
        scroll: 8,
      },
    });
    state = reduceUiState(state, {
      type: "openOverlay",
      overlay: { kind: "shortcut-help", focus: "filter", query: "play", selectedIdentity: null, scroll: 3 },
    });
    state = reduceUiState(state, { type: "dismissOverlay" });
    expect(state.overlays.at(-1)).toMatchObject({ kind: "music-picker", query: "new query", scroll: 8 });

    state = reduceUiState(state, {
      type: "syncQueue",
      identities: [beta, gamma],
      preferredIdentity: gamma,
    });
    state = reduceUiState(state, { type: "dismissOverlay", queueIdentities: [beta, gamma] });
    expect(state.overlays).toEqual([]);
    expect(state.providerLocation).toEqual({ providerId: "local", path: [{ kind: "album", id: "albums" }] });
    expect(state.selectedQueueIdentity).toEqual(beta);
    expect(state.selectedQueueIndex).toBe(0);
    expect(state.queueScroll).toBe(0);
  });

  test("owns confirmation choice and requires an explicit confirmation", () => {
    let state = createInitialUiState();
    state = reduceUiState(state, { type: "requestConfirmation", kind: "clear-queue" });
    expect(state.pendingConfirmation).toEqual({ kind: "clear-queue", choice: "cancel" });
    state = reduceUiState(state, { type: "chooseConfirmation", choice: "confirm" });
    expect(state.pendingConfirmation?.choice).toBe("confirm");
    state = reduceUiState(state, { type: "cancelConfirmation" });
    expect(state.pendingConfirmation).toBeNull();
  });

  test("exposes a one-shot 750 ms gg state without scheduling a recurring timer", () => {
    const store = new UiStateStore(createInitialUiState());
    store.dispatch({ type: "syncQueue", identities: [alpha, beta], preferredIdentity: beta });
    store.dispatch({ type: "pressVimG", atMs: 1_000, identities: [alpha, beta] });
    expect(store.snapshot.pendingVimChord).toEqual({ key: "g", expiresAtMs: 1_750 });

    store.dispatch({ type: "pressVimG", atMs: 1_750, identities: [alpha, beta] });
    expect(store.snapshot.pendingVimChord).toBeNull();
    expect(store.snapshot.selectedQueueIdentity).toEqual(alpha);

    store.dispatch({ type: "pressVimG", atMs: 2_000, identities: [alpha, beta] });
    store.dispatch({ type: "expireVimChord", atMs: 2_751 });
    expect(store.snapshot.pendingVimChord).toBeNull();
  });
});
