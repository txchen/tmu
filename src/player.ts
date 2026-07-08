import type { PlaybackLocator, PlaybackState, Player } from "./domain";

export class NoopPlayer implements Player {
  private state: PlaybackState = {
    status: "idle",
    currentTrackIdentity: null,
  };

  get playback(): PlaybackState {
    return this.state;
  }

  async load(_locator: PlaybackLocator): Promise<void> {
    this.state = {
      status: "playing",
      currentTrackIdentity: this.state.currentTrackIdentity,
    };
  }

  async togglePause(): Promise<PlaybackState> {
    this.state = {
      ...this.state,
      status: this.state.status === "playing" ? "paused" : "playing",
    };
    return this.state;
  }

  async stop(): Promise<PlaybackState> {
    this.state = {
      status: "stopped",
      currentTrackIdentity: null,
    };
    return this.state;
  }
}
