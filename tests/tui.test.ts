import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  AppCoordinator,
  MemoryQueue,
  NoopPlayer,
  TerminalTui,
  createInitialAppState,
  createInitialUiState,
  createDefaultProviders,
  intentFromKey,
} from "../src/index";

class FakeInput extends EventEmitter {
  isTTY = true;
  rawMode = false;
  resumed = false;

  setRawMode(enabled: boolean) {
    this.rawMode = enabled;
  }

  resume() {
    this.resumed = true;
  }
}

class FakeOutput {
  isTTY = true;
  readonly chunks: string[] = [];

  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
}

describe("intentFromKey", () => {
  test("maps playback control keys to App Coordinator intents", () => {
    expect(intentFromKey(" ")).toEqual({ type: "togglePlayPause" });
    expect(intentFromKey("s")).toEqual({ type: "stop" });
    expect(intentFromKey("n")).toEqual({ type: "nextTrack" });
    expect(intentFromKey("p")).toEqual({ type: "previousTrack" });
    expect(intentFromKey("[")).toEqual({ type: "seekBy", seconds: -5 });
    expect(intentFromKey("]")).toEqual({ type: "seekBy", seconds: 5 });
    expect(intentFromKey("-")).toEqual({ type: "adjustVolume", delta: -5 });
    expect(intentFromKey("+")).toEqual({ type: "adjustVolume", delta: 5 });
  });
});

describe("TerminalTui", () => {
  test("redraws when App Coordinator state changes outside key input", async () => {
    const player = new NoopPlayer();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player,
    });
    const input = new FakeInput();
    const output = new FakeOutput();
    const tui = new TerminalTui(
      { coordinator },
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    tui.run();
    const writesAfterInitialDraw = output.chunks.length;

    await player.load({ kind: "file", path: "/music/amber.flac" });

    expect(output.chunks.length).toBeGreaterThan(writesAfterInitialDraw);
    expect(coordinator.appState.playback.status).toBe("playing");
  });

  test("redraws on input even when no intent is mapped", () => {
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(createDefaultProviders()),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });
    const input = new FakeInput();
    const output = new FakeOutput();
    const tui = new TerminalTui(
      { coordinator },
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    tui.run();
    const writesAfterInitialDraw = output.chunks.length;
    input.emit("data", "?");

    expect(output.chunks.length).toBeGreaterThan(writesAfterInitialDraw);
  });
});
