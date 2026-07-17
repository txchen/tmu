import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@vue-tui/testing";
import { createTmuApp } from "../src/app";
import { AppCoordinator } from "../src/coordinator";
import type { PlayerPlaybackState, Provider, Track } from "../src/domain";
import { NoopPlayer } from "../src/player";
import { InMemoryLastPlaylistSnapshotPersistence } from "../src/playlist-snapshot";
import { MemoryPlaylistContent } from "../src/playlist-content";
import { createInitialAppState, createInitialUiState } from "../src/state";
import { StatePublicationGate } from "../src/state-publication";
import { createTmuRoot } from "../src/vue-tui/component";
import type { YouTubeCacheProvider } from "../src/youtube-cache";

afterEach(() => cleanup());

class StopCountingPlayer extends NoopPlayer {
  stopCount = 0;

  override async stop(): Promise<PlayerPlaybackState> {
    this.stopCount += 1;
    return super.stop();
  }
}

describe("TMU top-level surface smoke", () => {
  test("keeps an unexpectedly disconnected client mounted with shared actions disabled", async () => {
    const { coordinator } = createTmuApp();
    let loseConnection!: (message: string) => void;
    Object.assign(coordinator, { quitIsClientOnly: true, onConnectionLost: (listener: (message: string) => void) => {
      loseConnection = listener; return () => undefined;
    } });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 100, rows: 24 });
    loseConnection("lost"); await sleep(0);
    expect(terminal.lastFrame()).toContain("TMU Daemon connection lost");
    expect(terminal.lastFrame()).toContain("will not reconnect or restart");
    const before = coordinator.appState.volume.percent;
    await terminal.stdin.write("-"); await sleep(0);
    expect(coordinator.appState.volume.percent).toBe(before);
  });

  test("shows and lazily initializes the candidate Background Sounds Tab with contained retry", async () => {
    const snapshot = {
      enabled: true,
      sound: { id: "Rain", label: "Rain" },
      sounds: [{ id: "Rain", label: "Rain" }, { id: "Ocean", label: "Ocean" }],
      volumePercent: 60,
    } as const;
    let fail = true;
    const control = {
      probe: async () => {
        if (fail) throw new Error("Open System Settings and retry");
        return snapshot;
      },
      read: async () => snapshot,
      setEnabled: async () => snapshot, setSound: async () => snapshot, setVolume: async () => snapshot,
    };
    const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 100, rows: 24 });

    expect(terminal.lastFrame()).toContain("Background");
    expect(coordinator.appState.backgroundSounds.status).toBe("candidate");
    await terminal.stdin.write("]");
    await terminal.stdin.write("]");
    await terminal.stdin.write("]");
    await sleep(0);
    expect(coordinator.uiState.activeTab).toBe("background");
    expect(terminal.lastFrame()).toContain("Open System Settings and retry");
    fail = false;
    await terminal.stdin.write("u");
    await sleep(0);
    expect(terminal.lastFrame()).toContain("Background Sounds   ● On");
    expect(terminal.lastFrame()).toContain("Sound               Rain · Press Enter to choose");
    expect(terminal.lastFrame()).toContain("60%");
    expect(terminal.lastFrame()).toContain("Confirmed from macOS");
    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("Background Sounds Shortcuts");
    expect(terminal.lastFrame()).toContain("Refresh or retry macOS");
    expect(terminal.lastFrame()).toContain("←/→");
    expect(terminal.lastFrame()).toContain("Open sound picker");
    expect(terminal.lastFrame()).toContain("h/l");
    expect(terminal.lastFrame()).not.toContain("h/l, ←/→");
    expect(terminal.lastFrame()).toContain("+/−");
    expect(terminal.lastFrame()).toContain("Repeat All");
    await terminal.stdin.write("?");
    await terminal.stdin.write("]");
    expect(coordinator.uiState.activeTab).toBe("playback");
    await terminal.stdin.write("[");
    await sleep(0);
    expect(coordinator.uiState.activeTab).toBe("background");
  });

  test.each([
    [120, 30],
    [80, 24],
    [60, 20],
  ])("keeps the candidate Background Settings list usable at %sx%s", async (columns, rows) => {
    const snapshot = {
      enabled: false,
      sound: { id: "Rain", label: "Rain" },
      sounds: [{ id: "Rain", label: "Rain" }],
      volumePercent: 45,
    } as const;
    const control = {
      probe: async () => snapshot, read: async () => snapshot,
      setEnabled: async () => snapshot, setSound: async () => snapshot, setVolume: async () => snapshot,
    };
    const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });
    coordinator.dispatchUi({ type: "switchTab", tab: "background" });
    await coordinator.enterBackgroundSounds();

    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns, rows });
    const frame = terminal.lastFrame()!;
    expect(frame).toContain("Background Sounds · macOS");
    expect(frame).toContain("Background Sounds   ○ Off");
    expect(frame).toContain("Sound               Rain · Press Enter to choose");
    expect(frame).toContain("Confirmed from macOS");
    expect(frame.split("\n").every((line) => Array.from(line).length <= columns)).toBe(true);
  });

  test.each([[120, 30], [80, 24]])("shows all 16 Background Sounds in one column at %sx%s", async (columns, rows) => {
    const sounds = Array.from({ length: 16 }, (_, index) => ({ id: `sound-${index + 1}`, label: `Sound ${index + 1}` }));
    let snapshot = { enabled: false, sound: sounds[6]!, sounds, volumePercent: 45 };
    const writes: string[] = [];
    const control = {
      probe: async () => snapshot, read: async () => snapshot,
      setEnabled: async () => snapshot,
      setSound: async (id: string) => {
        writes.push(id);
        snapshot = { ...snapshot, sound: sounds.find((sound) => sound.id === id)! };
        return snapshot;
      },
      setVolume: async () => snapshot,
    };
    const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });
    coordinator.dispatchUi({ type: "switchTab", tab: "background" });
    await coordinator.enterBackgroundSounds();
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns, rows });

    await terminal.stdin.write("j");
    await terminal.stdin.write("\r");
    expect(terminal.lastFrame()).toContain("Choose Background Sound");
    expect(terminal.lastFrame()).toContain("Sound 1");
    expect(terminal.lastFrame()).toContain("Sound 7");
    expect(terminal.lastFrame()).toContain("Sound 16");
    expect(terminal.lastFrame()!.split("\n").every((line) => (line.match(/Sound \d+/g) ?? []).length <= 1)).toBe(true);
    await terminal.stdin.write("G");
    expect(terminal.lastFrame()).toContain("Sound 16");
    expect(terminal.lastFrame()!.split("\n").every((line) => Array.from(line).length <= columns)).toBe(true);
    await terminal.stdin.write("\r");

    expect(writes).toEqual(["sound-16"]);
    expect(terminal.lastFrame()).toContain("Sound 16 · Press Enter to choose");
  });

  test("scrolls the one-column picker when terminal height cannot show all 16 sounds", async () => {
    const sounds = Array.from({ length: 16 }, (_, index) => ({ id: `sound-${index + 1}`, label: `Sound ${index + 1}` }));
    let snapshot = { enabled: false, sound: sounds[0]!, sounds, volumePercent: 45 };
    const writes: string[] = [];
    const control = {
      probe: async () => snapshot, read: async () => snapshot,
      setEnabled: async () => snapshot,
      setSound: async (id: string) => {
        writes.push(id);
        snapshot = { ...snapshot, sound: sounds.find((sound) => sound.id === id)! };
        return snapshot;
      },
      setVolume: async () => snapshot,
    };
    const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });
    coordinator.dispatchUi({ type: "switchTab", tab: "background" });
    await coordinator.enterBackgroundSounds();
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 60, rows: 16 });

    await terminal.stdin.write("j");
    await terminal.stdin.write("\r");
    const frame = terminal.lastFrame()!;
    expect(frame).toContain("Sound 1");
    expect(frame).not.toContain("Sound 16");
    expect(frame.split("\n").every((line) => (line.match(/Sound \d+/g) ?? []).length <= 1)).toBe(true);
    expect(frame.split("\n").every((line) => Array.from(line).length <= 60)).toBe(true);
    await terminal.stdin.write("G");
    expect(terminal.lastFrame()).toContain("Sound 16");
    expect(terminal.lastFrame()).not.toContain("Sound 1 ");
    await terminal.terminal.resize(80, 24);
    expect(terminal.lastFrame()).toContain("Sound 1 ");
    expect(terminal.lastFrame()).toContain("Sound 16");
    await terminal.terminal.resize(60, 16);
    expect(terminal.lastFrame()).not.toContain("Sound 1 ");
    expect(terminal.lastFrame()).toContain("Sound 16");
    await terminal.stdin.write("\r");
    expect(writes).toEqual(["sound-16"]);
  });

  test("controls Background Sound settings with focused keys and authoritative confirmation", async () => {
    let snapshot = {
      enabled: false,
      sound: { id: "Rain", label: "Rain" },
      sounds: [{ id: "Rain", label: "Rain" }, { id: "Ocean", label: "Ocean" }],
      volumePercent: 45,
    };
    const writes: string[] = [];
    let reads = 0;
    const control = {
      probe: async () => snapshot,
      read: async () => { reads += 1; return snapshot; },
      setEnabled: async (enabled: boolean) => (writes.push(`enabled:${enabled}`), snapshot = { ...snapshot, enabled }),
      setSound: async (id: string) => (writes.push(`sound:${id}`), snapshot = { ...snapshot, sound: snapshot.sounds.find((sound) => sound.id === id)! }),
      setVolume: async (volumePercent: number) => (writes.push(`volume:${volumePercent}`), snapshot = { ...snapshot, volumePercent }),
    };
    const { coordinator } = createTmuApp({ backgroundSoundsCandidate: true, backgroundSoundsControl: control });
    coordinator.dispatchUi({ type: "switchTab", tab: "background" });
    await coordinator.enterBackgroundSounds();
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 100, rows: 24 });

    expect(terminal.lastFrame()).toContain("Enter Activate/Deactivate");
    await terminal.stdin.write("\x1b[C");
    expect(writes).toEqual([]);
    await terminal.stdin.write("\r");
    await terminal.stdin.write("j");
    await terminal.stdin.write("\x1b[C");
    expect(writes).toEqual(["enabled:true"]);
    await terminal.stdin.write("\r");
    expect(terminal.lastFrame()).toContain("Choose Background Sound");
    expect(terminal.lastFrame()).toContain("Missing sounds? macOS Settings download · Esc then u refresh");
    expect(terminal.lastFrame()).toContain("Rain");
    expect(terminal.lastFrame()).toContain("Ocean");
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("u");
    await sleep(0);
    expect(reads).toBe(1);
    await terminal.stdin.write("\r");
    await terminal.stdin.write("\x1b[B");
    await terminal.stdin.write("\r");
    expect(writes).toEqual(["enabled:true", "sound:Ocean"]);
    await terminal.stdin.write("j");
    expect(terminal.lastFrame()).toContain("←/→ Adjust Volume");
    expect(terminal.lastFrame()).not.toContain("Enter Activate");
    await terminal.stdin.write("\x1b[C");
    expect(terminal.lastFrame()).toContain("45% → 50% pending");
    await sleep(175);

    expect(writes).toEqual(["enabled:true", "sound:Ocean", "volume:50"]);
    expect(terminal.lastFrame()).toContain("● On");
    expect(terminal.lastFrame()).toContain("Ocean · Press Enter to choose");
    expect(terminal.lastFrame()).toContain("50%");
    expect(coordinator.uiState.background.selectedRow).toBe(2);
    await terminal.stdin.write("k");
    await terminal.stdin.write("\x1b[A");
    expect(coordinator.uiState.background.selectedRow).toBe(0);
    await terminal.stdin.write("\x1b[D");
    expect(writes.at(-1)).toBe("volume:50");
    await terminal.stdin.write("\r");
    expect(writes.at(-1)).toBe("enabled:false");

    await terminal.stdin.write("j");
    await terminal.stdin.write("\r");
    expect(terminal.lastFrame()).toContain("Choose Background Sound");
    await terminal.stdin.write("\x1b");
    expect(terminal.lastFrame()).not.toContain("Choose Background Sound");
    expect(writes).toEqual(["enabled:true", "sound:Ocean", "volume:50", "enabled:false"]);
  });
  test("requests descriptive Playlist deletion, cancels safely, and protects the sole Playlist", async () => {
    const player = new StopCountingPlayer();
    const { coordinator } = createTmuApp({ player });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });

    await terminal.stdin.write("P");
    await terminal.stdin.write("x");
    expect(terminal.lastFrame()).toContain("cannot delete the sole remaining Playlist");
    expect(coordinator.appState.playlists.playlists).toHaveLength(1);

    await terminal.stdin.write("c");
    await terminal.stdin.write("Road");
    await terminal.stdin.write("\r");
    await terminal.stdin.write("P");
    await terminal.stdin.write("x");
    expect(terminal.lastFrame()).toContain("Delete Playlist “Road”?");
    expect(terminal.lastFrame()).toContain("0 Tracks");
    await terminal.stdin.write("\x1b");

    expect(coordinator.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Default", "Road"]);
    expect(coordinator.appState.playlists.playlists[1]?.id).toBe(coordinator.appState.playlists.activePlaylistId);
    expect(player.stopCount).toBe(1);
  });

  test("deletes inactive and Active Playlists with deterministic selection and restart restoration", async () => {
    const persistence = new InMemoryLastPlaylistSnapshotPersistence();
    const player = new StopCountingPlayer();
    const first = createTmuApp({ player, playlistSnapshotPersistence: persistence });
    await first.coordinator.start();
    const defaultId = first.coordinator.appState.playlists.activePlaylistId;
    await first.coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack("shared", "Shared") });
    await first.coordinator.dispatch({ type: "createPlaylist", name: "Middle" });
    await first.coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack("middle", "Middle Track") });
    const middleId = first.coordinator.appState.playlists.activePlaylistId;
    await first.coordinator.dispatch({ type: "createPlaylist", name: "Last" });
    await first.coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack("shared", "Shared") });
    const lastId = first.coordinator.appState.playlists.activePlaylistId;
    const terminal = await render(createTmuRoot({ client: first.coordinator, noColor: true }), { columns: 80, rows: 24 });

    await terminal.stdin.write("P");
    await terminal.stdin.write("g");
    await terminal.stdin.write("g");
    const stopsBeforeInactiveDelete = player.stopCount;
    await terminal.stdin.write("x");
    await terminal.stdin.write("y");
    expect(first.coordinator.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Middle", "Last"]);
    expect(first.coordinator.appState.playlists.activePlaylistId).toBe(lastId);
    expect(player.stopCount).toBe(stopsBeforeInactiveDelete);
    expect(first.coordinator.uiState.playlistManager).toMatchObject({ selectedIndex: 0 });
    expect(first.coordinator.appState.playlists.playlists[0]?.entries.map((entry) => entry.track.title)).toEqual(["Middle Track"]);
    expect(first.coordinator.appState.playlists.playlists[1]?.entries.map((entry) => entry.track.title)).toEqual(["Shared"]);

    await terminal.stdin.write("\r");
    await terminal.stdin.write("P");
    const stopsBeforeActiveDelete = player.stopCount;
    await terminal.stdin.write("x");
    await terminal.stdin.write("y");
    expect(first.coordinator.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Last"]);
    expect(first.coordinator.appState.playlists.activePlaylistId).toBe(lastId);
    expect(first.coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.title)).toEqual(["Shared"]);
    expect(first.coordinator.uiState.playlistManager).toMatchObject({ selectedIndex: 0, mode: "browse" });
    expect(player.stopCount).toBe(stopsBeforeActiveDelete + 1);

    const restoredPlayer = new StopCountingPlayer();
    const restored = createTmuApp({ player: restoredPlayer, playlistSnapshotPersistence: persistence });
    await restored.coordinator.start();
    expect(restored.coordinator.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Last"]);
    expect(restored.coordinator.appState.playlists.activePlaylistId).toBe(lastId);
    expect(restored.coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.identity.stableId)).toEqual(["shared"]);
    expect(restored.coordinator.appState.playback.status).not.toBe("playing");
    expect(restoredPlayer.stopCount).toBe(0);
    expect(defaultId).not.toBe(middleId);
  });

  test("deleting the last Active Playlist falls back to the previous row", async () => {
    const player = new StopCountingPlayer();
    const { coordinator } = createTmuApp({ player });
    const previousId = coordinator.appState.playlists.activePlaylistId;
    await coordinator.dispatch({ type: "createPlaylist", name: "Last" });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });

    await terminal.stdin.write("P");
    await terminal.stdin.write("x");
    await terminal.stdin.write("y");

    expect(coordinator.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Default"]);
    expect(coordinator.appState.playlists.activePlaylistId).toBe(previousId);
    expect(coordinator.uiState.playlistManager).toMatchObject({ selectedIndex: 0, mode: "browse" });
  });

  test("deleting an Active middle row activates the next Playlist", async () => {
    const player = new StopCountingPlayer();
    const { coordinator } = createTmuApp({ player });
    await coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack("default", "Default Track") });
    await coordinator.dispatch({ type: "createPlaylist", name: "Middle" });
    await coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack("middle", "Middle Track") });
    await coordinator.dispatch({ type: "createPlaylist", name: "Last" });
    await coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack("last", "Last Track") });
    const middleId = coordinator.appState.playlists.playlists[1]!.id;
    const lastId = coordinator.appState.playlists.playlists[2]!.id;
    await coordinator.dispatch({ type: "switchPlaylist", playlistId: middleId });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });

    await terminal.stdin.write("P");
    await terminal.stdin.write("x");
    await terminal.stdin.write("y");

    expect(coordinator.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Default", "Last"]);
    expect(coordinator.appState.playlists.activePlaylistId).toBe(lastId);
    expect(coordinator.appState.playlists.playlists[0]?.entries.map((entry) => entry.track.title)).toEqual(["Default Track"]);
    expect(coordinator.appState.playlists.playlists[1]?.entries.map((entry) => entry.track.title)).toEqual(["Last Track"]);
    expect(coordinator.uiState.playlistManager).toMatchObject({ selectedIndex: 1, mode: "browse" });
  });

  test("Playlist deletion never invokes YouTube Cache deletion", async () => {
    let cacheDeletionCalls = 0;
    const track = cachedTrack("kept-in-cache", "Kept in Cache");
    const provider: YouTubeCacheProvider = {
      id: "youtube-cache", label: "YouTube Cache",
      listTracks: () => [track], searchTracks: () => [track],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/kept-in-cache.opus" }),
      refresh: () => undefined, listCacheEntries: () => [], listIncompleteEntries: () => [],
      findByIdentity: () => ({
        track, availability: { status: "available" },
        metadata: { videoId: "kept-in-cache", title: track.title, uploader: "Cache Artist", cachedAt: "2026-07-12T00:00:00.000Z", mediaFileName: "kept-in-cache.opus", container: "opus" },
        metadataPath: "/cache/kept-in-cache.json", mediaPath: "/cache/kept-in-cache.opus",
      }),
      renameTrack: async () => track,
      deleteCacheEntry: async () => { cacheDeletionCalls += 1; return true; },
      cleanupIncompleteEntry: async () => false,
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer(),
    });
    await coordinator.dispatch({ type: "createPlaylist", name: "Disposable" });
    await coordinator.dispatch({ type: "addToPlaylist", target: track });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });

    await terminal.stdin.write("P");
    await terminal.stdin.write("x");
    await terminal.stdin.write("y");

    expect(cacheDeletionCalls).toBe(0);
    expect(provider.listTracks()).toEqual([track]);
  });

  test("renames the selected Playlist through modal text capture and keeps it selected", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });

    await terminal.stdin.write("P");
    await terminal.stdin.write("e");
    expect(terminal.lastFrame()).toContain("Rename Playlist");
    await terminal.stdin.write("\x7f\x7f\x7f\x7f\x7f\x7f\x7f");
    await terminal.stdin.write("p?Focus");
    await terminal.stdin.write("\r");

    expect(coordinator.appState.playlists.playlists[0]?.name).toBe("p?Focus");
    expect(coordinator.appState.playback.currentTrackIdentity).toBeNull();
    expect(coordinator.uiState.playlistManager).toMatchObject({ mode: "browse", selectedIndex: 0 });
    expect(terminal.lastFrame()).toContain("› * p?Focus · 0");
  });

  test("keeps invalid Playlist names editable with actionable errors", async () => {
    const { coordinator } = createTmuApp();
    await coordinator.dispatch({ type: "createPlaylist", name: "Study" });
    const initialPlaylistId = coordinator.appState.playlists.playlists[0]!.id;
    await coordinator.dispatch({ type: "switchPlaylist", playlistId: initialPlaylistId });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });

    await terminal.stdin.write("P");
    await terminal.stdin.write("e");
    await terminal.stdin.write("\x7f\x7f\x7f\x7f\x7f\x7f\x7f");
    await terminal.stdin.write("   ");
    await terminal.stdin.write("\r");
    expect(coordinator.uiState.playlistManager).toMatchObject({ mode: "rename", error: "Playlist name cannot be empty" });
    expect(terminal.lastFrame()).toContain("Error: Playlist name cannot be empty");

    await terminal.stdin.write("\x7f\x7f\x7f");
    await terminal.stdin.write("sTuDy");
    await terminal.stdin.write("\r");
    expect(coordinator.uiState.playlistManager?.error).toContain("already in use");
    await terminal.stdin.write("\x7f\x7f\x7f\x7f\x7f");
    await terminal.stdin.write("界界界界界界界界界界界界界界界界界");
    await terminal.stdin.write("\r");
    expect(coordinator.uiState.playlistManager?.error).toContain("at most 16");
    await terminal.stdin.write("\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f");
    await terminal.stdin.write("界界界界界界界界界界界界界界界界");
    await terminal.stdin.write("\r");
    expect(coordinator.appState.playlists.playlists[0]?.name).toBe("界界界界界界界界界界界界界界界界");
    expect(coordinator.uiState.playlistManager?.mode).toBe("browse");
  });

  test("reorders Playlists at boundaries, restores order, and reopens on the Active Playlist", async () => {
    const persistence = new InMemoryLastPlaylistSnapshotPersistence();
    const player = new StopCountingPlayer();
    const first = createTmuApp({ playlistSnapshotPersistence: persistence, player });
    await first.coordinator.start();
    await first.coordinator.dispatch({ type: "createPlaylist", name: "Study" });
    await first.coordinator.dispatch({ type: "createPlaylist", name: "Road" });
    const activeId = first.coordinator.appState.playlists.activePlaylistId;
    const stopCountBeforeReorder = player.stopCount;
    const terminal = await render(createTmuRoot({ client: first.coordinator, noColor: true }), { columns: 80, rows: 24 });

    await terminal.stdin.write("P");
    await terminal.stdin.write("K");
    await terminal.stdin.write("K");
    await terminal.stdin.write("K");
    expect(first.coordinator.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Road", "Default", "Study"]);
    expect(first.coordinator.uiState.playlistManager).toMatchObject({ selectedIndex: 0 });
    await terminal.stdin.write("J");
    await terminal.stdin.write("J");
    await terminal.stdin.write("J");
    expect(first.coordinator.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Default", "Study", "Road"]);
    expect(first.coordinator.uiState.playlistManager).toMatchObject({ selectedIndex: 2 });
    expect(first.coordinator.appState.playlists.activePlaylistId).toBe(activeId);
    expect(player.stopCount).toBe(stopCountBeforeReorder);
    await terminal.stdin.write("\x1b");

    const restored = createTmuApp({ playlistSnapshotPersistence: persistence });
    await restored.coordinator.start();
    expect(restored.coordinator.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Default", "Study", "Road"]);
    const restoredTerminal = await render(createTmuRoot({ client: restored.coordinator, noColor: true }), { columns: 80, rows: 24 });
    await restoredTerminal.stdin.write("P");
    expect(restored.coordinator.uiState.playlistManager).toMatchObject({ selectedIndex: 2 });
    expect(restoredTerminal.lastFrame()).toContain("› * Road · 0");
  });

  test("reopening Playlist Manager discards prior selection and scroll to reveal the Active Playlist", async () => {
    const { coordinator } = createTmuApp();
    for (let index = 1; index <= 11; index += 1) {
      await coordinator.dispatch({ type: "createPlaylist", name: `List ${index}` });
    }
    const initialPlaylistId = coordinator.appState.playlists.playlists[0]!.id;
    await coordinator.dispatch({ type: "switchPlaylist", playlistId: initialPlaylistId });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });

    await terminal.stdin.write("P");
    await terminal.stdin.write("G");
    expect(coordinator.uiState.playlistManager).toMatchObject({ selectedIndex: 11, scroll: 2 });
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("P");

    expect(coordinator.uiState.playlistManager).toMatchObject({ selectedIndex: 0, scroll: 0 });
    expect(terminal.lastFrame()).toContain("› * Default · 0");
  });

  test("opens Playlist Manager globally, captures create input, and shows the Active Playlist on every tab", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });
    for (const tab of ["playback", "library", "downloader"] as const) {
      coordinator.dispatchUi({ type: "switchTab", tab });
      if (tab === "downloader") coordinator.dispatchUi({ type: "setDownloaderInputFocus", focused: false });
      await terminal.stdin.write("P");
      expect(terminal.lastFrame()).toContain("Playlist Manager");
      expect(terminal.lastFrame()).toContain("› * Default · 0");
      await terminal.stdin.write("\x1b");
    }

    await terminal.stdin.write("P");
    await terminal.stdin.write("c");
    await terminal.stdin.write("p?Study");
    expect(coordinator.appState.playback.currentTrackIdentity).toBeNull();
    expect(terminal.lastFrame()).toContain("Name: p?Study");
    await terminal.stdin.write("\r");

    expect(coordinator.appState.playlists.playlists.map((playlist) => playlist.name)).toEqual(["Default", "p?Study"]);
    expect(coordinator.appState.playlists.activePlaylistId).toBe(coordinator.appState.playlists.playlists[1]!.id);
    expect(coordinator.uiState.playlistManager).toBeNull();
    expect(terminal.lastFrame()).toContain("Player (p?Study)");
  });

  test("Library actions target only the Active Playlist and the narrow top bar stays bounded", async () => {
    const track = cachedTrack("active-only", "Active Only");
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [track], searchTracks: () => [track],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/active-only.opus" }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer(),
    });
    await coordinator.dispatch({ type: "createPlaylist", name: "界界界界界界界界界界界界界界界界" });
    const activeId = coordinator.appState.playlists.activePlaylistId;
    const defaultId = coordinator.appState.playlists.playlists[0]!.id;
    coordinator.dispatchUi({ type: "switchTab", tab: "library" });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 60, rows: 20 });
    await terminal.stdin.write("a");
    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.title)).toEqual(["Active Only"]);
    await coordinator.dispatch({ type: "switchPlaylist", playlistId: defaultId });
    expect(coordinator.appState.activePlaylistContent.entries).toEqual([]);
    expect(coordinator.appState.playlists.playlists.find((playlist) => playlist.id === activeId)?.entries).toHaveLength(1);
    expect(terminal.lastFrame()!.split("\n").every((line) => Array.from(line).length <= 60)).toBe(true);
  });

  test("shows and dismisses an error recorded before the TUI mounts", async () => {
    const { coordinator } = createTmuApp();
    coordinator.appState.appErrors.push("Could not restore Last Playlist Snapshot");
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 100, rows: 24 });
    expect(terminal.lastFrame()).toContain("× ERROR · Could not restore Last Playlist Snapshot");
    await terminal.stdin.write("\x1b");
    expect(terminal.lastFrame()).not.toContain("Could not restore Last Playlist Snapshot");
  });

  test("renders the keyboard-first shell and routes global brackets through focused inputs", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 100, rows: 24 });
    expect(terminal.lastFrame()).toContain("╭");
    expect(terminal.lastFrame()).toContain("Player");
    expect(terminal.lastFrame()).toContain("Library");
    expect(terminal.lastFrame()).toContain("Downloads");
    expect(terminal.lastFrame()).toContain("[ prev ] next");
    expect(terminal.lastFrame()).toContain("Playlist is empty — open Library to add Tracks.");
    expect(terminal.lastFrame()).toContain("── j/k Move · Space Play/Pause · Enter Play Selected · n/p Next/Prev · P Playlists · ? Help");
    expect(terminal.lastFrame()).toContain("── q Quit Client · Ctrl-Q Shutdown Daemon");
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
    const playlist = new MemoryPlaylistContent();
    playlist.add(track);
    playlist.startAt(0);
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({}, { backgroundSoundsCandidate: true }), uiState: createInitialUiState(),
      initialPlaylistContent: playlist, player: new NoopPlayer(),
    });
    const hidden = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });
    expect(hidden.lastFrame()).not.toContain("▶ PLAYING");
    coordinator.appState.activePlaylistContent = playlist.snapshot();
    coordinator.appState.playback = {
      status: "playing", currentTrackIdentity: track.identity,
      positionSeconds: 65, durationSeconds: 245,
    };
    coordinator.appState.volume = { percent: 73, ready: true };
    coordinator.appState.activePlaylistContent.repeatAll = true;

    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });
    for (const tab of ["playback", "library", "downloader", "background"] as const) {
      coordinator.dispatchUi({ type: "switchTab", tab });
      const frame = terminal.lastFrame()!;
      expect(frame).toContain("── ▶ PLAYING · A Very Long Current T");
      expect(frame).toContain("▶ PLAYING");
      expect(frame).toContain("A Very Long Current T");
      expect(frame).toContain("1:05/4:05");
      expect(frame).toContain("[==--------]");
      expect(frame).toContain("Vol 73%");
      expect(frame).toContain("↻ ALL");
      expect(frame.indexOf("▶ PLAYING")).toBeLessThan(frame.indexOf("? Help"));
      expect(frame).not.toContain("Artist:");
      expect(frame).not.toContain("Channel:");
      expect(frame).not.toContain("Randomize");
    }
  });

  test.each([
    ["paused", "Ⅱ PAUSED", "Ⅱ"],
    ["stopped", "■ STOPPED", "■"],
    ["error", "! ERROR", "⚠"],
  ] as const)("gives %s playback a non-color status cue", async (status, cue, playlistCue) => {
    const track = cachedTrack("status", "Status Track");
    const playlist = new MemoryPlaylistContent();
    playlist.add(track);
    playlist.startAt(0);
    if (status === "error") playlist.markAvailability(track.identity, { status: "unavailable", reason: "cache missing" });
    const appState = createInitialAppState({});
    appState.activePlaylistContent = playlist.snapshot();
    appState.playback = { status, currentTrackIdentity: track.identity, positionSeconds: 42,
      ...(status === "paused" ? { paused: true } : {}) };
    const coordinator = new AppCoordinator({ appState, uiState: createInitialUiState(), initialPlaylistContent: playlist, player: new NoopPlayer() });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });
    expect(terminal.lastFrame()).toContain(cue);
    expect(terminal.lastFrame()).toContain(`${playlistCue} Status Track`);
    expect(terminal.lastFrame()).not.toContain("CURRENT");
    expect(terminal.lastFrame()).toContain("0:42");
    expect(terminal.lastFrame()).not.toContain("0:42/");
  });

  test("distinguishes restored resumable playback and truncates on narrow terminals", async () => {
    const track = cachedTrack("restored", "Restored Track With A Title Far Too Long For A Narrow Terminal");
    const playlist = new MemoryPlaylistContent();
    playlist.add(track);
    playlist.startAt(0);
    const appState = createInitialAppState({});
    appState.activePlaylistContent = playlist.snapshot();
    appState.playback = { status: "paused", currentTrackIdentity: track.identity, positionSeconds: 42, restored: true };
    const coordinator = new AppCoordinator({ appState, uiState: createInitialUiState(), initialPlaylistContent: playlist, player: new NoopPlayer() });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 60, rows: 20 });
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
    const playlist = new MemoryPlaylistContent();
    playlist.add(track);
    playlist.startAt(0);
    const appState = createInitialAppState({}, { config: { lowPower: { playbackProgressMs: 5_000 } } });
    appState.activePlaylistContent = playlist.snapshot();
    appState.playback = { status: "playing", currentTrackIdentity: track.identity, positionSeconds: 1, durationSeconds: 100 };
    const player = new PublishingPlayer();
    player.publish({ status: "playing", positionSeconds: 1, durationSeconds: 100 });
    const coordinator = new AppCoordinator({ appState, uiState: createInitialUiState(), initialPlaylistContent: playlist, player });
    let now = 0;
    let scheduled: (() => void) | undefined;
    const terminal = await render(createTmuRoot({
      client: coordinator, noColor: true,
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
    expect(terminal.lastFrame()).toContain("[----------]");

    for (const [elapsed, bar] of [
      ["0:07/1:40", "[----------]"],
      ["0:12/1:40", "[=---------]"],
      ["0:17/1:40", "[=---------]"],
      ["0:22/1:40", "[==--------]"],
    ] as const) {
      await terminal.stdin.write("l");
      expect(terminal.lastFrame()).toContain(elapsed);
      expect(terminal.lastFrame()).toContain(bar);
      expect([...bar]).toHaveLength(12);
    }
  });

  test("removes numeric tabs and command palette while help suspends actions", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ client: coordinator }), { columns: 100, rows: 24 });
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

  test("renders tab-scoped Shortcut Help as a bounded modal and dismisses without hidden actions", async () => {
    const track = cachedTrack("help-track", "Help Track");
    const playlist = new MemoryPlaylistContent();
    playlist.add(track);
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({}), uiState: createInitialUiState(), initialPlaylistContent: playlist, player: new NoopPlayer(),
    });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 120, rows: 30 });

    await terminal.stdin.write("?");
    const playerHelp = terminal.lastFrame()!;
    expect(playerHelp).toContain("Playback Shortcuts");
    expect(playerHelp).toContain("PLAYLIST PANE");
    expect(playerHelp).toContain("Randomize entire");
    expect(playerHelp).toContain("Playlist");
    expect(playerHelp).toContain("GLOBAL PLAYBACK");
    expect(playerHelp).toContain("j/k or ↑/↓ Scroll · PgUp/PgDn Page · Enter/q/?/Esc Close");
    expect(playerHelp).not.toContain("SEARCH INPUT");
    expect(playerHelp.split("\n").every((line) => [...line].length <= 120)).toBe(true);
    const modalBorder = playerHelp.match(/╭─{70,86}╮/)?.[0];
    expect(modalBorder?.length).toBeLessThanOrEqual(88);

    await terminal.stdin.write("]");
    expect(coordinator.uiState.activeTab).toBe("playback");
    await terminal.stdin.write("\r");
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(-1);
    expect(terminal.lastFrame()).not.toContain("Playback Shortcuts");

    for (const close of ["q", "?", "\x1b"] as const) {
      await terminal.stdin.write("?");
      await terminal.stdin.write(close);
      expect(terminal.lastFrame()).not.toContain("Playback Shortcuts");
    }
  });

  test.each([
    { columns: 120, rows: 30, leaveKey: "Tab", leaveInput: "\t" },
    { columns: 120, rows: 30, leaveKey: "Esc", leaveInput: "\x1b" },
    { columns: 60, rows: 16, leaveKey: "Tab", leaveInput: "\t" },
    { columns: 60, rows: 16, leaveKey: "Esc", leaveInput: "\x1b" },
  ])("documents complete Library shortcuts after $leaveKey at $columns×$rows", async ({ columns, rows, leaveInput }) => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns, rows });

    await terminal.stdin.write("]");
    await terminal.stdin.write("\t");
    await terminal.stdin.write("why?");
    expect(coordinator.uiState.library.query).toBe("why?");
    expect(terminal.lastFrame()).toContain("Esc/Tab → ? Help");
    expect(terminal.lastFrame()).toContain("── Ctrl-Q Shutdown Daemon");
    expect(terminal.lastFrame()).not.toContain("── q Quit Client");
    await terminal.stdin.write(leaveInput);
    expect(terminal.lastFrame()).toContain(columns < 90 ? "a Add" : "a Add to Playlist");
    const before = { ...coordinator.uiState.library };
    await terminal.stdin.write("?");
    expect(coordinator.uiState.overlays.at(-1)?.scroll).toBe(0);
    expect(terminal.lastFrame()).toContain("Library Shortcuts");
    expect(terminal.lastFrame()).toContain("SEARCH INPUT");
    expect(terminal.lastFrame()).toContain("Type");
    expect(terminal.lastFrame()).not.toContain("Type (including ?)");
    expect(terminal.lastFrame()).toContain("Backspace/Delete");
    expect(terminal.lastFrame()).not.toContain("PLAYLIST PANE");
    expect(terminal.lastFrame()).not.toContain("Randomize entire Playlist");
    expect(terminal.lastFrame()).not.toContain("DOWNLOAD PIPELINE");
    if (rows < 30) await terminal.stdin.write("\x1b[6~");
    expect(terminal.lastFrame()).toContain("LIBRARY RESULTS");
    expect(terminal.lastFrame()).toContain("Play Now");
    expect(terminal.lastFrame()).toContain("Play Next");
    if (rows < 30) await terminal.stdin.write("\x1b[6~");
    expect(terminal.lastFrame()).toContain("Add to Playlist");
    expect(terminal.lastFrame()).toContain("Open on YouTube");
    expect(terminal.lastFrame()).toContain("Delete Track (confirm)");
    expect(terminal.lastFrame()).not.toContain("Play Selected");
    expect(terminal.lastFrame()).not.toContain("Cancel active batch");
    await terminal.stdin.write("G");
    expect(terminal.lastFrame()).toContain("Printable keys");
    expect(terminal.lastFrame()).toContain("Captured by text input");
    expect(terminal.lastFrame()).toContain("[/], Ctrl-C");
    expect(terminal.lastFrame()).toContain("Remain global during");
    expect(terminal.lastFrame()).toContain("input");
    await terminal.stdin.write("q");
    expect(coordinator.uiState.library).toEqual(before);
  });

  test.each([
    { columns: 120, rows: 30 },
    { columns: 60, rows: 16 },
  ])("documents complete Downloads shortcuts and preserves Downloads state at $columns×$rows", async ({ columns, rows }) => {
    const { coordinator } = createTmuApp();
    const { appState } = coordinator;
    appState.downloads.activeBatch = { id: 4, sourceUrl: "https://youtu.be/active", kind: "single", itemCount: 1 };
    appState.downloads.pendingBatches = Array.from({ length: 12 }, (_, index) => ({
      id: index + 5,
      sourceUrl: `https://youtu.be/pending-${index}`,
      kind: "single" as const,
      itemCount: 1,
    }));
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns, rows });

    await terminal.stdin.write("]");
    await terminal.stdin.write("]");
    await terminal.stdin.write("https://youtu.be/watch?v=one?list=two");
    expect(terminal.lastFrame()).toContain("Esc/Tab → ? Help");
    expect(terminal.lastFrame()).toContain("── Ctrl-Q Shutdown Daemon");
    expect(terminal.lastFrame()).not.toContain("── q Quit Client");
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("G");
    const before = { ...coordinator.uiState.downloader };

    await terminal.stdin.write("?");
    const top = terminal.lastFrame()!;
    expect(top).toContain("YouTube Downloader Shortcuts");
    expect(top).toContain("URL INPUT");
    expect(top).toContain("Type");
    expect(top).toContain("Backspace/Delete");
    expect(top).toContain("Submit URL");
    if (rows >= 30) {
      expect(top).toContain("DOWNLOAD PIPELINE");
      expect(top).toContain("Cancel active batch");
      expect(top).toContain("Remove pending batch");
    }
    expect(top).not.toContain("Play Selected");
    expect(top).not.toContain("Play Now");
    expect(top).not.toContain("Randomize entire Playlist");

    if (rows < 30) {
      await terminal.stdin.write("\x1b[6~");
      const pipeline = terminal.lastFrame()!;
      expect(pipeline).toContain("DOWNLOAD PIPELINE");
      expect(pipeline).toContain("Cancel active batch");
      expect(pipeline).toContain("Remove pending batch");
    }
    await terminal.stdin.write("G");
    await terminal.stdin.write("q");
    expect(coordinator.uiState.downloader).toEqual(before);

    await terminal.stdin.write("\t");
    expect(coordinator.uiState.downloader.inputFocused).toBe(true);
    await terminal.stdin.write("?");
    expect(coordinator.uiState.downloader.urlInput.endsWith("?")).toBe(true);
    expect(terminal.lastFrame()).not.toContain("YouTube Downloader Shortcuts");
    await terminal.stdin.write("\t");
    await terminal.stdin.write("?");
    expect(coordinator.uiState.overlays.at(-1)?.scroll).toBe(0);
  });

  test("scrolls Shortcut Help locally, resets it on reopen, and reflows after resize", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 60, rows: 16 });
    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("Playback Shortcuts");
    expect(terminal.lastFrame()).toContain("PLAYLIST PANE");
    expect(terminal.lastFrame()).not.toContain("APPLICATION");

    await terminal.stdin.write("G");
    expect(terminal.lastFrame()).toContain("INPUT CAPTURE");
    expect(terminal.lastFrame()).toContain("Playback Shortcuts");
    expect(terminal.lastFrame()).toContain("Enter/q/?/Esc");
    expect(terminal.lastFrame()).toContain("Close");
    const bottomScroll = coordinator.uiState.overlays.at(-1)!.scroll;
    await terminal.stdin.write("\x1b[A");
    expect(coordinator.uiState.overlays.at(-1)!.scroll).toBe(bottomScroll - 1);
    await terminal.stdin.write("\x1b[B");
    expect(coordinator.uiState.overlays.at(-1)!.scroll).toBe(bottomScroll);
    await terminal.stdin.write("\x1b[5~");
    expect(coordinator.uiState.overlays.at(-1)!.scroll).toBeLessThan(bottomScroll);
    await terminal.stdin.write("\x1b[6~");
    expect(coordinator.uiState.overlays.at(-1)!.scroll).toBe(bottomScroll);
    await terminal.stdin.write("k");
    expect(coordinator.uiState.overlays.at(-1)!.scroll).toBe(bottomScroll - 1);
    await terminal.stdin.write("g");
    await terminal.stdin.write("j");
    await terminal.stdin.write("g");
    expect(coordinator.uiState.overlays.at(-1)!.scroll).toBeGreaterThan(0);
    await terminal.stdin.write("g");
    expect(coordinator.uiState.overlays.at(-1)!.scroll).toBe(0);
    expect(bottomScroll).toBeGreaterThan(0);
    await terminal.terminal.resize(100, 24);
    await waitFor(() => coordinator.uiState.terminal.columns === 100);
    expect(terminal.lastFrame()!.split("\n").every((line) => [...line].length <= 100)).toBe(true);
    await terminal.stdin.write("?");
    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("PLAYLIST PANE");
  });

  test("preserves Player state while complete Shortcut Help handles input and resize", async () => {
    const { coordinator } = createTmuApp();
    for (let index = 0; index < 12; index++) {
      await coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack(`help-${index}`, `Help Track ${index}`) });
    }
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 20 });
    await terminal.stdin.write("G");
    const before = {
      activeTab: coordinator.uiState.activeTab,
      selectedPlaylistIndex: coordinator.uiState.selectedPlaylistIndex,
      selectedPlaylistIdentity: coordinator.uiState.selectedPlaylistIdentity,
      playlistScroll: coordinator.uiState.playlistScroll,
      playlist: coordinator.appState.activePlaylistContent,
      playback: coordinator.appState.playback,
    };

    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("j/k Move · Space Play · Enter Select · n/p Next/Prev · P Playlists · ? Help");
    expect(terminal.lastFrame()).not.toContain("── q Quit Client");
    expect(terminal.lastFrame()).not.toContain("── Ctrl-Q Shutdown Daemon");
    expect(terminal.lastFrame()).toContain("PLAYLIST PANE");
    expect(terminal.lastFrame()).toContain("Randomize entire Playlist");
    await terminal.stdin.write("\x1b[6~");
    await terminal.stdin.write("G");
    expect(terminal.lastFrame()).toContain("Ctrl-C");
    expect(terminal.lastFrame()).toContain("Quit Client everywhere");

    for (const suppressed of ["]", " ", "x", "C", "N", "s", "r"] as const) {
      await terminal.stdin.write(suppressed);
    }
    await terminal.terminal.resize(120, 30);
    await waitFor(() => coordinator.uiState.terminal.columns === 120);
    expect(terminal.lastFrame()!.split("\n").every((line) => [...line].length <= 120)).toBe(true);
    await terminal.stdin.write("q");

    expect({
      activeTab: coordinator.uiState.activeTab,
      selectedPlaylistIndex: coordinator.uiState.selectedPlaylistIndex,
      selectedPlaylistIdentity: coordinator.uiState.selectedPlaylistIdentity,
      playlistScroll: coordinator.uiState.playlistScroll,
      playlist: coordinator.appState.activePlaylistContent,
      playback: coordinator.appState.playback,
    }).toEqual(before);
    expect(terminal.lastFrame()).not.toContain("Playback Shortcuts");
  });

  test("keeps the normal Ctrl-C download quit confirmation above Downloads Shortcut Help", async () => {
    const appState = createInitialAppState({});
    const coordinator = new AppCoordinator({
      appState, uiState: createInitialUiState(), initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer(),
      prepareDownloadBatch: async () => ({
        kind: "confirmation-required",
        confirmation: { title: "Help Playlist", itemCount: 2 },
        confirm: () => ({ sourceUrl: "https://youtube.com/playlist?list=help", kind: "playlist", entries: [] }),
        cancel: () => ({ kind: "cancelled" }),
      }),
    });
    void coordinator.dispatch({ type: "downloadOperation", operation: "start", url: "https://youtube.com/playlist?list=help" });
    await waitFor(() => appState.downloads.confirmation !== undefined);
    delete appState.downloads.confirmation;
    coordinator.dispatchUi({ type: "switchTab", tab: "downloader" });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });

    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("YouTube Downloader Shortcuts");
    await terminal.stdin.write("\x03");
    await waitFor(() => coordinator.appState.downloads.quitConfirmationRequired);
    expect(terminal.lastFrame()).toContain("Quit TMU?");
    expect(terminal.lastFrame()).toContain("Active and pending download work will be");
    expect(terminal.lastFrame()).toContain("cancelled.");
    expect(terminal.lastFrame()).not.toContain("YouTube Downloader Shortcuts");
    await terminal.stdin.write("y");
  });

  test("keeps confirmations above Help", async () => {
    const appState = createInitialAppState({});
    const coordinator = new AppCoordinator({
      appState, uiState: createInitialUiState(), initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer(),
    });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });

    await terminal.stdin.write("C");
    expect(terminal.lastFrame()).toContain("Clear Playlist?");
    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("Clear Playlist?");
    expect(terminal.lastFrame()).not.toContain("Playback Shortcuts");
  });

  test("keeps responsive state and suspends hidden actions while terminal is too small", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 100, rows: 24 });
    await terminal.terminal.resize(59, 15);
    expect(terminal.lastFrame()).toContain("Terminal too small");
    await terminal.stdin.write("]");
    await terminal.stdin.write("?");
    expect(coordinator.uiState.activeTab).toBe("playback");
    expect(coordinator.uiState.overlays).toEqual([]);
    await terminal.terminal.resize(120, 24);
    expect(coordinator.uiState.terminal.tier).toBe("wide");
    expect(terminal.lastFrame()).toContain("Player");
  });

  test("moves and keeps long Playlist selections visible with shared Vim navigation", async () => {
    const { coordinator } = createTmuApp();
    for (let index = 0; index < 12; index++) await coordinator.dispatch({ type: "addToPlaylist", target: cachedTrack(`track-${index}`, `Track ${index}`) });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 80, rows: 24 });
    await terminal.stdin.write("G");
    expect(coordinator.uiState.selectedPlaylistIndex).toBe(11);
    expect(terminal.lastFrame()).toContain("› ! Track 11");
    await terminal.stdin.write("g");
    await terminal.stdin.write("g");
    expect(coordinator.uiState.selectedPlaylistIndex).toBe(0);
    await terminal.stdin.write("\x1b[6~");
    expect(coordinator.uiState.selectedPlaylistIndex).toBeGreaterThan(0);
  });
  test("opens on Playback and reaches Library and YouTube Downloader while retaining tab-local input", async () => {
    const { coordinator } = createTmuApp();
    const terminal = await render(createTmuRoot({ client: coordinator }), { columns: 100, rows: 24 });

    expect(terminal.lastFrame()).toContain("▸ Player (Default) ◂");
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

  test("keeps core Playback playlist actions available after provider narrowing", async () => {
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
      initialPlaylistContent: new MemoryPlaylistContent(),
      player: new NoopPlayer(),
    });
    await coordinator.dispatch({ type: "playNext", target: first });
    await coordinator.dispatch({ type: "playNext", target: second });
    const terminal = await render(createTmuRoot({ client: coordinator }), { columns: 100, rows: 24 });

    await terminal.stdin.write("\r");
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(0);
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
    expect(terminal.lastFrame()).toContain("Clear Playlist?");
    expect(terminal.lastFrame()).toContain("› Cancel ‹");
    await terminal.stdin.write("]");
    expect(coordinator.uiState.activeTab).toBe("playback");
    await terminal.stdin.write("\r");
    expect(coordinator.appState.activePlaylistContent.entries).toHaveLength(2);
    await terminal.stdin.write("C");
    await terminal.stdin.write("\t");
    expect(terminal.lastFrame()).toContain("› Clear ‹");
    await terminal.stdin.write("\x1b[D");
    expect(terminal.lastFrame()).toContain("› Cancel ‹");
    await terminal.stdin.write("\x1b[C");
    expect(terminal.lastFrame()).toContain("› Clear ‹");
    await terminal.stdin.write("\r");
    expect(coordinator.appState.activePlaylistContent.entries).toEqual([]);
    expect(terminal.lastFrame()).toContain("✓ SUCCESS");
    await sleep(2_600);
    expect(terminal.lastFrame()).not.toContain("✓ SUCCESS");

    await terminal.stdin.write("]");
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("a");
    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["first"]);
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(-1);

    await terminal.stdin.write("j");
    await terminal.stdin.write("N");
    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.identity.stableId))
      .toEqual(["second", "first"]);
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(-1);

    await terminal.stdin.write("\r");
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(second.identity);
  });

  test("renders the responsive Player Playlist and complete selected cache metadata", async () => {
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
      renameTrack: async (identity, title) => ({
        ...(identity.stableId === "first" ? first : second), title,
      }),
      deleteCacheEntry: async () => false, cleanupIncompleteEntry: async () => false,
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer(),
    });
    await coordinator.dispatch({ type: "createPlaylist", name: "Road" });
    await coordinator.dispatch({ type: "addToPlaylist", target: first });
    await coordinator.dispatch({ type: "addToPlaylist", target: second });
    coordinator.dispatchUi({ type: "selectPlaylistTrack", index: 1, identities: coordinator.playlistTrackIdentities() });
    await coordinator.dispatch({ type: "playSelected", identity: first.identity });

    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 120, rows: 28 });
    let frame = terminal.lastFrame()!;
    expect(frame).toContain("Road · 2 Tracks · 2/2");
    expect(frame).toContain("▶ First · 1:05");
    expect(frame).not.toContain("CURRENT");
    expect(frame).toContain("Selected Song · 4:05");
    expect(frame).toContain("Title: Selected Song");
    expect(frame).toContain("Channel: The Channel");
    expect(frame).toContain("Cached: 2026-07-10");
    expect(frame).toContain("Format: opus");
    expect(frame).toContain("Size: 1.5 MiB");
    expect(frame).toContain("Video ID: second");
    const widePlaylistLine = frame.split("\n").findIndex((line) => line.includes("Road ·"));
    const widePreviewLine = frame.split("\n").findIndex((line) => line.includes("Selected Track"));
    expect(widePreviewLine).toBe(widePlaylistLine);

    await terminal.terminal.resize(100, 28);
    frame = terminal.lastFrame()!;
    const mediumTitleLine = frame.split("\n").find((line) => line.includes("Road ·") && line.includes("Selected Track"))!;
    const borders = [...mediumTitleLine].flatMap((character, index) => character === "│" ? [index] : []);
    expect(borders).toHaveLength(4);
    expect((borders[1]! - borders[0]!) / (borders[3]! - borders[2]!)).toBeGreaterThan(1.6);
    expect((borders[1]! - borders[0]!) / (borders[3]! - borders[2]!)).toBeLessThan(2.2);

    await terminal.terminal.resize(80, 28);
    frame = terminal.lastFrame()!;
    expect(frame.split("\n").findIndex((line) => line.includes("Selected Track")))
      .toBeGreaterThan(frame.split("\n").findIndex((line) => line.includes("Selected Song · 4:05")));
  });

  test("keeps the wide Library inspector width stable across Track selection", async () => {
    const tracks = [
      cachedTrack("a", "Short"),
      cachedTrack("b", "A Track Title Long Enough To Influence Intrinsic Flex Sizing"),
    ];
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => tracks, searchTracks: () => tracks,
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer(),
    });
    coordinator.dispatchUi({ type: "switchTab", tab: "library" });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 120, rows: 24 });
    const inspectorLeft = () => {
      const line = terminal.lastFrame()!.split("\n").find((candidate) => candidate.includes("Selected Track"))!;
      return line.indexOf("│", 1);
    };

    const initialInspectorLeft = inspectorLeft();
    await terminal.stdin.write("j");

    expect(inspectorLeft()).toBe(initialInspectorLeft);
  });

  test("keeps Playlist selection independent while Player shortcuts edit exact visible order", async () => {
    const tracks = [cachedTrack("a", "A"), cachedTrack("b", "B"), cachedTrack("c", "C")];
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => tracks, searchTracks: () => tracks,
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({ appState: createInitialAppState({ "youtube-cache": provider }),
      uiState: createInitialUiState(), initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer() });
    for (const track of tracks) await coordinator.dispatch({ type: "addToPlaylist", target: track });
    await coordinator.dispatch({ type: "playSelected", identity: tracks[0]!.identity });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 100, rows: 24 });

    await terminal.stdin.write("j");
    expect(terminal.lastFrame()).toContain("› · B");
    expect(terminal.lastFrame()).toContain("▶ A");
    await terminal.stdin.write(" ");
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(0);
    await terminal.stdin.write("\r");
    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.title)).toEqual(["A", "B", "C"]);
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(1);
    await terminal.stdin.write("J");
    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.title)).toEqual(["A", "C", "B"]);
    expect(coordinator.uiState.selectedPlaylistIdentity).toEqual(tracks[1]!.identity);
    await terminal.stdin.write("K");
    await terminal.stdin.write("N");
    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.title)).toEqual(["A", "B", "C"]);
    await terminal.stdin.write("x");
    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.title)).toEqual(["A", "C"]);
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(-1);
    expect(coordinator.appState.playback).toMatchObject({ status: "idle", currentTrackIdentity: null });
    await terminal.stdin.write(" ");
    expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(-1);
    await terminal.stdin.write("C");
    expect(terminal.lastFrame()).toContain("Clear Playlist?");
    await terminal.stdin.write("\r");
    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.title)).toEqual(["A", "C"]);
  });

  test("Z randomizes the entire Playlist only from the Player Playlist Pane", async () => {
    const tracks = [cachedTrack("a", "A"), cachedTrack("b", "B"), cachedTrack("c", "C"), cachedTrack("d", "D")];
    for (const tab of ["library", "downloader", "playback"] as const) {
      const provider: Provider = { id: "youtube-cache", label: "YouTube Cache", listTracks: () => tracks,
        searchTracks: () => tracks, resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/test.opus" }) };
      const coordinator = new AppCoordinator({ appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
        initialPlaylistContent: new MemoryPlaylistContent({ random: () => 0 }), player: new NoopPlayer() });
      for (const track of tracks) await coordinator.dispatch({ type: "addToPlaylist", target: track });
      await coordinator.dispatch({ type: "playSelected", identity: tracks[0]!.identity });
      coordinator.dispatchUi({ type: "switchTab", tab });
      const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 100, rows: 24 });

      await terminal.stdin.write("Z");

      const titles = coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.title);
      expect(titles).toEqual(tab === "playback" ? ["B", "C", "D", "A"] : ["A", "B", "C", "D"]);
      if (tab === "playback") {
        expect(coordinator.appState.activePlaylistContent.currentIndex).toBe(3);
        expect(coordinator.appState.playback).toMatchObject({ status: "playing", currentTrackIdentity: tracks[0]!.identity });
        expect(terminal.lastFrame()!.indexOf("· B")).toBeLessThan(terminal.lastFrame()!.indexOf("▶ A"));
        expect(terminal.lastFrame()).not.toContain("Shuffle");
      }
    }
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
      renameTrack: async (_identity, title) => ({ ...track, title }),
      deleteCacheEntry: async () => { deleted = true; return true; },
      cleanupIncompleteEntry: async (stem) => { cleanedStem = stem; return true; },
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer(),
    });
    await coordinator.dispatch({ type: "playNow", target: track });
    const defaultId = coordinator.appState.playlists.activePlaylistId;
    await coordinator.dispatch({ type: "createPlaylist", name: "Study" });
    await coordinator.dispatch({ type: "addToPlaylist", target: track });
    await coordinator.dispatch({ type: "switchPlaylist", playlistId: defaultId });
    await coordinator.dispatch({ type: "playSelected", identity: track.identity });
    const opened: string[] = [];
    const terminal = await render(createTmuRoot({
      client: coordinator, noColor: true, openUrl: async (url) => { opened.push(url); },
    }), { columns: 120, rows: 24 });
    await terminal.stdin.write("]");
    const initial = terminal.lastFrame()!;
    expect(initial.indexOf("Broken First")).toBeLessThan(initial.indexOf("Cached"));
    const incompleteRow = initial.split("\n").find((line) => line.includes("! Broken First"))!;
    const cachedRow = initial.split("\n").find((line) => line.includes("✓ Cached"))!;
    expect(incompleteRow).toContain("! Broken First · 1:01");
    expect(cachedRow).toContain("✓ Cached · 2:05");
    expect(incompleteRow).not.toContain("KiB");
    expect(cachedRow).not.toContain("KiB");
    expect(initial).toContain("Size: 4.0 KiB");
    expect(initial).not.toContain("Channel B ·");
    expect(initial).toContain("Health: Cache media has no sidecar");
    expect(initial).toContain("Video ID: actual00001");
    expect(initial).toContain("Channel: Channel B");
    expect(initial).toContain("d Clean · / Search");
    expect(initial).not.toContain("Enter Play · a Add");
    expect(initial.split("\n").find((line) => line.includes("Library ·"))).toContain("Incomplete Cache Entry");
    await terminal.stdin.write("O");
    expect(opened).toEqual([]);
    const beforeHelp = { ...coordinator.uiState.library };
    await terminal.stdin.write("?");
    expect(terminal.lastFrame()).toContain("Clean incomplete Cache");
    expect(terminal.lastFrame()).toContain("Entry");
    expect(terminal.lastFrame()).not.toContain("Play Now");
    expect(terminal.lastFrame()).not.toContain("Play Next");
    expect(terminal.lastFrame()).not.toContain("Add to Playlist");
    await terminal.stdin.write("q");
    expect(coordinator.uiState.library).toEqual(beforeHelp);
    await terminal.terminal.resize(100, 24);
    await waitFor(() => coordinator.uiState.terminal.columns === 100);
    expect(coordinator.uiState.terminal.tier).toBe("medium");
    await terminal.stdin.write("a");
    expect(coordinator.appState.activePlaylistContent.entries).toHaveLength(1);
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
    expect(coordinator.appState.playlists.playlists.map((playlist) => playlist.entries[0]?.availability.status))
      .toEqual(["unavailable", "unavailable"]);
    await coordinator.dispatch({ type: "switchPlaylist", playlistId: coordinator.appState.playlists.playlists[1]!.id });
    coordinator.dispatchUi({ type: "switchTab", tab: "playback" });
    await waitFor(() => terminal.lastFrame()!.includes("! Cached"));
    coordinator.dispatchUi({ type: "switchTab", tab: "library" });
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

  test("opens the selected healthy Library Track on YouTube with O", async () => {
    const track = cachedTrack("dQw4w9WgXcQ", "Open Me");
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [track], searchTracks: () => [track],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/video.opus" }),
    };
    const opened: string[] = [];
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer(),
    });
    const terminal = await render(createTmuRoot({
      client: coordinator, noColor: true, openUrl: async (url) => { opened.push(url); },
    }), { columns: 100, rows: 24 });

    await terminal.stdin.write("]");
    await terminal.stdin.write("O");

    expect(opened).toEqual(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    await terminal.stdin.write("\t");
    await terminal.stdin.write("O");
    expect(coordinator.uiState.library.query).toBe("O");
    expect(opened).toHaveLength(1);
  });

  test("YouTube Downloader exposes pending removal, active cancellation, and session summaries", async () => {
    const { coordinator: base } = createTmuApp();
    const playlist = new MemoryPlaylistContent();
    playlist.add(cachedTrack("already-Playlist", "Already Playlist"));
    const playlistBefore = playlist.snapshot();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(base.appState.providers), uiState: createInitialUiState(),
      initialPlaylistContent: playlist, player: new NoopPlayer(),
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
    const terminal = await render(createTmuRoot({ client: coordinator }), { columns: 100, rows: 24 });
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
    expect(coordinator.appState.activePlaylistContent).toEqual(playlistBefore);
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
    const coordinator = new AppCoordinator({ appState, uiState, initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer() });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 90, rows: 24 });

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
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 90, rows: 24 });
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
    const coordinator = new AppCoordinator({ appState, uiState, initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer() });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 60, rows: 20 });

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
      initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer(),
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
    const terminal = await render(createTmuRoot({ client: coordinator }), { columns: 100, rows: 24 });
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
    const playlist = new MemoryPlaylistContent();
    playlist.add(track);
    playlist.markAvailability(track.identity, { status: "unavailable", reason: "mpv playback failed: corrupt stream" });
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [], searchTracks: () => [],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/unused" }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: playlist, player: new NoopPlayer(),
    });
    const terminal = await render(createTmuRoot({ client: coordinator }), { columns: 100, rows: 24 });
    expect(terminal.lastFrame()).toContain("! Broken Track · —:—");
    expect(terminal.lastFrame()).toContain("Unavailable: mpv playback");
    expect(terminal.lastFrame()).toContain("failed: corrupt stream");
  });

  test("Library Cache Search finds a cached Track and places it in Playlist", async () => {
    const first = cachedTrack("first", "First Track");
    const second = cachedTrack("second", "Second Track");
    const provider: Provider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [first, second],
      searchTracks: (query) => [first, second].filter((track) => track.title.toLowerCase().includes(query.toLowerCase())),
      resolvePlaybackLocator: async (identity) => ({ kind: "file", path: `/cache/${identity.stableId}.opus` }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ "youtube-cache": provider }), uiState: createInitialUiState(),
      initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer(),
    });
    const terminal = await render(createTmuRoot({ client: coordinator }), { columns: 100, rows: 24 });
    await terminal.stdin.write("]");
    await terminal.stdin.write("\t");
    await terminal.stdin.write("second");
    expect(terminal.lastFrame()).toContain("› ✓ Second Track");
    expect(terminal.lastFrame()).not.toContain("✓ First Track");
    await terminal.stdin.write("\x1b");
    await terminal.stdin.write("a");
    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track.identity.stableId)).toEqual(["second"]);
  });

  test("renames the selected Library Track in a modal and updates Playlist and Now Playing", async () => {
    let track = cachedTrack("rename00001", "Bad Name");
    const provider: YouTubeCacheProvider = {
      id: "youtube-cache", label: "YouTube Cache", listTracks: () => [track], searchTracks: () => [track],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache/rename00001.opus" }),
      refresh: () => undefined,
      listCacheEntries: () => [{
        track, availability: { status: "available" },
        metadata: { videoId: "rename00001", title: "Bad Name", uploader: "Channel",
          cachedAt: "2026-01-01T00:00:00.000Z", mediaFileName: "rename00001.opus", container: "opus" },
        metadataPath: "/cache/rename00001.json", mediaPath: "/cache/rename00001.opus",
      }],
      listIncompleteEntries: () => [], findByIdentity: () => ({
        track, availability: { status: "available" },
        metadata: { videoId: "rename00001", title: track.title, uploader: "Channel",
          cachedAt: "2026-01-01T00:00:00.000Z", mediaFileName: "rename00001.opus", container: "opus" },
        metadataPath: "/cache/rename00001.json", mediaPath: "/cache/rename00001.opus",
      }),
      renameTrack: async (_identity, title) => {
        const normalizedTitle = title.trim();
        if (!normalizedTitle) throw new Error("Track Title must not be empty");
        if (normalizedTitle === "Cannot Save") throw new Error("cache is read-only");
        return (track = { ...track, title: normalizedTitle });
      },
      deleteCacheEntry: async () => false, cleanupIncompleteEntry: async () => false,
    };
    const appState = createInitialAppState({ "youtube-cache": provider });
    const coordinator = new AppCoordinator({ appState, uiState: createInitialUiState(), initialPlaylistContent: new MemoryPlaylistContent(), player: new NoopPlayer() });
    await coordinator.dispatch({ type: "addToPlaylist", target: track });
    const defaultId = coordinator.appState.playlists.activePlaylistId;
    await coordinator.dispatch({ type: "createPlaylist", name: "Study" });
    await coordinator.dispatch({ type: "addToPlaylist", target: track });
    await coordinator.dispatch({ type: "switchPlaylist", playlistId: defaultId });
    await coordinator.dispatch({ type: "playSelected", identity: track.identity });
    const terminal = await render(createTmuRoot({ client: coordinator, noColor: true }), { columns: 100, rows: 24 });

    await terminal.stdin.write("]");
    expect(terminal.lastFrame()).toContain("e Rename");
    await terminal.stdin.write("e");
    expect(terminal.lastFrame()).toContain("Rename Track");
    expect(terminal.lastFrame()).toContain("Current name: Bad Name");
    expect(terminal.lastFrame()).toContain("New name: Bad Name");
    await terminal.stdin.write("\x7f".repeat("Bad Name".length));
    await terminal.stdin.write("Clear Name");
    await terminal.stdin.write("\r");
    await waitFor(() => terminal.lastFrame()!.includes("Renamed to “Clear Name”"));

    expect(coordinator.uiState.renameDialog).toBeNull();
    expect(coordinator.appState.activePlaylistContent.entries[0]?.track.title).toBe("Clear Name");
    expect(coordinator.appState.playlists.playlists.map((playlist) => playlist.entries[0]?.track.title))
      .toEqual(["Clear Name", "Clear Name"]);
    expect(terminal.lastFrame()).toContain("✓ Clear Name");
    expect(terminal.lastFrame()).toContain("▶ PLAYING · Clear Name");

    await terminal.stdin.write("e");
    await terminal.stdin.write("\x7f".repeat("Clear Name".length));
    await terminal.stdin.write("A🎵B");
    await terminal.stdin.write("\x1b[H");
    await terminal.stdin.write("\x1b[C");
    await terminal.stdin.write("\x1b[C");
    await terminal.stdin.write("\x7f");
    await terminal.stdin.write("\r");
    await waitFor(() => coordinator.appState.activePlaylistContent.entries[0]?.track.title === "AB");

    await terminal.stdin.write("e");
    await terminal.stdin.write("\x7f".repeat("AB".length));
    await terminal.stdin.write("   ");
    await terminal.stdin.write("\r");
    expect(terminal.lastFrame()).toContain("Error: Track Title must not be empty");
    await terminal.stdin.write("\x7f".repeat(3));
    await terminal.stdin.write("Cannot Save");
    await terminal.stdin.write("\r");
    await waitFor(() => terminal.lastFrame()!.includes("Error: cache is read-only"));
    expect(coordinator.uiState.renameDialog?.value).toBe("Cannot Save");
    expect(coordinator.appState.activePlaylistContent.entries[0]?.track.title).toBe("AB");
    await terminal.stdin.write("\x1b");
    expect(coordinator.uiState.renameDialog).toBeNull();
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
