import { describe, expect, test } from "vitest";
import { createInitialUiState, reduceUiState } from "../src/ui-state";

describe("top-level tab UI state", () => {
  test("always initializes on Playback", () => {
    expect(createInitialUiState().activeTab).toBe("playback");
  });

  test("retains Library and Downloader state while switching tabs", () => {
    let state = createInitialUiState();
    state = reduceUiState(state, { type: "switchTab", tab: "library" });
    state = reduceUiState(state, { type: "setLibraryQuery", query: "ambient" });
    state = reduceUiState(state, { type: "setLibraryInputFocus", focused: false });
    state = reduceUiState(state, { type: "switchTab", tab: "downloader" });
    state = reduceUiState(state, { type: "setDownloaderInput", value: "https://youtu.be/abc" });
    state = reduceUiState(state, { type: "setDownloaderInputFocus", focused: false });
    state = reduceUiState(state, { type: "switchTab", tab: "library" });

    expect(state.library).toMatchObject({ query: "ambient", inputFocused: false });
    expect(state.downloader).toMatchObject({
      urlInput: "https://youtu.be/abc",
      inputFocused: false,
    });
  });

  test("does not carry tab-local state into a new session", () => {
    const nextSession = createInitialUiState();
    expect(nextSession).toMatchObject({
      activeTab: "playback",
      library: { query: "", inputFocused: false },
      downloader: { urlInput: "", inputFocused: true },
    });
  });

  test("tracks pending gg chords and clears them after a jump", () => {
    let state = reduceUiState(createInitialUiState(), { type: "setPendingVimChord", pending: true });
    expect(state.pendingVimChord?.key).toBe("g");
    state = reduceUiState(state, { type: "setPendingVimChord", pending: false });
    expect(state.pendingVimChord).toBeNull();
  });

  test("moves Library selection only within the local result list", () => {
    let state = createInitialUiState();
    state = reduceUiState(state, { type: "setLibrarySelection", index: 4, resultCount: 3 });
    expect(state.library.selectedIndex).toBe(2);
    state = reduceUiState(state, { type: "setLibrarySelection", index: -1, resultCount: 3 });
    expect(state.library.selectedIndex).toBe(0);
  });

  test("opens confirmations on the safe choice and navigates choices", () => {
    let state = reduceUiState(createInitialUiState(), {
      type: "requestConfirmation", kind: "cancel-download", batchId: 7, target: "Road Trip",
    });
    expect(state.pendingConfirmation).toEqual({
      kind: "cancel-download", batchId: 7, target: "Road Trip", choice: "cancel",
    });
    state = reduceUiState(state, { type: "setConfirmationChoice", choice: "confirm" });
    expect(state.pendingConfirmation?.choice).toBe("confirm");
  });
});
