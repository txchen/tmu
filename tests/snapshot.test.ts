import { describe, expect, test } from "vitest";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
          identity: { providerId: "youtube-cache", stableId: "song-1" },
          title: "Cached Track",
          providerLabel: "YouTube Cache",
        },
      },
    ],
    currentIndex: 0,
    repeatAll: false,
    volume: { percent: 88, ready: true },
    positionSeconds: 42,
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

  test("restores supported version-1 snapshots that contain obsolete shuffle state without retaining it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-snapshot-legacy-shuffle-"));
    const file = join(dir, "last-queue.json");
    const persistence = new FileLastQueueSnapshotPersistence(file);
    try {
      await writeFile(file, JSON.stringify({ ...snapshot(), shuffle: true }));

      const restored = await persistence.load();

      expect(restored).toEqual(snapshot());
      expect(restored).not.toHaveProperty("shuffle");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serializes only durable Track Identity and display metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-snapshot-"));
    const file = join(dir, "last-queue.json");
    const queue = new MemoryQueue();
    const trackWithRuntimeField = {
      identity: { providerId: "youtube-cache", stableId: "song-secret" },
      title: "Cached Secret",
      providerLabel: "YouTube Cache",
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
      expect(raw).not.toContain("shuffle");
      expect(loaded?.entries[0]?.track).toEqual({
        identity: { providerId: "youtube-cache", stableId: "song-secret" },
        title: "Cached Secret",
        providerLabel: "YouTube Cache",
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
      await writeFile(file, "{not-json");
      expect(await persistence.load()).toBeNull();
      expect((await readdir(dir)).some((name) => /^last-queue\.json\.corrupt-\d{8}T\d{6}\d{3}Z-/.test(name))).toBe(true);
      expect(persistence.drainRecoveryMessages()).toHaveLength(1);
      expect(persistence.drainRecoveryMessages()).toEqual([]);
      const nextLaunch = new FileLastQueueSnapshotPersistence(file);
      expect(await nextLaunch.load()).toBeNull();
      expect(nextLaunch.wasLastLoadQuarantined()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("quarantines unsupported and partially invalid snapshots instead of accepting partial state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-snapshot-invalid-"));
    const file = join(dir, "last-queue.json");

    try {
      for (const invalid of [
        { ...snapshot(), version: 2 },
        { ...snapshot(), currentIndex: 4 },
        { ...snapshot(), volume: { percent: 101, ready: true } },
        { ...snapshot(), positionSeconds: -1 },
      ]) {
        await writeFile(file, JSON.stringify(invalid));
        const persistence = new FileLastQueueSnapshotPersistence(file);
        expect(await persistence.load()).toBeNull();
        expect(persistence.wasLastLoadQuarantined()).toBe(true);
      }
      expect((await readdir(dir)).filter((name) => name.includes(".corrupt-"))).toHaveLength(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("blocks replacement after invalid data even when the corrupt file cannot be moved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-snapshot-unmovable-"));
    const file = join(dir, "last-queue.json");
    try {
      await writeFile(file, "{invalid");
      await chmod(dir, 0o555);
      const persistence = new FileLastQueueSnapshotPersistence(file);
      expect(await persistence.load()).toBeNull();
      expect(persistence.wasLastLoadQuarantined()).toBe(true);
      await expect(access(file)).resolves.toBeUndefined();
    } finally {
      await chmod(dir, 0o755).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runtime uses file-backed Last Queue Snapshot persistence across app instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-runtime-snapshot-"));
    const configPath = join(dir, "config.json");
    const snapshotPath = join(dir, "last-queue.json");
    const preferencesPath = join(dir, "preferences.json");
    const runner: DependencyCommandRunner = async ({ helper }) => ({
      exitCode: 0,
      stdout: `${helper} 1.0\n`,
      stderr: "",
    });
    let first: Awaited<ReturnType<typeof createTmuRuntime>> | undefined;
    let second: Awaited<ReturnType<typeof createTmuRuntime>> | undefined;

    try {
      await writeFile(configPath, JSON.stringify({
        persistence: {
          lastQueueSnapshotPath: snapshotPath,
          appPreferencesPath: preferencesPath,
        },
      }));

      first = await createTmuRuntime({ configPath, dependencyRunner: runner });
      await first.coordinator.start();
      await first.coordinator.dispatch({ type: "playNext", target: {
        identity: { providerId: "youtube-cache", stableId: "song-a" },
        title: "Cached Song A",
        providerLabel: "YouTube Cache",
      } });
      await first.coordinator.dispatch({ type: "playerOperation", operation: "set-volume", percent: 61, ready: true });
      await first.coordinator.teardown();
      first = undefined;

      second = await createTmuRuntime({ configPath, dependencyRunner: runner });
      await second.coordinator.start();

      expect(second.coordinator.appState.queue.entries[0]?.track.title).toBe("Cached Song A");
      expect(second.coordinator.appState.volume).toEqual({ percent: 61, ready: true });
    } finally {
      await first?.coordinator.teardown();
      await second?.coordinator.teardown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runtime creation does not check helpers eagerly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-runtime-lazy-dependencies-"));
    const configPath = join(dir, "config.json");
    const checked: string[] = [];
    let runtime: Awaited<ReturnType<typeof createTmuRuntime>> | undefined;

    try {
      await writeFile(configPath, JSON.stringify({
        persistence: {
          lastQueueSnapshotPath: join(dir, "last-queue.json"),
          appPreferencesPath: join(dir, "preferences.json"),
        },
      }));
      runtime = await createTmuRuntime({
        configPath,
        startPlayer: false,
        dependencyRunner: async ({ helper }) => {
          checked.push(helper);
          return { exitCode: 0, stdout: `${helper} 1.0\n`, stderr: "" };
        },
      });
      expect(checked).toEqual([]);
    } finally {
      await runtime?.coordinator.teardown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runtime opens on Playback and restores the full Last Queue Snapshot without autoplay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-runtime-full-restore-"));
    const configPath = join(dir, "config.json");
    const snapshotPath = join(dir, "last-queue.json");
    const preferencesPath = join(dir, "preferences.json");
    const runner: DependencyCommandRunner = async ({ helper }) => ({
      exitCode: 0, stdout: `${helper} 1.0\n`, stderr: "",
    });
    let runtime: Awaited<ReturnType<typeof createTmuRuntime>> | undefined;
    try {
      await writeFile(configPath, JSON.stringify({
        persistence: { lastQueueSnapshotPath: snapshotPath, appPreferencesPath: preferencesPath },
      }));
      await new FileLastQueueSnapshotPersistence(snapshotPath).save({ ...snapshot(), repeatAll: true });

      runtime = await createTmuRuntime({ configPath, dependencyRunner: runner, startPlayer: false });
      await runtime.coordinator.start();

      expect(runtime.coordinator.uiState.activeTab).toBe("playback");
      expect(runtime.coordinator.appState.queue).toMatchObject({ currentIndex: 0, repeatAll: true });
      expect(runtime.coordinator.appState.queue.entries[0]?.track.title).toBe("Cached Track");
      expect(runtime.coordinator.appState.playback).toMatchObject({
        status: "paused", positionSeconds: 42, currentTrackIdentity: snapshot().entries[0]?.track.identity,
      });
      expect(runtime.coordinator.appState.volume).toEqual({ percent: 88, ready: true });
    } finally {
      await runtime?.coordinator.teardown();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stored volume preference takes precedence over the queue snapshot volume", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-runtime-volume-preference-"));
    const configPath = join(dir, "config.json");
    const snapshotPath = join(dir, "last-queue.json");
    const preferencesPath = join(dir, "preferences.json");
    let runtime: Awaited<ReturnType<typeof createTmuRuntime>> | undefined;
    try {
      await writeFile(configPath, JSON.stringify({
        persistence: { lastQueueSnapshotPath: snapshotPath, appPreferencesPath: preferencesPath },
      }));
      await new FileLastQueueSnapshotPersistence(snapshotPath).save({
        ...snapshot(), volume: { percent: 100, ready: false },
      });
      await writeFile(preferencesPath, JSON.stringify({
        version: 1, volume: { percent: 37, ready: true },
      }));

      runtime = await createTmuRuntime({ configPath, startPlayer: false });
      await runtime.coordinator.start();

      expect(runtime.coordinator.appState.volume).toEqual({ percent: 37, ready: true });
      await runtime.coordinator.dispatch({ type: "playerOperation", operation: "adjust-volume", delta: 5 });
      expect(runtime.coordinator.appState.volume).toEqual({ percent: 42, ready: true });
    } finally {
      await runtime?.coordinator.teardown();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
