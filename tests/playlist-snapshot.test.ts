import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  FileLastPlaylistSnapshotPersistence,
  MemoryPlaylistCollection,
  MemoryPlaylistContent,
  createLastPlaylistSnapshot,
  createTmuApp,
  playlistCollectionFromSnapshot,
  type LastPlaylistSnapshot,
  type Track,
} from "../src/index";
import type { LastQueueSnapshot } from "../src/snapshot";

const amber: Track = {
  identity: { providerId: "youtube-cache", stableId: "amber" },
  title: "Amber",
  providerLabel: "YouTube Cache",
};

describe("Last Playlist Snapshot persistence", () => {
  test("a fresh collection has exactly one opaque Active Playlist named Default", () => {
    const collection = new MemoryPlaylistCollection(new MemoryPlaylistContent());

    expect(collection.snapshot().playlists).toHaveLength(1);
    expect(collection.snapshot().activePlaylistId).toBe(collection.snapshot().playlists[0]?.id);
    expect(collection.snapshot().playlists[0]).toMatchObject({ name: "Default", positionSeconds: 0, playbackStatus: "stopped" });
    expect(collection.snapshot().playlists[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("normalizes shared Tracks while keeping membership unique per Playlist", async () => {
    const collection = new MemoryPlaylistCollection(new MemoryPlaylistContent());
    collection.activePlaylistContent.add(amber);
    const second = collection.append("Study");
    second.content.add(amber);
    second.content.add({ ...amber, title: "Duplicate metadata" });

    const snapshot = createLastPlaylistSnapshot(collection.snapshot(), { percent: 64, ready: true });

    expect(snapshot.tracks).toEqual([amber]);
    expect(snapshot.playlists.map((playlist) => playlist.trackIdentities)).toEqual([
      [amber.identity],
      [amber.identity],
    ]);
  });

  test("omits Track records after their final Playlist membership is removed", () => {
    const collection = new MemoryPlaylistCollection(new MemoryPlaylistContent());
    collection.activePlaylistContent.add(amber);
    const second = collection.append("Study");
    second.content.add(amber);
    collection.activePlaylistContent.clear();

    expect(createLastPlaylistSnapshot(collection.snapshot(), { percent: 64, ready: true }).tracks).toEqual([amber]);

    second.content.clear();
    expect(createLastPlaylistSnapshot(collection.snapshot(), { percent: 64, ready: true }).tracks).toEqual([]);
  });

  test("does not persist session Track Availability", () => {
    const collection = new MemoryPlaylistCollection(new MemoryPlaylistContent());
    collection.activePlaylistContent.add(amber);
    collection.markAvailability(amber.identity, { status: "unavailable", reason: "mpv playback failed" });

    const restored = playlistCollectionFromSnapshot(
      createLastPlaylistSnapshot(collection.snapshot(), { percent: 64, ready: true }),
    );

    expect(restored.playlists[0]?.entries[0]?.availability).toEqual({ status: "unknown" });
  });

  test("restores a complete snapshot without autoplay", async () => {
    const persistence = new FileLastPlaylistSnapshotPersistence("unused");
    const source = new MemoryPlaylistCollection(new MemoryPlaylistContent());
    source.activePlaylistContent.add(amber);
    source.activePlaylistContent.startAt(0);
    source.updateActivePlayback({ positionSeconds: 27, playbackStatus: "resumable" });
    const saved = createLastPlaylistSnapshot(source.snapshot(), { percent: 72, ready: true });
    persistence.load = async () => saved;
    persistence.save = async () => undefined;

    const { coordinator } = createTmuApp({ playlistSnapshotPersistence: persistence });
    await coordinator.start();

    expect(coordinator.appState.playlists.playlists[0]).toMatchObject({
      name: "Default", currentIndex: 0, positionSeconds: 27, playbackStatus: "resumable",
    });
    expect(coordinator.appState.playback).toMatchObject({ status: "paused", positionSeconds: 27, restored: true });
  });

  test("migrates legacy Queue state only when no Playlist snapshot exists", async () => {
    const legacy: LastQueueSnapshot = {
      version: 1,
      entries: [{ track: amber }],
      currentIndex: 0,
      repeatAll: true,
      volume: { percent: 41, ready: true },
      positionSeconds: 19,
    };
    let saved: unknown;
    const { coordinator } = createTmuApp({
      playlistSnapshotPersistence: { load: async () => null, save: async (value) => { saved = value; } },
      legacyQueueSnapshotPersistence: { load: async () => legacy, save: async () => undefined },
    });

    await coordinator.start();

    expect(coordinator.appState.playlists.playlists[0]).toMatchObject({ name: "Default", currentIndex: 0, repeatAll: true, positionSeconds: 19 });
    expect(coordinator.appState.volume.percent).toBe(41);
    expect(saved).toMatchObject({ version: 1, volume: { percent: 41 } });
  });

  test("quarantines an invalid Playlist snapshot and never revives legacy Queue state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-playlist-corrupt-"));
    const path = join(dir, "last-playlists.json");
    await writeFile(path, JSON.stringify({ version: 1, playlists: [{ broken: true }] }));
    const persistence = new FileLastPlaylistSnapshotPersistence(path);
    const legacy: LastQueueSnapshot = {
      version: 1, entries: [{ track: amber }], currentIndex: 0, repeatAll: false,
      volume: { percent: 100, ready: false }, positionSeconds: 0,
    };
    try {
      const { coordinator } = createTmuApp({
        playlistSnapshotPersistence: persistence,
        legacyQueueSnapshotPersistence: { load: async () => legacy, save: async () => undefined },
      });
      await coordinator.start();

      expect(coordinator.appState.activePlaylistContent.entries).toEqual([]);
      expect(coordinator.appState.appErrors.join("\n")).toContain("Last Playlist Snapshot");
      expect((await readdir(dir)).some((name) => name.startsWith("last-playlists.json.corrupt-"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes Playlist snapshots atomically as normalized JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-playlist-save-"));
    const path = join(dir, "state", "last-playlists.json");
    const persistence = new FileLastPlaylistSnapshotPersistence(path);
    const collection = new MemoryPlaylistCollection(new MemoryPlaylistContent());
    collection.activePlaylistContent.add(amber);
    try {
      await persistence.save(createLastPlaylistSnapshot(collection.snapshot(), { percent: 50, ready: true }));
      const raw = await readFile(path, "utf8");
      expect(JSON.parse(raw)).toMatchObject({ version: 2, playingPlaylistId: collection.activePlaylistId, tracks: [amber] });
      expect(JSON.parse(raw)).not.toHaveProperty("activePlaylistId");
      expect((await readdir(join(dir, "state"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("backs up a pre-0.4.0 snapshot once before atomically migrating Playing Playlist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-playlist-migrate-"));
    const path = join(dir, "last-playlists.json");
    const collection = new MemoryPlaylistCollection(new MemoryPlaylistContent());
    const legacy = createLastPlaylistSnapshot(collection.snapshot(), { percent: 50, ready: true });
    const legacyRaw = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(path, legacyRaw);
    try {
      const persistence = new FileLastPlaylistSnapshotPersistence(path);
      const loaded = await persistence.load();
      expect(loaded?.activePlaylistId).toBe(collection.activePlaylistId);
      await persistence.save(loaded!);
      expect(await readFile(`${path}.pre-0.4.0`, "utf8")).toBe(legacyRaw);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        version: 2, playingPlaylistId: collection.activePlaylistId,
      });
      await persistence.save(loaded!);
      expect(await readFile(`${path}.pre-0.4.0`, "utf8")).toBe(legacyRaw);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("keeps in-memory behavior after a save failure and retries on the next meaningful change", async () => {
    let attempts = 0;
    const saved: unknown[] = [];
    const { coordinator } = createTmuApp({
      playlistSnapshotPersistence: {
        load: async () => null,
        save: async (snapshot) => {
          attempts += 1;
          if (attempts === 1) throw new Error("disk full");
          saved.push(snapshot);
        },
      },
      legacyQueueSnapshotPersistence: { load: async () => null, save: async () => undefined },
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "addToPlaylist", target: amber });
    expect(coordinator.appState.activePlaylistContent.entries.map((entry) => entry.track)).toEqual([amber]);
    expect(coordinator.appState.appErrors.at(-1)).toContain("Will retry");

    await coordinator.dispatch({ type: "playerOperation", operation: "toggle-repeat-all" });
    expect(attempts).toBe(2);
    expect(saved).toHaveLength(1);
    expect(coordinator.appState.activePlaylistContent.repeatAll).toBe(true);
  });

  test("retries a failed Playlist snapshot save on quit", async () => {
    let attempts = 0;
    const { coordinator } = createTmuApp({
      playlistSnapshotPersistence: {
        load: async () => null,
        save: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporarily read-only");
        },
      },
      legacyQueueSnapshotPersistence: { load: async () => null, save: async () => undefined },
    });

    await coordinator.start();
    await coordinator.dispatch({ type: "addToPlaylist", target: amber });
    await coordinator.teardown();

    expect(attempts).toBe(2);
  });
});
