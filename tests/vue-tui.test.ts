import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@vue-tui/testing";
import { createTmuApp } from "../src/app";
import { AppCoordinator } from "../src/coordinator";
import type { PlayerPlaybackState, Provider, Track } from "../src/domain";
import { NoopPlayer } from "../src/player";
import { MemoryQueue } from "../src/queue";
import { createInitialAppState, createInitialUiState } from "../src/state";
import { StatePublicationGate } from "../src/state-publication";
import { createTmuRoot } from "../src/vue-tui/component";
import type { YouTubeCacheProvider } from "../src/youtube-cache";

afterEach(() => cleanup());

describe("TMU top-level surface smoke", () => {
  test("shows and dismisses an error recorded before the TUI mounts", async () => {
    const { coordinator } = createTmuApp();
    coordinator.appState.appErrors.push("Could not restore Last Queue Snapshot");
    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 100, rows: 24 });
    expect(terminal.lastFrame()).toContain("× ERROR · Could not restore Last Queue Snapshot");
    await terminal.stdin.write("\x1b");
    expect(terminal.lastFrame()).not.toContain("Could not restore Last Queue Snapshot");
  });

  test("renders the keyboard-first shell and routes global brackets through focused inputs", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 100, rows: 24 });
    expect(terminal.lastFrame()).toContain("╭");
    expect(terminal.lastFrame()).toContain("Player");
    expect(terminal.lastFrame()).toContain("Library");
    expect(terminal.lastFrame()).toContain("Downloads");
    expect(terminal.lastFrame()).toContain("Queue is empty — open Library to add Tracks.");
    expect(terminal.lastFrame()).not.toContain("focused");
    await terminal.stdin.write("]");
    expect(coordinator.uiState.activeTab).toBe("library");
    expect(coordinator.uiState.library.inputFocused).toBe(false);
    await terminal.stdin.write("\t");
    expect(coordinator.uiState.library.inputFocused).toBe(true);
    await terminal.stdin.write("space?");
    expect(coordinator.uiState.library.query).toBe("space?");
    await terminal.stdin.write("]");
    expect(coordinator.uiState.activeTab).toBe("downloader");
    await terminal.stdin.write("[");
    expect(coordinator.uiState.activeTab).toBe("library");
    expect(coordinator.uiState.library.query).toBe("space?");
    await terminal.stdin.write("\x1b");
    expect(coordinator.uiState.library.inputFocused).toBe(false);
  });

  test("shows compact Current Track playback on every tab and hides it without Current", async () => {
    const track = { ...cachedTrack("current", "A Very Long Current Track Title That Must Stay Compact"), durationSeconds: 245 };
    const queue = new MemoryQueue();
    queue.enqueue(track);
    queue.startAt(0);
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({}), uiState: createInitialUiState(),
      queue, player: new NoopPlayer(),
    });
    const hidden = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 80, rows: 24 });
    expect(hidden.lastFrame()).not.toContain("NOW PLAYING");
    coordinator.appState.queue = queue.snapshot();
    coordinator.appState.playback = {
      status: "playing", currentTrackIdentity: track.identity,
      positionSeconds: 65, durationSeconds: 245,
    };
    coordinator.appState.volume = { percent: 73, ready: true };
    coordinator.appState.queue.repeatAll = true;

    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 80, rows: 24 });
    for (const tab of ["playback", "library", "downloader"] as const) {
      coordinator.dispatchUi({ type: "switchTab", tab });
      const frame = terminal.lastFrame()!;
      expect(frame).toContain("▶ PLAYING");
      expect(frame).toContain("A Very Long Current Track");
      expect(frame).toContain("1:05/4:05");
      expect(frame).toContain("[██▋░░░░░░░]");
      expect(frame).toContain("Vol 73%");
      expect(frame).toContain("↻ ALL");
      expect(frame.indexOf("NOW PLAYING")).toBeLessThan(frame.indexOf("? Help"));
      expect(frame).not.toContain("Artist:");
      expect(frame).not.toContain("Channel:");
      expect(frame).not.toContain("Randomize");
    }
  });

  test.each([
    ["paused", "Ⅱ PAUSED"],
    ["stopped", "■ STOPPED"],
    ["error", "! ERROR"],
  ] as const)("gives %s playback a non-color status cue", async (status, cue) => {
    const track = cachedTrack("status", "Status Track");
    const queue = new MemoryQueue();
    queue.enqueue(track);
    queue.startAt(0);
    if (status === "error") queue.markAvailability(track.identity, { status: "unavailable", reason: "cache missing" });
    const appState = createInitialAppState({});
    appState.queue = queue.snapshot();
    appState.playback = { status, currentTrackIdentity: track.identity, positionSeconds: 42,
      ...(status === "paused" ? { paused: true } : {}) };
    const coordinator = new AppCoordinator({ appState, uiState: createInitialUiState(), queue, player: new NoopPlayer() });
    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 80, rows: 24 });
    expect(terminal.lastFrame()).toContain(cue);
    expect(terminal.lastFrame()).toContain("0:42");
    expect(terminal.lastFrame()).not.toContain("0:42/");
  });

  test("distinguishes restored resumable playback and truncates on narrow terminals", async () => {
    const track = cachedTrack("restored", "Restored Track With A Title Far Too Long For A Narrow Terminal");
    const queue = new MemoryQueue();
    queue.enqueue(track);
    queue.startAt(0);
    const appState = createInitialAppState({});
    appState.queue = queue.snapshot();
    appState.playback = { status: "paused", currentTrackIdentity: track.identity, positionSeconds: 42, restored: true };
    const coordinator = new AppCoordinator({ appState, uiState: createInitialUiState(), queue, player: new NoopPlayer() });
    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 60, rows: 20 });
    expect(terminal.lastFrame()).toContain("↻ RESUME");
    expect(terminal.lastFrame()!.split("\n").every((line) => [...line].length <= 60)).toBe(true);
  });

  test("bounds passive progress publication while publishing user progress immediately", () => {
    const appState = createInitialAppState({});
    const uiState = createInitialUiState();
    appState.playback = { status: "playing", currentTrackIdentity: null, positionSeconds: 1 };
    let now = 0;
    let scheduled: (() => void) | undefined;
    const gate = new StatePublicationGate({
      readState: () => ({ appState, uiState }),
      cadence: { playbackCadenceMs: 5_000, downloadProgressMs: 1_000, providerProgressMs: 1_000 },
      timers: {
        now: () => now,
        setTimeout: (callback) => { scheduled = callback; return callback; },
        clearTimeout: (timer) => { if (scheduled === timer) scheduled = undefined; },
      },
    });
    gate.publishInitial();

    appState.playback.positionSeconds = 2;
    gate.notify("playback");
    expect(gate.snapshot?.appState.playback.positionSeconds).toBe(1);
    now = 5_000;
    scheduled?.();
    expect(gate.snapshot?.appState.playback.positionSeconds).toBe(2);

    appState.playback.positionSeconds = 7;
    gate.notify("input");
    expect(gate.snapshot?.appState.playback.positionSeconds).toBe(7);
  });

  test("renders passive progress on cadence and a user seek immediately", async () => {
    const track = { ...cachedTrack("cadence-root", "Cadence Root Track"), durationSeconds: 100 };
    const queue = new MemoryQueue();
    queue.enqueue(track);
    queue.startAt(0);
    const appState = createInitialAppState({}, { config: { lowPower: { playbackProgressMs: 5_000 } } });
    appState.queue = queue.snapshot();
    appState.playback = { status: "playing", currentTrackIdentity: track.identity, positionSeconds: 1, durationSeconds: 100 };
    const player = new PublishingPlayer();
    player.publish({ status: "playing", positionSeconds: 1, durationSeconds: 100 });
    const coordinator = new AppCoordinator({ appState, uiState: createInitialUiState(), queue, player });
    let now = 0;
    let scheduled: (() => void) | undefined;
    const terminal = await render(createTmuRoot({
      coordinator, noColor: true,
      publicationTimers: {
        now: () => now,
        setTimeout: (callback) => { scheduled = callback; return callback; },
        clearTimeout: (timer) => { if (scheduled === timer) scheduled = undefined; },
      },
    }), { columns: 100, rows: 24 });

    player.publish({ status: "playing", positionSeconds: 2, durationSeconds: 100 });
    expect(terminal.lastFrame()).toContain("0:01/1:40");
    now = 5_000;
    scheduled?.();
    await waitFor(() => terminal.lastFrame()!.includes("0:02/1:40"));
    expect(terminal.lastFrame()).toContain("[▎░░░░░░░░░]");

    await terminal.stdin.write("l");
    expect(terminal.lastFrame()).toContain("0:07/1:40");
    expect(terminal.lastFrame()).toContain("[▊░░░░░░░░░]");
  });

  test("removes numeric tabs and command palette while help suspends actions", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });
    await terminal.stdin.write("2");
    expect(coordinator.uiState.activeTab).toBe("playback");
    await terminal.stdin.write(":");
    expect(terminal.lastFrame()).not.toContain("Command Palette");
    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("Playback Shortcuts");
    await terminal.stdin.write("]");
    expect(coordinator.uiState.activeTab).toBe("playback");
    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).not.toContain("Playback Shortcuts");
  });

  test("keeps responsive state and suspends hidden actions while terminal is too small", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 100, rows: 24 });
    await terminal.terminal.resize(59, 15);
    expect(terminal.lastFrame()).toContain("Terminal too small");
    await terminal.stdin.write("]");
    expect(coordinator.uiState.activeTab).toBe("playback");
    await terminal.terminal.resize(120, 24);
    expect(coordinator.uiState.terminal.tier).toBe("wide");
    expect(terminal.lastFrame()).toContain("Player");
  });

  test("moves and keeps long Queue selections visible with shared Vim navigation", async () => {
    const { coordinator } = createTmuApp();
    for (let index = 0; index < 12; index++) await coordinator.dispatch({ type: "addToQueue", target: cachedTrack(`track-${index}`, `Track ${index}`) });
    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 80, rows: 24 });
    await terminal.stdin.write("G");
    expect(coordinator.uiState.selectedQueueIndex).toBe(11);
    expect(terminal.lastFrame()).toContain("› ! Track 11");
    await terminal.stdin.write("g");
    await terminal.stdin.write("g");
    expect(coordinator.uiState.selectedQueueIndex).toBe(0);
    await terminal.stdin.write("\x1b[6~");
    expect(coordinator.uiState.selectedQueueIndex).toBeGreaterThan(0);
  });
  test("opens on Playback and reaches Library and YouTube Downloader while retaining tab-local input", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });

    expect(terminal.lastFrame()).toContain("▸ Player ◂");
    expect(terminal.lastFrame()).toContain("Library");
    expect(terminal.lastFrame()).toContain("Downloads");

    await terminal.stdin.write("]");
    await terminal.stdin.write("\t");
    await terminal.stdin.write("cached");
    expect(terminal.lastFrame()).toContain("▸ Library ◂");
    expect(terminal.lastFrame()).toContain("cached");

    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("]");
    await terminal.stdin.write("https://youtu.be/abc123");
    expect(terminal.lastFrame()).toContain("▸ Downloads ◂");
    expect(terminal.lastFrame()).toContain("https://youtu.be/abc123");

    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("[");
    expect(terminal.lastFrame()).toContain("cached");

    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("Library Shortcuts");
  });

  test("keeps core Playback queue actions available after provider narrowing", async () => {
    const first = cachedTrack("first", "First");
    const second = cachedTrack("second", "Second");
    const provider: Provider = {
      id: "youtube-cache",
      label: "YouTube Cache",
      listTracks: () => [first, second],
      searchTracks: () => [first, second],
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }),
      uiState: createInitialUiState(),
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });
    await coordinator.dispatch({ type: "playNext", target: first });
    await coordinator.dispatch({ type: "playNext", target: second });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });

    await terminal.stdin.write("\r");
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(second.identity);

    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("Playback Shortcuts");
    await terminal.stdin.write("\x1b");

    await terminal.stdin.write("]");
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("s");
    expect(coordinator.appState.playback.status).toBe("stopped");
    await terminal.stdin.write("[");

    await terminal.stdin.write("C");
    expect(terminal.lastFrame()).toContain("Clear Queue?");
    expect(terminal.lastFrame()).toContain("› Cancel ‹");
    await terminal.stdin.write("]");
    expect(coordinator.uiState.activeTab).toBe("playback");
    await terminal.stdin.write("\r");
    expect(coordinator.appState.queue.entries).toHaveLength(2);
    await terminal.stdin.write("C");
    await terminal.stdin.write("\t");
    expect(terminal.lastFrame()).toContain("› Clear ‹");
    await terminal.stdin.write("\x1b[D");
    expect(terminal.lastFrame()).toContain("› Cancel ‹");
    await terminal.stdin.write("\x1b[C");
    expect(terminal.lastFrame()).toContain("› Clear ‹");
    await terminal.stdin.write("\r");
    expect(coordinator.appState.queue.entries).toEqual([]);
    expect(terminal.lastFrame()).toContain("✓ SUCCESS");
    await sleep(2_600);
    expect(terminal.lastFrame()).not.toContain("✓ SUCCESS");

    await terminal.stdin.write("]");
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("a");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["first"]);
    expect(coordinator.appState.queue.currentIndex).toBe(-1);

    await terminal.stdin.write("j");
    await terminal.stdin.write("N");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["second", "first"]);
    expect(coordinator.appState.queue.currentIndex).toBe(-1);

    await terminal.stdin.write("\r");
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(second.identity);
  });

  test("renders the responsive Player Queue and complete selected cache metadata", async () => {
    const first = { ...cachedTrack("first", "First"), durationSeconds: 65 };
    const second = { ...cachedTrack("second", "Selected Song"), artist: "The Channel", durationSeconds: 245 };
    const provider: YouTubeCacheProvider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [first, second], searchTracks: () => [first, second],
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
      refresh: () => undefined, listCacheEntries: () => [], listIncompleteEntries: () => [],
      findByIdentity: (identity) => {
        const track = identity.stableId === "first" ? first : identity.stableId === "second" ? second : undefined;
        return track ? {
          track, availability: { status: "available" },
          metadata: { videoId: identity.stableId, title: track.title, uploader: track.artist ?? "The Channel",
            ...(track.durationSeconds === undefined ? {} : { durationSeconds: track.durationSeconds }),
            cachedAt: "2026-07-10T12:34:56.000Z", mediaFileName: `${identity.stableId}.opus`, container: "opus" },
          metadataPath: `/cache/${identity.stableId}.json`, mediaPath: `/cache/${identity.stableId}.opus`,
          mediaSizeBytes: identity.stableId === "second" ? 1_572_864 : 1024,
        } : undefined;
      },
      deleteCacheEntry: async () => false, cleanupIncompleteEntry: async () => false,
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player: new NoopPlayer(),
    });
    await coordinator.dispatch({ type: "addToQueue", target: first });
    await coordinator.dispatch({ type: "addToQueue", target: second });
    coordinator.dispatchUi({ type: "selectQueue", index: 1, identities: coordinator.queueTrackIdentities() });
    await coordinator.dispatch({ type: "playSelected", identity: first.identity });

    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 120, rows: 28 });
    let frame = terminal.lastFrame()!;
    expect(frame).toContain("Queue · 2 Tracks · 2/2");
    expect(frame).toContain("First · 1:05 · CURRENT");
    expect(frame).toContain("Selected Song · 4:05");
    expect(frame).toContain("Title: Selected Song");
    expect(frame).toContain("Channel: The Channel");
    expect(frame).toContain("Cached: 2026-07-10");
    expect(frame).toContain("Format: opus");
    expect(frame).toContain("Size: 1.5 MiB");
    expect(frame).toContain("Video ID: second");
    const wideQueueLine = frame.split("\n").findIndex((line) => line.includes("Queue ·"));
    const widePreviewLine = frame.split("\n").findIndex((line) => line.includes("Selected Track"));
    expect(widePreviewLine).toBe(wideQueueLine);

    await terminal.terminal.resize(100, 28);
    frame = terminal.lastFrame()!;
    const mediumTitleLine = frame.split("\n").find((line) => line.includes("Queue ·") && line.includes("Selected Track"))!;
    const borders = [...mediumTitleLine].flatMap((character, index) => character === "│" ? [index] : []);
    expect(borders).toHaveLength(4);
    expect((borders[1]! - borders[0]!) / (borders[3]! - borders[2]!)).toBeGreaterThan(1.6);
    expect((borders[1]! - borders[0]!) / (borders[3]! - borders[2]!)).toBeLessThan(2.2);

    await terminal.terminal.resize(80, 28);
    frame = terminal.lastFrame()!;
    expect(frame.split("\n").findIndex((line) => line.includes("Selected Track")))
      .toBeGreaterThan(frame.split("\n").findIndex((line) => line.includes("Selected Song · 4:05")));
  });

  test("keeps Queue selection independent while Player shortcuts edit exact visible order", async () => {
    const tracks = [cachedTrack("a", "A"), cachedTrack("b", "B"), cachedTrack("c", "C")];
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => tracks, searchTracks: () => tracks,
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({ appState: createInitialAppState({ "youtube-cache": provider }),
      uiState: createInitialUiState(), queue: new MemoryQueue(), player: new NoopPlayer() });
    for (const track of tracks) await coordinator.dispatch({ type: "addToQueue", target: track });
    await coordinator.dispatch({ type: "playSelected", identity: tracks[0]!.identity });
    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 100, rows: 24 });

    await terminal.stdin.write("j");
    expect(terminal.lastFrame()).toContain("› · B");
    expect(terminal.lastFrame()).toContain("▶ A");
    await terminal.stdin.write(" ");
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    await terminal.stdin.write("\r");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["A", "B", "C"]);
    expect(coordinator.appState.queue.currentIndex).toBe(1);
    await terminal.stdin.write("J");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["A", "C", "B"]);
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(tracks[1]!.identity);
    await terminal.stdin.write("K");
    await terminal.stdin.write("N");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["A", "B", "C"]);
    await terminal.stdin.write("x");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["A", "C"]);
    expect(coordinator.appState.queue.currentIndex).toBe(-1);
    expect(coordinator.appState.playback).toMatchObject({ status: "idle", currentTrackIdentity: null });
    await terminal.stdin.write(" ");
    expect(coordinator.appState.queue.currentIndex).toBe(-1);
    await terminal.stdin.write("C");
    expect(terminal.lastFrame()).toContain("Clear Queue?");
    await terminal.stdin.write("\r");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["A", "C"]);
  });

  test("Z visibly randomizes only the upcoming Queue", async () => {
    const tracks = [cachedTrack("a", "A"), cachedTrack("b", "B"), cachedTrack("c", "C"), cachedTrack("d", "D")];
    const coordinator = new AppCoordinator({ appState: createInitialAppState({}), uiState: createInitialUiState(),
      queue: new MemoryQueue({ random: () => 0 }), player: new NoopPlayer() });
    for (const track of tracks) await coordinator.dispatch({ type: "addToQueue", target: track });
    await coordinator.dispatch({ type: "playSelected", identity: tracks[0]!.identity });
    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 100, rows: 24 });

    await terminal.stdin.write("Z");

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual(["A", "C", "D", "B"]);
    expect(terminal.lastFrame()!.indexOf("· C")).toBeLessThan(terminal.lastFrame()!.indexOf("· B"));
    expect(terminal.lastFrame()).not.toContain("Shuffle");
  });

  test("Library unifies healthy and incomplete cache results with safe contextual actions", async () => {
    const track = cachedTrack("cached00001", "Cached");
    let deleted = false;
    let cleanedStem: string | undefined;
    const provider: YouTubeCacheProvider = {
      id: "youtube-cache", label: "YouTube Cache",
      listTracks: () => deleted ? [] : [track], searchTracks: () => deleted ? [] : [track],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/cached00001.opus" }),
      refresh: () => undefined,
      listCacheEntries: () => deleted ? [] : [{
        track, availability: { status: "available" },
        metadata: {
          videoId: "cached00001", title: "Cached", uploader: "Artist", durationSeconds: 125,
          cachedAt: "2026-01-02T00:00:00.000Z", mediaFileName: "cached00001.opus", container: "opus",
        }, metadataPath: "/cache/cached00001.json", mediaPath: "/cache/cached00001.opus", mediaSizeBytes: 2048,
      }],
      listIncompleteEntries: () => cleanedStem ? [] : [
        { stem: "broken00001", videoId: "actual00001", paths: ["/cache/broken00001.opus"], reason: "Cache media has no sidecar", title: "Broken First", uploader: "Channel B", durationSeconds: 61, cachedAt: "2026-01-03T00:00:00.000Z", mediaSizeBytes: 4096, container: "opus" },
        { stem: "broken00002", paths: ["/cache/broken00002.opus"], reason: "Cache media has no sidecar", cachedAt: "2026-01-01T00:00:00.000Z", mediaSizeBytes: 1024, container: "opus" },
      ],
      findByIdentity: () => deleted ? undefined : ({
        track, availability: { status: "available" },
        metadata: {
          videoId: "cached00001", title: "Cached", uploader: "Artist",
          cachedAt: "2026-01-01T00:00:00.000Z", mediaFileName: "cached00001.opus", container: "opus",
        }, metadataPath: "/cache/cached00001.json", mediaPath: "/cache/cached00001.opus",
      }),
      deleteCacheEntry: async () => { deleted = true; return true; },
      cleanupIncompleteEntry: async (stem) => { cleanedStem = stem; return true; },
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player: new NoopPlayer(),
    });
    await coordinator.dispatch({ type: "playNow", target: track });
    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 120, rows: 24 });
    await terminal.stdin.write("]");
    const initial = terminal.lastFrame()!;
    expect(initial.indexOf("Broken First")).toBeLessThan(initial.indexOf("Cached"));
    expect(initial).toContain("! Broken First · 1:01 · 4.0 KiB");
    expect(initial).toContain("✓ Cached · 2:05 · 2.0 KiB");
    expect(initial).not.toContain("Channel B ·");
    expect(initial).toContain("Health: Cache media has no sidecar");
    expect(initial).toContain("Video ID: actual00001");
    expect(initial).toContain("Channel: Channel B");
    expect(initial).toContain("d Clean · / Search");
    expect(initial).not.toContain("Enter Play · a Add");
    expect(initial.split("\n").find((line) => line.includes("Library ·"))).toContain("Incomplete Cache Entry");
    await terminal.terminal.resize(100, 24);
    await waitFor(() => coordinator.uiState.terminal.columns === 100);
    expect(coordinator.uiState.terminal.tier).toBe("medium");
    await terminal.stdin.write("a");
    expect(coordinator.appState.queue.entries).toHaveLength(1);
    await terminal.stdin.write("d");
    expect(terminal.lastFrame()).toContain("Clean incomplete entry “Broken First”?");
    await terminal.stdin.write("n");
    await terminal.stdin.write("j");
    await terminal.stdin.write("d");
    expect(terminal.lastFrame()).toContain("Permanently delete “Cached”?");
    expect(terminal.lastFrame()).toContain("current playback");
    expect(terminal.lastFrame()).toContain("will stop.");
    await terminal.stdin.write("y");
    expect(deleted).toBe(true);
    await terminal.stdin.write("/");
    await terminal.stdin.write("broken00002");
    expect(terminal.lastFrame()).toContain("broken00002");
    expect(terminal.lastFrame()).not.toContain("Broken First");
    await terminal.stdin.write("\r");
    expect(coordinator.uiState.library.inputFocused).toBe(false);
    await terminal.stdin.write("d");
    expect(terminal.lastFrame()).toContain("Clean incomplete entry “broken00002”?");
    await terminal.stdin.write("y");
    expect(cleanedStem).toBe("broken00002");
    expect(terminal.lastFrame()).toContain("No Cache Entries match your search.");
  });

  test("YouTube Downloader exposes pending removal, active cancellation, and session summaries", async () => {
    const { coordinator: base } = createTmuApp();
    const queue = new MemoryQueue();
    queue.enqueue(cachedTrack("already-queued", "Already Queued"));
    const queueBefore = queue.snapshot();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(base.appState.providers), uiState: createInitialUiState(),
      queue, player: new NoopPlayer(),
      prepareDownloadBatch: async (url) => ({
        kind: "ready", batch: { sourceUrl: url, kind: "single", entries: [{
          kind: "track", url,
          metadata: { extractor: "youtube", id: "One00000001", title: "First Track", uploader: "Artist" },
        }] },
      }),
      executeDownloadBatch: async (batch, options) => {
        if (batch.sourceUrl.endsWith("/one")) {
          options.onEntryStart?.(0, {
            kind: "track",
            url: batch.sourceUrl,
            metadata: { extractor: "youtube", id: "One00000001", title: "First Track", uploader: "Artist" },
          });
          options.onProgress?.(0, "[download]  42.5% of 3.00MiB at 1.00MiB/s");
          await waitFor(() => options.signal?.aborted === true);
          return { downloaded: 0, alreadyCached: 0, failed: 0, cancelled: 1, failures: [] };
        }
        return { downloaded: 1, alreadyCached: 0, failed: 0, cancelled: 0, failures: [] };
      },
    });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });
    await terminal.stdin.write("]");
    await terminal.stdin.write("]");
    await terminal.stdin.write("https://youtu.be/one");
    await terminal.stdin.write("\r");
    await waitFor(() => coordinator.appState.downloads.activeBatch?.progressPercent === 42.5);
    expect(terminal.lastFrame()).toContain("ACTIVE #1 · 1/1");
    expect(terminal.lastFrame()).toContain("43%");
    expect(coordinator.uiState.downloader.urlInput).toBe("");

    await terminal.stdin.write("https://youtu.be/two");
    await terminal.stdin.write("\r");
    await waitFor(() => coordinator.appState.downloads.pendingBatches.length === 1);
    expect(terminal.lastFrame()).toContain("PENDING #2 · 1 item · https://youtu.be/two");
    await terminal.stdin.write("https://youtu.be/three");
    await terminal.stdin.write("\r");
    await waitFor(() => coordinator.appState.downloads.pendingBatches.length === 2);
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("q");
    expect(terminal.lastFrame()).toContain("Quit TMU?");
    expect(terminal.lastFrame()).toContain("Active and pending download work will be cancelled.");
    await terminal.stdin.write("n");
    expect(coordinator.appState.downloads.pendingBatches).toHaveLength(2);
    expect(terminal.lastFrame()).toContain("! WARNING");
    await terminal.stdin.write("\x1b");
    expect(terminal.lastFrame()).not.toContain("! WARNING");
    await terminal.stdin.write("j");
    await terminal.stdin.write("x");
    expect(terminal.lastFrame()).toContain("Remove pending Download Batch #2");
    await terminal.stdin.write("y");
    expect(coordinator.appState.downloads.pendingBatches.map((batch) => batch.id)).toEqual([3]);
    await terminal.stdin.write("x");
    await terminal.stdin.write("y");
    expect(coordinator.appState.downloads.pendingBatches).toEqual([]);
    expect(coordinator.uiState.downloader.selectedBatchIndex).toBe(0);

    await terminal.stdin.write("g");
    await terminal.stdin.write("g");
    await terminal.stdin.write("x");
    expect(terminal.lastFrame()).toContain("Cancel Download Batch #1");
    await terminal.stdin.write("y");
    await waitFor(() => coordinator.appState.downloads.summaries.length === 1);
    expect(terminal.lastFrame()).toContain("COMPLETED #1 · 0 downloaded · 0 cached · 0 failed · 1 cancelled");
    expect(coordinator.appState.queue).toEqual(queueBefore);
  });

  test("Download Pipeline shows selected failure detail, position, empty guidance, and preserves input focus cycling", async () => {
    const appState = createInitialAppState({});
    appState.downloads.summaries = [{
      id: 9,
      sourceUrl: "https://youtube.com/watch?v=a-url-that-is-deliberately-long-enough-to-truncate-before-the-status-columns",
      downloaded: 1,
      alreadyCached: 0,
      failed: 1,
      cancelled: 0,
      failures: [{ index: 1, title: "Unavailable Track", message: "Video unavailable" }],
    }];
    const uiState = createInitialUiState();
    uiState.activeTab = "downloader";
    const coordinator = new AppCoordinator({ appState, uiState, queue: new MemoryQueue(), player: new NoopPlayer() });
    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 90, rows: 24 });

    expect(terminal.lastFrame()).toContain("Pipeline · 1 batch · 1/1");
    expect(terminal.lastFrame()).toContain("COMPLETED #9 · 1 downloaded · 0 cached · 1 failed · 0 cancelled");
    expect(terminal.lastFrame()).not.toContain(appState.downloads.summaries[0]!.sourceUrl);
    expect(terminal.lastFrame()).not.toContain("Video unavailable");
    await terminal.stdin.write("\t");
    expect(coordinator.uiState.downloader.inputFocused).toBe(false);
    expect(terminal.lastFrame()).toContain("Failure: Unavailable Track — Video unavailable");
    await terminal.stdin.write("x");
    expect(coordinator.uiState.pendingConfirmation).toBeNull();
    await terminal.stdin.write("c");
    expect(coordinator.uiState.pendingConfirmation).toBeNull();
    await terminal.stdin.write("\t");
    expect(coordinator.uiState.downloader.inputFocused).toBe(true);
  });

  test("Download Pipeline empty state guides URL submission and Shift+Tab focuses the Pipeline", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 90, rows: 24 });
    await terminal.stdin.write("]");
    await terminal.stdin.write("]");
    expect(terminal.lastFrame()).toContain("Pipeline · 0 batches · 0/0");
    expect(terminal.lastFrame()).toContain("Paste a YouTube URL above to begin.");
    await terminal.stdin.write("\x1b[Z");
    expect(coordinator.uiState.downloader.inputFocused).toBe(false);
  });

  test("Download Pipeline preserves active progress and pending counts beside long URLs at narrow width", async () => {
    const appState = createInitialAppState({});
    const longUrl = "https://youtube.com/watch?v=a-url-that-would-otherwise-consume-the-whole-row";
    appState.downloads.activeBatch = {
      id: 4, sourceUrl: longUrl, kind: "playlist", itemCount: 12, progressPercent: 67,
      activeTrack: { index: 3, title: "A Track With A Very Long Display Title" },
    };
    appState.downloads.active = true;
    appState.downloads.pendingBatches = [{ id: 5, sourceUrl: longUrl, kind: "playlist", itemCount: 24 }];
    const uiState = createInitialUiState();
    uiState.activeTab = "downloader";
    uiState.downloader.inputFocused = false;
    const coordinator = new AppCoordinator({ appState, uiState, queue: new MemoryQueue(), player: new NoopPlayer() });
    const terminal = await render(createTmuRoot({ coordinator, noColor: true }), { columns: 60, rows: 20 });

    expect(terminal.lastFrame()).toContain("ACTIVE #4 · 4/12 · [███████░░░] 67%");
    expect(terminal.lastFrame()).toContain("PENDING #5 · 24 items");
    expect(terminal.lastFrame()).not.toContain(longUrl);
  });

  test("YouTube Downloader confirms playlists and clears input only after acceptance", async () => {
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [], searchTracks: () => [],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/unused" }),
    };
    const url = "https://youtube.com/playlist?list=PL1";
    const batch = { sourceUrl: url, kind: "playlist" as const, entries: [] };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player: new NoopPlayer(),
      prepareDownloadBatch: async (input) => input.includes("invalid")
        ? { kind: "rejected", message: "YouTube Downloader rejects non-YouTube URLs" }
        : {
            kind: "confirmation-required", confirmation: { title: "Road Trip", itemCount: 12 },
            confirm: () => batch, cancel: () => ({ kind: "cancelled" }),
          },
      executeDownloadBatch: async () => ({
        downloaded: 2, alreadyCached: 1, failed: 0, cancelled: 0, failures: [],
      }),
    });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });
    await terminal.stdin.write("]");
    await terminal.stdin.write("]");
    const invalidUrl = "https://example.com/invalid";
    await terminal.stdin.write(invalidUrl);
    await terminal.stdin.write("\r");
    await waitFor(() => coordinator.appState.lastEvent.includes("rejects"));
    expect(coordinator.uiState.downloader.urlInput).toBe(invalidUrl);
    coordinator.dispatchUi({ type: "setDownloaderInput", value: "" });
    await terminal.stdin.write(url);
    await terminal.stdin.write("\r");
    await waitFor(() => coordinator.appState.downloads.confirmation !== undefined);
    expect(terminal.lastFrame()).toContain("Accept playlist “Road Trip”?");
    await terminal.stdin.write("n");
    expect(coordinator.uiState.downloader.urlInput).toBe(url);

    await terminal.stdin.write("\r");
    await waitFor(() => coordinator.appState.downloads.confirmation !== undefined);
    await terminal.stdin.write("y");
    await waitFor(() => coordinator.appState.downloads.summaries.length === 1);
    expect(coordinator.uiState.downloader.urlInput).toBe("");
    expect(terminal.lastFrame()).toContain("COMPLETED #3 · 2 downloaded · 1 cached · 0 failed · 0 cancelled");
  });

  test("Playback keeps unavailable Tracks visible with their reason", async () => {
    const track = cachedTrack("broken-track", "Broken Track");
    const queue = new MemoryQueue();
    queue.enqueue(track);
    queue.markAvailability(track.identity, { status: "unavailable", reason: "mpv playback failed: corrupt stream" });
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [], searchTracks: () => [],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/unused" }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      queue, player: new NoopPlayer(),
    });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });
    expect(terminal.lastFrame()).toContain("! Broken Track · —:—");
    expect(terminal.lastFrame()).toContain("Unavailable: mpv playback");
    expect(terminal.lastFrame()).toContain("failed: corrupt stream");
  });

  test("Library Cache Search finds a cached Track and places it in Queue", async () => {
    const first = cachedTrack("first", "First Track");
    const second = cachedTrack("second", "Second Track");
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [first, second],
      searchTracks: (query) => [first, second].filter((track) => track.title.toLowerCase().includes(query.toLowerCase())),
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player: new NoopPlayer(),
    });
    const terminal = await render(createTmuRoot({ coordinator }), { columns: 100, rows: 24 });
    await terminal.stdin.write("]");
    await terminal.stdin.write("\t");
    await terminal.stdin.write("second");
    expect(terminal.lastFrame()).toContain("› ✓ Second Track");
    expect(terminal.lastFrame()).not.toContain("✓ First Track");
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("a");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.identity.stableId)).toEqual(["second"]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await sleep(1);
  }
  throw new Error("timed out waiting for TUI state");
}

function cachedTrack(stableId: string, title: string): Track {
  return {
    identity: { providerId: "youtube-cache", stableId },
    title,
    providerLabel: "YouTube Cache",
  };
}

class PublishingPlayer extends NoopPlayer {
  publish(state: PlayerPlaybackState): void {
    this.updateState(state);
  }

  override async seekBy(seconds: number): Promise<PlayerPlaybackState> {
    this.publish({ ...this.playback, positionSeconds: (this.playback.positionSeconds ?? 0) + seconds });
    return this.playback;
  }
}
