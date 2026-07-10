import type { AppIntent, AppState, UiState } from "./domain";
import type { UiStateAction } from "./ui-state";

export type RootInputRouterOptions = {
  appState(): Readonly<AppState>;
  uiState: { readonly snapshot: Readonly<UiState>; dispatch(action: UiStateAction): Readonly<UiState> };
  dispatchApp(intent: AppIntent): Promise<void>;
  requestQuit(): void;
};

export class RootInputRouter {
  constructor(private readonly options: RootInputRouterOptions) {}

  async route(key: string): Promise<void> {
    if (key === "q" || key === "\u0003") {
      this.options.requestQuit();
      return;
    }
    if (key === "1") this.options.uiState.dispatch({ type: "switchTab", tab: "playback" });
    else if (key === "2") this.options.uiState.dispatch({ type: "switchTab", tab: "library" });
    else if (key === "3") this.options.uiState.dispatch({ type: "switchTab", tab: "downloader" });
    else if (key === " ") await this.options.dispatchApp({ type: "playerOperation", operation: "toggle-play-pause" });
  }

  cancelPendingSequence(): void {}
}
