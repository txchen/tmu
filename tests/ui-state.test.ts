import { describe, expect, test } from "bun:test";
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
      library: { query: "", inputFocused: true },
      downloader: { urlInput: "", inputFocused: true },
    });
  });
});
