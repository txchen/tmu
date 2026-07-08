import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTmuRuntime,
  createLastQueueSnapshot,
  FileLastQueueSnapshotPersistence,
  InMemoryLastQueueSnapshotPersistence,
  MemoryQueue,
  type DependencyCommandRunner,
  type LastQueueSnapshot,
  type Track,
} from "../src/index";

function snapshot(): LastQueueSnapshot {
  return {
    version: 1,
    entries: [
      {
        track: {
          identity: { providerId: "navidrome", stableId: "song-1" },
          title: "Remote Song",
          providerLabel: "Navidrome",
        },
        availability: { status: "unknown" },
      },
    ],
    currentIndex: 0,
    shuffle: true,
    repeatAll: false,
    volume: { percent: 88, ready: true },
  };
}

describe("Last Queue Snapshot persistence", () => {
  test("stores and loads snapshots in memory for coordinator tests", async () => {
    const persistence = new InMemoryLastQueueSnapshotPersistence();
    const value = snapshot();

    await persistence.save(value);

    expect(await persistence.load()).toEqual(value);
  });

  test("stores and loads snapshots from a JSON file without a broader app database", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-snapshot-"));
    const file = join(dir, "state", "last-queue.json");
    const persistence = new FileLastQueueSnapshotPersistence(file);
    const value = snapshot();

    try {
      await persistence.save(value);
      expect(await persistence.load()).toEqual(value);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serializes only durable Track Identity and display metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-snapshot-"));
    const file = join(dir, "last-queue.json");
    const queue = new MemoryQueue();
    const trackWithRuntimeField = {
      identity: { providerId: "navidrome", stableId: "song-secret" },
      title: "Remote Secret",
      providerLabel: "Navidrome",
      playbackLocator: { kind: "url", url: "https://example.test/auth-token" },
    } as Track & { playbackLocator: { kind: "url"; url: string } };
    queue.enqueue(trackWithRuntimeField);
    const persistence = new FileLastQueueSnapshotPersistence(file);

    try {
      await persistence.save(createLastQueueSnapshot(queue.snapshot(), { percent: 50, ready: true }));
      const raw = await readFile(file, "utf8");
      const loaded = await persistence.load();

      expect(raw).not.toContain("playbackLocator");
      expect(raw).not.toContain("auth-token");
      expect(loaded?.entries[0]?.track).toEqual({
        identity: { providerId: "navidrome", stableId: "song-secret" },
        title: "Remote Secret",
        providerLabel: "Navidrome",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("treats missing or corrupted snapshot files as absent state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-snapshot-"));
    const file = join(dir, "last-queue.json");
    const persistence = new FileLastQueueSnapshotPersistence(file);

    try {
      expect(await persistence.load()).toBeNull();
      await mkdir(dir, { recursive: true });
      await Bun.write(file, "{not-json");
      expect(await persistence.load()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runtime uses file-backed Last Queue Snapshot persistence across app instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-runtime-snapshot-"));
    const configPath = join(dir, "config.json");
    const snapshotPath = join(dir, "last-queue.json");
    const runner: DependencyCommandRunner = async ({ helper }) => ({
      exitCode: 0,
      stdout: helper === "ffprobe" ? "ffprobe version 7.1\n" : `${helper} 1.0\n`,
      stderr: "",
    });

    try {
      await writeFile(configPath, JSON.stringify({
        persistence: {
          lastQueueSnapshotPath: snapshotPath,
        },
      }));

      const first = await createTmuRuntime({ configPath, dependencyRunner: runner });
      first.coordinator.start(["./song-a.flac"]);
      await first.coordinator.dispatch({ type: "setVolume", percent: 61, ready: true });
      await first.coordinator.dispatch({ type: "toggleShuffle" });
      await first.coordinator.dispatch({ type: "saveLastQueueSnapshot" });

      const second = await createTmuRuntime({ configPath, dependencyRunner: runner });
      second.coordinator.start([]);
      await second.coordinator.dispatch({ type: "restoreLastQueueSnapshot" });

      expect(second.coordinator.appState.queue.entries[0]?.track.title).toBe("song-a.flac");
      expect(second.coordinator.appState.queue.shuffle).toBe(true);
      expect(second.coordinator.appState.volume).toEqual({ percent: 61, ready: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
