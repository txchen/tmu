import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDefaultDependencyHealth,
  createLocalProvider,
  type DependencyCommandRequest,
  type DependencyCommandRunner,
} from "../src/index";

describe("LocalProvider", () => {
  test("creates common-extension Tracks with canonical local-path identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));
    const file = join(dir, "amber.flac");
    const requests: DependencyCommandRequest[] = [];
    const runner: DependencyCommandRunner = async (request) => {
      requests.push(request);
      return { exitCode: 0, stdout: JSON.stringify({ format: {} }), stderr: "" };
    };

    try {
      await writeFile(file, "not real audio");
      const provider = createLocalProvider({
        dependencyHealth: createDefaultDependencyHealth(),
        runner,
      });

      const track = await Promise.resolve(provider.createTrackFromCliArg(file));

      expect(track).toMatchObject({
        identity: { providerId: "local", stableId: await realpath(file) },
        title: "amber.flac",
        providerLabel: "Local",
      });
      expect(requests.some((request) => request.args.includes("-select_streams"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("checks local file availability when resolving playback locators", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));
    const file = join(dir, "restored.flac");

    try {
      await writeFile(file, "not real audio");
      const provider = createLocalProvider({
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            ffprobe: { name: "ffprobe", command: "ffprobe", status: "missing" },
          },
          metadata: {
            degraded: true,
            message: "Metadata degraded: ffprobe missing at ffprobe",
          },
        }),
      });

      const track = await provider.createTrackFromCliArg(file);
      const canonicalFile = await realpath(file);

      expect(await provider.resolvePlaybackLocator(track!.identity)).toEqual({ kind: "file", path: canonicalFile });

      await rm(file);

      await expect(provider.resolvePlaybackLocator(track!.identity)).rejects.toThrow(
        `Local file no longer exists: ${canonicalFile}`,
      );
      expect(provider.listVisibleTracks()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dedupes explicit local Track identity through canonical symlink targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));
    const file = join(dir, "cinder.mp3");
    const alias = join(dir, "alias.mp3");

    try {
      await writeFile(file, "not real audio");
      await symlink(file, alias);
      const provider = createLocalProvider({
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            ffprobe: { name: "ffprobe", command: "ffprobe", status: "missing" },
          },
          metadata: {
            degraded: true,
            message: "Metadata degraded: ffprobe missing at ffprobe",
          },
        }),
      });

      const first = await Promise.resolve(provider.createTrackFromCliArg(file));
      const second = await Promise.resolve(provider.createTrackFromCliArg(alias));

      expect(first).toBeDefined();
      expect(second).toBe(first);
      expect(first?.identity.stableId).toBe(await realpath(file));
      expect(provider.listVisibleTracks()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("probes explicit unknown-extension files with ffprobe before enqueueing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));
    const audioFile = join(dir, "mystery");
    const videoFile = join(dir, "not-audio");
    const requests: DependencyCommandRequest[] = [];
    const runner: DependencyCommandRunner = async (request) => {
      requests.push(request);
      if (request.args.includes("-select_streams") && request.args.at(-1) === audioFile) {
        return { exitCode: 0, stdout: JSON.stringify({ streams: [{ codec_type: "audio" }] }), stderr: "" };
      }
      if (request.args.includes("-select_streams")) {
        return { exitCode: 0, stdout: JSON.stringify({ streams: [] }), stderr: "" };
      }
      return { exitCode: 0, stdout: JSON.stringify({ format: {} }), stderr: "" };
    };

    try {
      await writeFile(audioFile, "audio bytes");
      await writeFile(videoFile, "video bytes");
      const provider = createLocalProvider({
        dependencyHealth: createDefaultDependencyHealth(),
        runner,
      });

      const audioTrack = await Promise.resolve(provider.createTrackFromCliArg(audioFile));
      const rejected = await Promise.resolve(provider.createTrackFromCliArg(videoFile));

      expect(audioTrack?.identity.stableId).toBe(await realpath(audioFile));
      expect(rejected).toBeUndefined();
      expect(requests.filter((request) => request.args.includes("-select_streams"))).toHaveLength(2);
      expect(provider.listVisibleTracks().map((track) => track.identity.stableId)).toEqual([
        await realpath(audioFile),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects explicit unknown-extension files when ffprobe metadata is degraded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));
    const file = join(dir, "mystery");
    const requests: DependencyCommandRequest[] = [];
    const runner: DependencyCommandRunner = async (request) => {
      requests.push(request);
      return { exitCode: 0, stdout: JSON.stringify({ streams: [{ codec_type: "audio" }] }), stderr: "" };
    };

    try {
      await writeFile(file, "audio bytes");
      const provider = createLocalProvider({
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            ffprobe: { name: "ffprobe", command: "/missing/ffprobe", status: "missing" },
          },
          metadata: {
            degraded: true,
            message: "Metadata degraded: ffprobe missing at /missing/ffprobe",
          },
        }),
        runner,
      });

      const track = await Promise.resolve(provider.createTrackFromCliArg(file));

      expect(track).toBeUndefined();
      expect(requests).toEqual([]);
      expect(provider.listVisibleTracks()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runs lazy metadata ffprobe work at low concurrency", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));
    const files = [
      join(dir, "one.flac"),
      join(dir, "two.flac"),
      join(dir, "three.flac"),
    ];
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const runner: DependencyCommandRunner = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { exitCode: 0, stdout: JSON.stringify({ format: {} }), stderr: "" };
    };

    try {
      for (const file of files) await writeFile(file, "not real audio");
      const provider = createLocalProvider({
        dependencyHealth: createDefaultDependencyHealth(),
        runner,
        metadataConcurrency: 1,
      });

      await Promise.all(files.map((file) => provider.createTrackFromCliArg(file)));
      await waitFor(() => {
        expect(releases).toHaveLength(1);
      });

      releases.shift()?.();
      await waitFor(() => {
        expect(releases).toHaveLength(1);
      });

      releases.shift()?.();
      await waitFor(() => {
        expect(releases).toHaveLength(1);
      });

      releases.shift()?.();
      await waitFor(() => {
        expect(active).toBe(0);
      });
      expect(maxActive).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recursively opens directories in stable sorted audio-extension order without probing unknown files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));
    const requests: DependencyCommandRequest[] = [];
    const runner: DependencyCommandRunner = async (request) => {
      requests.push(request);
      return { exitCode: 0, stdout: JSON.stringify({ format: {} }), stderr: "" };
    };

    try {
      await mkdir(join(dir, "disc-1"), { recursive: true });
      await mkdir(join(dir, "disc-2"), { recursive: true });
      await writeFile(join(dir, "z-last.mp3"), "audio bytes");
      await writeFile(join(dir, "disc-1", "b-side.wav"), "audio bytes");
      await writeFile(join(dir, "disc-1", "a-side.FLAC"), "audio bytes");
      await writeFile(join(dir, "disc-2", "notes.txt"), "not audio");
      await writeFile(join(dir, "disc-2", "c-side.ogg"), "audio bytes");
      const provider = createLocalProvider({
        dependencyHealth: createDefaultDependencyHealth(),
        runner,
      });

      const result = await provider.createTracksFromOpenPath(dir);

      expect(result.cancelled).toBe(false);
      expect(result.capped).toBe(false);
      expect(result.tracks.map((track) => track.title)).toEqual([
        "a-side.FLAC",
        "b-side.wav",
        "c-side.ogg",
        "z-last.mp3",
      ]);
      expect(requests.some((request) => request.args.includes("-select_streams"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("bounds directory expansion by the configured soft cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));

    try {
      await writeFile(join(dir, "a.mp3"), "audio bytes");
      await writeFile(join(dir, "b.mp3"), "audio bytes");
      await writeFile(join(dir, "c.mp3"), "audio bytes");
      const provider = createLocalProvider({
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            ffprobe: { name: "ffprobe", command: "ffprobe", status: "missing" },
          },
          metadata: {
            degraded: true,
            message: "Metadata degraded: ffprobe missing at ffprobe",
          },
        }),
      });

      const result = await provider.createTracksFromOpenPath(dir, { softCap: 2 });

      expect(result.capped).toBe(true);
      expect(result.tracks.map((track) => track.title)).toEqual(["a.mp3", "b.mp3"]);
      expect(provider.listVisibleTracks().map((track) => track.title)).toEqual(["a.mp3", "b.mp3"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("honors cancellation before directory expansion starts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));
    const controller = new AbortController();
    controller.abort();

    try {
      await writeFile(join(dir, "a.mp3"), "audio bytes");
      const provider = createLocalProvider();

      const result = await provider.createTracksFromOpenPath(dir, { signal: controller.signal });

      expect(result.cancelled).toBe(true);
      expect(result.tracks).toEqual([]);
      expect(provider.listVisibleTracks()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("skips hidden directories unless the hidden directory is explicitly selected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));
    const hidden = join(dir, ".hidden-album");

    try {
      await mkdir(hidden, { recursive: true });
      await writeFile(join(dir, "visible.mp3"), "audio bytes");
      await writeFile(join(hidden, "secret.mp3"), "audio bytes");
      const provider = createLocalProvider({
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            ffprobe: { name: "ffprobe", command: "ffprobe", status: "missing" },
          },
          metadata: {
            degraded: true,
            message: "Metadata degraded: ffprobe missing at ffprobe",
          },
        }),
      });

      const visibleResult = await provider.createTracksFromOpenPath(dir);
      const hiddenResult = await provider.createTracksFromOpenPath(hidden);

      expect(visibleResult.tracks.map((track) => track.title)).toEqual(["visible.mp3"]);
      expect(hiddenResult.tracks.map((track) => track.title)).toEqual(["secret.mp3"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not follow directory symlinks and accepts file symlinks only after resolving regular files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));
    const outside = await mkdtemp(join(tmpdir(), "tmu-local-provider-target-"));

    try {
      await writeFile(join(outside, "target.mp3"), "audio bytes");
      await symlink(outside, join(dir, "linked-dir"));
      await symlink(join(outside, "target.mp3"), join(dir, "linked-file.mp3"));
      const provider = createLocalProvider({
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            ffprobe: { name: "ffprobe", command: "ffprobe", status: "missing" },
          },
          metadata: {
            degraded: true,
            message: "Metadata degraded: ffprobe missing at ffprobe",
          },
        }),
      });

      const result = await provider.createTracksFromOpenPath(dir);

      expect(result.tracks.map((track) => track.identity.stableId)).toEqual([
        await realpath(join(outside, "target.mp3")),
      ]);
      expect(result.tracks.map((track) => track.title)).toEqual(["target.mp3"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("does not create a persistent local index when opening a directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));

    try {
      await writeFile(join(dir, "song.mp3"), "audio bytes");
      const provider = createLocalProvider({
        dependencyHealth: createDefaultDependencyHealth({
          helpers: {
            ffprobe: { name: "ffprobe", command: "ffprobe", status: "missing" },
          },
          metadata: {
            degraded: true,
            message: "Metadata degraded: ffprobe missing at ffprobe",
          },
        }),
      });

      await provider.createTracksFromOpenPath(dir);

      expect(await readdir(dir)).toEqual(["song.mp3"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function waitFor(assertion: () => void, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(5);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
