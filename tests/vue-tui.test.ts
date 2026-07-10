import { afterEach, describe, expect, test } from "bun:test";
import { render, cleanup } from "@vue-tui/testing";
import { createTmuRoot } from "../src/vue-tui/component";
import {
  AppCoordinator,
  MemoryQueue,
  createDefaultDependencyHealth,
  createInitialAppState,
  createInitialUiState,
  InMemoryLastQueueSnapshotPersistence,
  type PlaybackLocator,
  type Player,
  type PlayerPlaybackState,
  type Track,
} from "../src/index";

afterEach(() => cleanup());

const restoredTrack: Track = {
  identity: { providerId: "test", stableId: "restored-track" },
  title: "Restored Track",
  artist: "Test Artist",
  providerLabel: "Test",
  album: "Test Album",
  durationSeconds: 245,
};

const secondTrack: Track = {
  identity: { providerId: "remote", stableId: "second-track" },
  title: "A Second Track With A Deliberately Very Long Title That Must Never Wrap",
  artist: "Another Artist",
  providerLabel: "Navidrome",
  durationSeconds: 65,
};

class RecordingPlayer implements Player {
  toggles = 0;
  stops = 0;
  readonly loaded: PlaybackLocator[] = [];
  readonly seeks: number[] = [];
  readonly volumes: number[] = [];
  private state: PlayerPlaybackState = { status: "paused", positionSeconds: 37 };
  private readonly listeners = new Set<(state: PlayerPlaybackState) => void>();

  get playback() { return this.state; }
  async start() { return this.state; }
  async load(locator: PlaybackLocator) {
    this.loaded.push(locator);
    this.publish({ status: "playing", positionSeconds: 0 });
  }
  async togglePause() {
    this.toggles += 1;
    this.publish({ ...this.state, status: this.state.status === "playing" ? "paused" : "playing" });
    return this.state;
  }
  async setPaused(paused: boolean) {
    this.toggles += 1;
    this.publish({ ...this.state, status: paused ? "paused" : "playing" });
    return this.state;
  }
  async stop() { this.stops += 1; this.publish({ status: "stopped", positionSeconds: 0 }); return this.state; }
  async seekBy(seconds: number) { this.seeks.push(seconds); return this.state; }
  async setVolume(percent: number) { this.volumes.push(percent); this.publish({ ...this.state, volumePercent: percent }); return this.state; }
  async teardown() {}
  onPlaybackStateChange(listener: (state: PlayerPlaybackState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publishPosition(positionSeconds: number) { this.publish({ ...this.state, positionSeconds }); }
  publishState(state: PlayerPlaybackState) { this.publish(state); }
  setStateSilently(state: PlayerPlaybackState) { this.state = state; }
  private publish(state: PlayerPlaybackState) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

async function productionHarness(options: {
  tracks?: readonly Track[];
  currentIndex?: number;
  availability?: "available" | "unavailable";
  unavailableIndexes?: readonly number[];
} = {}) {
  const player = new RecordingPlayer();
  const snapshots = new InMemoryLastQueueSnapshotPersistence();
  const tracks = options.tracks ?? [restoredTrack];
  const currentIndex = options.currentIndex ?? 0;
  await snapshots.save({
    version: 1,
    entries: tracks.map((track, index) => ({
      track,
      availability: (options.availability === "unavailable" && index === currentIndex)
        || options.unavailableIndexes?.includes(index)
        ? { status: "unavailable" as const, reason: "Provider authentication expired; sign in and retry" }
        : { status: "available" as const },
    })),
    currentIndex,
    shuffle: false,
    repeatAll: false,
    volume: { percent: 72, ready: true },
  });
  const dependencyHealth = createDefaultDependencyHealth();
  dependencyHealth.playback = { enabled: true, message: "Test Player ready" };
  const coordinator = new AppCoordinator({
    appState: createInitialAppState({
      test: {
        id: "test",
        label: "Test",
        hint: "one restored Track",
        capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["track"], operations: [] },
        getNavigationRoot: () => ({ visible: true, order: 10, detail: "one restored Track" }),
        listVisibleTracks: () => tracks,
        resolvePlaybackLocator: async () => ({ kind: "file", path: "/dev/null" }),
      },
      remote: {
        id: "remote",
        label: "Navidrome",
        hint: "remote Tracks",
        capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["track"], operations: [] },
        getNavigationRoot: () => ({ visible: true, order: 20, detail: "remote Tracks" }),
        listVisibleTracks: () => tracks,
        resolvePlaybackLocator: async () => ({ kind: "file", path: "/dev/null" }),
      },
    }, { dependencyHealth }),
    uiState: createInitialUiState(),
    queue: new MemoryQueue(),
    player,
    snapshotPersistence: snapshots,
  });
  await coordinator.start();
  coordinator.appState.playback = {
    status: "paused",
    positionSeconds: 37,
    currentTrackIdentity: tracks[currentIndex]?.identity ?? null,
  };
  return { coordinator, player };
}

describe("production vue-tui", () => {
  test("presents YouTube URL entry and current App State download progress responsively", async () => {
    const { coordinator } = await productionHarness({ tracks: [] });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 70, rows: 20 });

    await terminal.stdin.write("u");
    expect(terminal.lastFrame()).toContain("URL:");
    expect(terminal.lastFrame()).toContain("Enter download");
    await terminal.stdin.write("\x1b");

    coordinator.appState.downloads = { active: true, lines: ["download 42.0% · ETA 00:08"] };
    coordinator.appState.lastEvent = "downloading YouTube audio";
    coordinator.dispatchUi({ type: "updateView", patch: {} });
    await terminal.stdin.write("u");
    expect(terminal.lastFrame()).toContain("Download in progress");
    expect(terminal.lastFrame()).toContain("download 42.0% · ETA 00:08");
    expect(terminal.lastFrame()).toContain("x cancel · Esc/q dismiss · download continues");

    await terminal.stdin.write("x");
    expect(terminal.lastFrame()).toContain("Cancel YouTube download?");
    expect(terminal.lastFrame()).toContain("clean up partial files");
  });

  test("restores Queue Home without autoplay, resumes through registry dispatch, and traps overlay input", async () => {
    const { coordinator, player } = await productionHarness();
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 24 });

    expect(terminal.lastFrame()).toContain("Queue · 1 Tracks");
    expect(terminal.lastFrame()).toContain("Restored Track");
    expect(terminal.lastFrame()).toContain("Restored · Resume from 0:37");
    expect(player.toggles).toBe(0);

    await terminal.stdin.write(" ");
    expect(player.toggles).toBe(1);
    expect(terminal.lastFrame()).toContain("Playing");

    await terminal.stdin.write("o");
    expect(terminal.lastFrame()).toContain("Picker Overlay · music-picker");
    await terminal.stdin.write(" ");
    expect(player.toggles).toBe(1);
    await terminal.stdin.write("q");
    expect(terminal.lastFrame()).not.toContain("Picker Overlay");
    expect(terminal.lastFrame()).toContain("Restored Track");
  });

  test("drives Current Track playback and visible Queue traversal through real global keys", async () => {
    const unavailableTrack: Track = {
      identity: { providerId: "remote", stableId: "unavailable-track" },
      title: "Unavailable Track",
      providerLabel: "Navidrome",
    };
    const { coordinator, player } = await productionHarness({
      tracks: [restoredTrack, unavailableTrack, secondTrack],
      unavailableIndexes: [1],
    });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 24 });

    await terminal.stdin.write("j");
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(unavailableTrack.identity);
    await terminal.stdin.write(" ");
    expect(player.toggles).toBe(1);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(restoredTrack.identity);

    player.publishState({ status: "playing", positionSeconds: 8 });
    await terminal.stdin.write("p");
    expect(player.seeks).toEqual([-8]);
    expect(player.loaded).toEqual([]);

    player.publishState({ status: "paused", positionSeconds: 8 });
    await terminal.stdin.write("p");
    expect(player.seeks).toEqual([-8, -8]);
    expect(coordinator.appState.playback.status).toBe("playing");

    player.publishState({ status: "playing", positionSeconds: 5 });
    await terminal.stdin.write("p");
    expect(player.loaded.at(-1)).toEqual({ kind: "file", path: "/dev/null" });
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(restoredTrack.identity);

    await terminal.stdin.write("n");
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(secondTrack.identity);
    expect(coordinator.appState.queue.entries[1]?.availability).toEqual({
      status: "unavailable",
      reason: "Provider authentication expired; sign in and retry",
    });

    await terminal.stdin.write("n");
    expect(player.stops).toBe(1);
    expect(coordinator.appState.playback).toMatchObject({
      status: "stopped",
      positionSeconds: 0,
      currentTrackIdentity: secondTrack.identity,
    });

    await terminal.stdin.write(" ");
    expect(player.loaded).toHaveLength(3);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(secondTrack.identity);
    await terminal.stdin.write("s");
    expect(player.stops).toBe(2);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(secondTrack.identity);
    expect(coordinator.appState.playback.positionSeconds).toBe(0);

    for (const key of ["]", "+", "z"]) await terminal.stdin.write(key);
    await terminal.stdin.write(":");
    await terminal.stdin.write("toggle repeat all");
    await terminal.stdin.write("\r");
    expect(player.seeks.at(-1)).toBe(5);
    expect(player.volumes.at(-1)).toBe(77);
    expect(coordinator.appState.queue.shuffle).toBe(true);
    expect(coordinator.appState.queue.repeatAll).toBe(true);
  });

  test("Space starts the selected Queue Track when no Current Track exists", async () => {
    const { coordinator, player } = await productionHarness({
      tracks: [restoredTrack, secondTrack],
      currentIndex: -1,
    });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 24 });

    await terminal.stdin.write("j");
    await terminal.stdin.write(" ");

    expect(player.loaded).toEqual([{ kind: "file", path: "/dev/null" }]);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(secondTrack.identity);
  });

  test("routes Enter Play Next and Shift+Enter Play Now from Queue rows", async () => {
    const thirdTrack: Track = {
      identity: { providerId: "test", stableId: "third-track" },
      title: "Third Track",
      providerLabel: "Test",
    };
    const { coordinator, player } = await productionHarness({
      tracks: [restoredTrack, secondTrack, thirdTrack],
    });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 24 });

    await terminal.stdin.write("j");
    await terminal.stdin.write("j");
    await terminal.stdin.write("\r");

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual([
      restoredTrack.title,
      thirdTrack.title,
      secondTrack.title,
    ]);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(restoredTrack.identity);
    expect(player.loaded).toEqual([]);

    await terminal.stdin.write("\x1b[13;2u");

    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(thirdTrack.identity);
    expect(player.loaded).toEqual([{ kind: "file", path: "/dev/null" }]);
  });

  test("routes Enter and Shift+Enter from a playable Music Collection result", async () => {
    const { coordinator, player } = await productionHarness({ tracks: [restoredTrack, secondTrack] });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 24 });
    const collection = {
      kind: "music-collection" as const,
      id: "remote:album:set",
      label: "Set",
      tracks: [secondTrack],
    };
    coordinator.appState.providers.navidrome = {
      id: "navidrome",
      label: "Navidrome",
      hint: "Music Collections",
      capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["album", "track"], operations: [] },
      getNavigationRoot: () => ({ visible: true, order: 20, detail: "Music Collections" }),
      listVisibleTracks: () => [],
      playableTargetAt: () => collection,
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/dev/null" }),
    };
    coordinator.dispatchUi({
      type: "openOverlay",
      overlay: {
        kind: "music-picker",
        focus: "results",
        query: "set",
        selectedIdentity: secondTrack.identity,
        selectedResultIndex: 0,
        providerLocation: { providerId: "navidrome", path: [] },
        scroll: 0,
      },
    });

    await terminal.stdin.write("\r");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual([
      restoredTrack.title,
      secondTrack.title,
    ]);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(restoredTrack.identity);
    expect(coordinator.uiState.overlays.at(-1)?.selectedResultIndex).toBe(0);

    await terminal.stdin.write("\x1b[13;2u");
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(secondTrack.identity);
    expect(player.loaded).toEqual([{ kind: "file", path: "/dev/null" }]);
  });

  test("Space reloads a restored Current Track and seeks to its resumable position", async () => {
    const { coordinator, player } = await productionHarness();
    player.setStateSilently({ status: "idle" });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 24 });

    await terminal.stdin.write(" ");

    expect(player.loaded).toEqual([{ kind: "file", path: "/dev/null" }]);
    expect(player.seeks).toEqual([37]);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(restoredTrack.identity);
  });

  test("crosses responsive tiers without losing Current Track, Track Identity selection, or overlay state", async () => {
    const { coordinator } = await productionHarness();
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 24 });
    await terminal.stdin.write("o");

    for (const [columns, rows, tier] of [
      [100, 24, "medium"],
      [70, 24, "narrow"],
      [50, 14, "terminal-too-small"],
      [130, 30, "wide"],
    ] as const) {
      await terminal.terminal.resize(columns, rows);
      await terminal.waitUntilRenderFlush();
      expect(coordinator.uiState.terminal.tier).toBe(tier);
      expect(coordinator.uiState.selectedQueueIdentity).toEqual(restoredTrack.identity);
      expect(coordinator.appState.playback.currentTrackIdentity).toEqual(restoredTrack.identity);
      expect(coordinator.uiState.overlays.at(-1)?.kind).toBe("music-picker");
    }
  });

  test("uses approved tier layouts, one-row metadata reduction, and stable too-small recovery", async () => {
    const { coordinator, player } = await productionHarness({ tracks: [restoredTrack, secondTrack] });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 130, rows: 24 });

    expect(terminal.lastFrame()).toContain("Queue · 2 Tracks");
    expect(terminal.lastFrame()).not.toContain("Queue Home · wide");
    expect(terminal.lastFrame()).toContain("Test Artist");
    expect(terminal.lastFrame()).toContain("Test Album");
    expect(terminal.lastFrame()).toContain("Test");

    await terminal.terminal.resize(100, 24);
    await terminal.waitUntilRenderFlush();
    expect(terminal.lastFrame()).toContain("Test Artist");
    expect(terminal.lastFrame()).not.toContain("Test Album");

    await terminal.terminal.resize(70, 24);
    await terminal.waitUntilRenderFlush();
    expect(terminal.lastFrame()).toContain("Current: Restored Track");
    expect(terminal.lastFrame()).not.toContain("Test Artist");
    expect(terminal.lastFrame()?.match(/A Second Track/g)).toHaveLength(1);

    await terminal.terminal.resize(59, 24);
    await terminal.waitUntilRenderFlush();
    expect(terminal.lastFrame()).toContain("Need 60×16 · state preserved");
    expect(terminal.lastFrame()).not.toContain("Picker Overlay");
    await terminal.stdin.write("j ");
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(restoredTrack.identity);
    expect(player.toggles).toBe(0);

    await terminal.terminal.resize(70, 24);
    await terminal.waitUntilRenderFlush();
    expect(terminal.lastFrame()).toContain("Current: Restored Track");
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(restoredTrack.identity);
  });

  test("switches every fixed-cell marker to ASCII and remains operable without color", async () => {
    const { coordinator } = await productionHarness({ tracks: [restoredTrack, secondTrack], availability: "unavailable" });
    const terminal = await render(createTmuRoot({
      coordinator,
      measureCellWidth: () => 2,
      noColor: true,
    }), { columns: 120, rows: 24 });
    const frame = terminal.lastFrame({ raw: true }) ?? "";

    expect(frame).toContain("> * !");
    expect(frame).not.toContain("›");
    expect(frame).not.toContain("●");
    expect(frame).not.toMatch(/\x1b\[(?:3[0-7]|9[0-7])m/);
    expect(frame).toContain("Unavailable");
    expect(frame).toContain("Provider authentication expired");
    expect(frame).toContain("Retry or choose another Track");
  });

  test("renders empty, Playing, Paused, Stopped, Restored, and unavailable guidance", async () => {
    const empty = await productionHarness({ tracks: [], currentIndex: -1 });
    const emptyTerminal = await render(createTmuRoot({ coordinator: empty.coordinator }), { columns: 80, rows: 20 });
    expect(emptyTerminal.lastFrame()).toContain("Queue is empty");
    expect(emptyTerminal.lastFrame()).toContain("/ Global Search");
    expect(emptyTerminal.lastFrame()).toContain("o Local music");
    expect(emptyTerminal.lastFrame()).toContain("u YouTube URL Download");
    expect(emptyTerminal.lastFrame()).not.toContain("Enter Play Next");
    expect(emptyTerminal.lastFrame()).not.toContain("x Remove");
    await emptyTerminal.stdin.write("u");
    expect(emptyTerminal.lastFrame()).toContain("Picker Overlay · youtube-url");
    emptyTerminal.unmount();

    const { coordinator } = await productionHarness();
    coordinator.appState.playback = { status: "playing", currentTrackIdentity: restoredTrack.identity };
    let terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 20 });
    expect(terminal.lastFrame()).toContain("Playing · Restored Track");
    terminal.unmount();

    coordinator.appState.playback = { status: "paused", positionSeconds: 0, currentTrackIdentity: restoredTrack.identity };
    terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 20 });
    expect(terminal.lastFrame()).toContain("Paused · Space to Resume");
    terminal.unmount();

    coordinator.appState.playback = {
      status: "paused",
      paused: true,
      positionSeconds: 0.25,
      currentTrackIdentity: restoredTrack.identity,
    };
    terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 20 });
    expect(terminal.lastFrame()).toContain("Paused · Space to Resume");
    expect(terminal.lastFrame()).not.toContain("Restored · Resume");
    terminal.unmount();

    coordinator.appState.playback = { status: "stopped", positionSeconds: 0, currentTrackIdentity: restoredTrack.identity };
    terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 20 });
    expect(terminal.lastFrame()).toContain("Stopped · starts from beginning");
    terminal.unmount();

    coordinator.appState.playback = { status: "paused", positionSeconds: 37, currentTrackIdentity: restoredTrack.identity };
    terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 20 });
    expect(terminal.lastFrame()).toContain("Restored · Resume from 0:37");
  });

  test("moves by Vim keys and aliases, clamps, repairs visibility, and exposes pending g", async () => {
    const tracks = Array.from({ length: 20 }, (_, index): Track => ({
      identity: { providerId: "test", stableId: `track-${index}` },
      title: `Track ${index}`,
      artist: "Artist",
      providerLabel: "Test",
      durationSeconds: index,
    }));
    const { coordinator } = await productionHarness({ tracks });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 70, rows: 16 });

    await terminal.stdin.write("G");
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(tracks[19]?.identity);
    expect(terminal.lastFrame()).toContain("Track 19");
    expect(terminal.lastFrame()).not.toContain("›     Track 0");

    await terminal.stdin.write("\x1b[H");
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(tracks[0]?.identity);
    await terminal.stdin.write("k");
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(tracks[0]?.identity);
    await terminal.stdin.write("\x1b[6~");
    expect(coordinator.uiState.selectedQueueIndex).toBeGreaterThan(0);
    await terminal.stdin.write("g");
    expect(terminal.lastFrame()).toContain("g… Go to first");
    await terminal.stdin.write("g");
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(tracks[0]?.identity);

    await terminal.stdin.write("?");
    await terminal.stdin.write("G");
    const lastHelpIndex = coordinator.uiState.overlays.at(-1)?.selectedResultIndex;
    expect(lastHelpIndex).toBeGreaterThan(0);
    await terminal.stdin.write("g");
    expect(terminal.lastFrame()).toContain("g… Go to first");
    expect(coordinator.uiState.overlays.at(-1)?.selectedResultIndex).toBe(lastHelpIndex);
    await terminal.stdin.write("g");
    expect(coordinator.uiState.overlays.at(-1)?.selectedResultIndex).toBe(0);
  });

  test("shows recovery for a selected unavailable narrow row without displacing the footer", async () => {
    const { coordinator } = await productionHarness({ tracks: [restoredTrack, secondTrack] });
    const unavailable = coordinator.appState.queue.entries[1];
    if (unavailable) unavailable.availability = { status: "unavailable", reason: "Navidrome sign-in expired" };
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 70, rows: 16 });

    await terminal.stdin.write("j");
    const frame = terminal.lastFrame() ?? "";
    expect(frame).toContain("Navidrome sign-in expired · Retry");
    expect(frame).toContain("? Help");
    expect(frame.split("\n").at(-1)).toContain("? Help");
  });

  test("routes footer discovery keys through the shared registry and root router", async () => {
    const { coordinator } = await productionHarness();
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 20 });

    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("Picker Overlay · shortcut-help");
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write(":");
    expect(terminal.lastFrame()).toContain("Picker Overlay · command-palette");
  });

  test("renders searchable registry metadata in help and the Command Palette", async () => {
    const { coordinator } = await productionHarness({ tracks: [restoredTrack] });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });

    await terminal.stdin.write("?");
    let frame = terminal.lastFrame() ?? "";
    expect(frame).toContain("Play Next");
    expect(frame).toContain("Enter");
    await terminal.stdin.write("/");
    await terminal.stdin.write("immediately");
    frame = terminal.lastFrame() ?? "";
    expect(frame).toContain("Play Now");
    expect(frame).not.toContain("Clear Queue");

    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("q");
    await terminal.stdin.write(":");
    await terminal.stdin.write("play immediately");
    frame = terminal.lastFrame() ?? "";
    expect(frame).toContain("Play Now");
    expect(frame).toContain("Shift+Enter");
  });

  test("shows disabled reasons from the registry in the Command Palette", async () => {
    const { coordinator } = await productionHarness({ tracks: [], currentIndex: -1 });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });

    await terminal.stdin.write(":");
    await terminal.stdin.write("play next");
    expect(terminal.lastFrame()).toContain("Queue is empty");
  });

  test("moves Command Palette selection with conventional keys while keeping printable keys in its query", async () => {
    const { coordinator } = await productionHarness();
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });

    await terminal.stdin.write(":");
    await terminal.stdin.write("toggle");
    expect(terminal.lastFrame()).toContain("Toggle Shuffle");
    expect(terminal.lastFrame()).toContain("Toggle Repeat All");
    await terminal.stdin.write("\x1b[B");
    await terminal.stdin.write("\r");

    expect(coordinator.appState.queue.repeatAll).toBe(true);
    expect(coordinator.uiState.overlays).toEqual([]);
  });

  test("shows a Cancel-first Clear Queue confirmation and applies only the confirmed choice", async () => {
    const { coordinator, player } = await productionHarness({ tracks: [restoredTrack, secondTrack] });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 24 });

    await terminal.stdin.write("c");
    expect(terminal.lastFrame()).toContain("Clear Queue?");
    expect(terminal.lastFrame()).toContain("[Cancel]");
    await terminal.stdin.write("\r");
    expect(coordinator.appState.queue.entries).toHaveLength(2);
    expect(player.stops).toBe(0);

    await terminal.stdin.write("c");
    await terminal.stdin.write("q");
    expect(coordinator.appState.queue.entries).toHaveLength(2);
    expect(terminal.lastFrame()).toContain("Queue · 2 Tracks");

    await terminal.stdin.write("c");
    await terminal.stdin.write("\t");
    expect(terminal.lastFrame()).toContain("[Clear]");
    await terminal.stdin.write("\r");
    expect(coordinator.appState.queue.entries).toEqual([]);
    expect(coordinator.appState.playback.currentTrackIdentity).toBeNull();
    expect(coordinator.uiState.selectedQueueIdentity).toBeNull();
    expect(player.stops).toBe(1);
  });

  test("keeps Track-identity selection and Current Track stable through Queue reorder and removal", async () => {
    const thirdTrack: Track = {
      identity: { providerId: "test", stableId: "third-track" },
      title: "Third Track",
      providerLabel: "Test",
    };
    const { coordinator, player } = await productionHarness({
      tracks: [restoredTrack, secondTrack, thirdTrack],
    });
    coordinator.appState.playback = { status: "playing", currentTrackIdentity: restoredTrack.identity };
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 24 });

    await terminal.stdin.write("j");
    await terminal.stdin.write("J");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual([
      "Restored Track",
      "Third Track",
      secondTrack.title,
    ]);
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(secondTrack.identity);
    expect(coordinator.uiState.selectedQueueIndex).toBe(2);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(restoredTrack.identity);
    expect(player.stops).toBe(0);

    await terminal.stdin.write("x");
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(thirdTrack.identity);
    expect(player.stops).toBe(0);

    await terminal.stdin.write("g");
    await terminal.stdin.write("g");
    await terminal.stdin.write("x");
    expect(player.stops).toBe(1);
    expect(coordinator.appState.playback.currentTrackIdentity).toBeNull();
    expect(coordinator.appState.queue.currentIndex).toBe(-1);
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(thirdTrack.identity);
  });

  test("keeps a one-row footer with discovery routes at every supported tier", async () => {
    const { coordinator } = await productionHarness();
    for (const columns of [130, 100, 70]) {
      const terminal = await render(createTmuRoot({ coordinator }), { columns, rows: 20 });
      const frame = terminal.lastFrame() ?? "";
      const footer = frame.split("\n").find((line) => line.includes("? Help"));
      expect(footer).toContain(": Commands");
      expect(Bun.stringWidth(footer ?? "")).toBeLessThanOrEqual(columns);
      terminal.unmount();
    }
  });

  test("does not redraw while idle or for playback-position-only publications", async () => {
    const { coordinator, player } = await productionHarness();
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 120, rows: 24 });
    const initialFrames = terminal.frames.length;

    await Bun.sleep(80);
    expect(terminal.frames).toHaveLength(initialFrames);

    await terminal.stdin.write(" ");
    const playingFrames = terminal.frames.length;
    player.publishPosition(1);
    await Bun.sleep(80);
    expect(terminal.frames).toHaveLength(playingFrames);
  });
});
