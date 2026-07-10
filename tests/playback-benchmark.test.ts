import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  parsePlaybackBenchmarkInput,
  summarizePlaybackBenchmarkRuns,
} from "../src/playback-benchmark";

describe("playback benchmark", () => {
  test("accepts a canonical Track with its resolved local Playback Locator", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tmu-benchmark-input-"));
    const mediaPath = join(directory, "track.webm");
    await writeFile(mediaPath, "media");

    expect(parsePlaybackBenchmarkInput(JSON.stringify({
      track: {
        identity: { providerId: "youtube-cache", stableId: "abc123" },
        title: "Amber",
        providerLabel: "YouTube Cache",
        artist: "Cinder",
        durationSeconds: 172.241,
      },
      playbackLocator: { kind: "file", path: mediaPath },
    }))).toEqual({
      track: {
        identity: { providerId: "youtube-cache", stableId: "abc123" },
        title: "Amber",
        providerLabel: "YouTube Cache",
        artist: "Cinder",
        durationSeconds: 172.241,
      },
      playbackLocator: { kind: "file", path: mediaPath },
    });
  });

  test("reports raw runs and median controller and child-inclusive metrics separately", () => {
    const runs = [
      { runtime: "runtime-a", controllerCpuSeconds: 3, childCpuSeconds: 5, childInclusiveCpuSeconds: 8, controllerPeakRssKib: 40, childPeakRssKib: 20, elapsedSeconds: 10, voluntaryContextSwitches: 6, involuntaryContextSwitches: 3, playbackCompleted: true },
      { runtime: "node", controllerCpuSeconds: 1, childCpuSeconds: 4, childInclusiveCpuSeconds: 5, controllerPeakRssKib: 50, childPeakRssKib: 20, elapsedSeconds: 10, voluntaryContextSwitches: 2, involuntaryContextSwitches: 1, playbackCompleted: true },
      { runtime: "runtime-a", controllerCpuSeconds: 2, childCpuSeconds: 5, childInclusiveCpuSeconds: 7, controllerPeakRssKib: 42, childPeakRssKib: 20, elapsedSeconds: 10, voluntaryContextSwitches: 5, involuntaryContextSwitches: 2, playbackCompleted: true },
      { runtime: "node", controllerCpuSeconds: 0.5, childCpuSeconds: 4, childInclusiveCpuSeconds: 4.5, controllerPeakRssKib: 52, childPeakRssKib: 20, elapsedSeconds: 10, voluntaryContextSwitches: 3, involuntaryContextSwitches: 1, playbackCompleted: true },
      { runtime: "runtime-a", controllerCpuSeconds: 4, childCpuSeconds: 5, childInclusiveCpuSeconds: 9, controllerPeakRssKib: 44, childPeakRssKib: 20, elapsedSeconds: 10, voluntaryContextSwitches: 7, involuntaryContextSwitches: 4, playbackCompleted: true },
      { runtime: "node", controllerCpuSeconds: 1.5, childCpuSeconds: 4, childInclusiveCpuSeconds: 5.5, controllerPeakRssKib: 54, childPeakRssKib: 20, elapsedSeconds: 10, voluntaryContextSwitches: 4, involuntaryContextSwitches: 2, playbackCompleted: true },
    ] as const;

    expect(summarizePlaybackBenchmarkRuns(runs)).toEqual({
      "runtime-a": { runs: 3, controllerCpuSeconds: 3, childCpuSeconds: 5, childInclusiveCpuSeconds: 8, controllerPeakRssKib: 42, childPeakRssKib: 20, elapsedSeconds: 10, voluntaryContextSwitches: 6, involuntaryContextSwitches: 3, playbackCompleted: true },
      node: { runs: 3, controllerCpuSeconds: 1, childCpuSeconds: 4, childInclusiveCpuSeconds: 5, controllerPeakRssKib: 52, childPeakRssKib: 20, elapsedSeconds: 10, voluntaryContextSwitches: 3, involuntaryContextSwitches: 1, playbackCompleted: true },
    });
  });
});
