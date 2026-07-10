import { existsSync } from "node:fs";
import type { Track } from "./domain";

export type PlaybackBenchmarkInput = {
  track: Track;
  playbackLocator: { kind: "file"; path: string };
};

export type PlaybackBenchmarkRun = {
  runtime: string;
  controllerCpuSeconds: number;
  childCpuSeconds: number;
  childInclusiveCpuSeconds: number;
  controllerPeakRssKib: number;
  childPeakRssKib: number;
  elapsedSeconds: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
  playbackCompleted: boolean;
};

type MedianSummary = {
  runs: number;
  controllerCpuSeconds: number;
  childCpuSeconds: number;
  childInclusiveCpuSeconds: number;
  controllerPeakRssKib: number;
  childPeakRssKib: number;
  elapsedSeconds: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
  playbackCompleted: boolean;
};

export function parsePlaybackBenchmarkInput(json: string): PlaybackBenchmarkInput {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || !isTrack(value.track) || !isRecord(value.playbackLocator)
    || value.playbackLocator.kind !== "file" || typeof value.playbackLocator.path !== "string"
    || !existsSync(value.playbackLocator.path)) {
    throw new Error("benchmark input must contain a canonical Track and an existing file Playback Locator");
  }
  return value as PlaybackBenchmarkInput;
}

export function summarizePlaybackBenchmarkRuns(
  runs: readonly PlaybackBenchmarkRun[],
): Record<string, MedianSummary> {
  const runtimes = new Set(runs.map((run) => run.runtime));
  return Object.fromEntries([...runtimes].map((runtime) => {
    const matching = runs.filter((run) => run.runtime === runtime);
    return [runtime, {
      runs: matching.length,
      controllerCpuSeconds: median(matching.map((run) => run.controllerCpuSeconds)),
      childCpuSeconds: median(matching.map((run) => run.childCpuSeconds)),
      childInclusiveCpuSeconds: median(matching.map((run) => run.childInclusiveCpuSeconds)),
      controllerPeakRssKib: median(matching.map((run) => run.controllerPeakRssKib)),
      childPeakRssKib: median(matching.map((run) => run.childPeakRssKib)),
      elapsedSeconds: median(matching.map((run) => run.elapsedSeconds)),
      voluntaryContextSwitches: median(matching.map((run) => run.voluntaryContextSwitches)),
      involuntaryContextSwitches: median(matching.map((run) => run.involuntaryContextSwitches)),
      playbackCompleted: matching.every((run) => run.playbackCompleted),
    }];
  }));
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  if (ordered.length === 0) return Number.NaN;
  return ordered.length % 2 === 1
    ? ordered[middle]!
    : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function isTrack(value: unknown): value is Track {
  return isRecord(value)
    && isRecord(value.identity)
    && typeof value.identity.providerId === "string"
    && typeof value.identity.stableId === "string"
    && typeof value.title === "string"
    && typeof value.providerLabel === "string"
    && (value.artist === undefined || typeof value.artist === "string")
    && (value.durationSeconds === undefined || (typeof value.durationSeconds === "number" && Number.isFinite(value.durationSeconds)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
