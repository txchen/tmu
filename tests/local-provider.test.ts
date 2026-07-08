import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
