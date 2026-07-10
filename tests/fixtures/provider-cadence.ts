import { AppCoordinator } from "../../src/coordinator";
import { createDefaultTmuConfig } from "../../src/config";
import type { LocalOpenResult, LocalProvider } from "../../src/providers";
import { main } from "../../src/main";
import { NoopPlayer } from "../../src/player";
import { MemoryQueue } from "../../src/queue";
import { createInitialAppState, createInitialUiState } from "../../src/state";
import type { Track } from "../../src/domain";

let emitProgress = () => undefined;

await main({
  async runtimeFactory() {
    let listener: ((track: Track) => void) | undefined;
    let visibleTrack: Track = track("Provider metadata 0");
    const provider: LocalProvider = {
      id: "local",
      label: "Local",
      hint: "cadence fixture",
      capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["track"], operations: [] },
      getNavigationRoot: () => ({ visible: true, order: 10, detail: "cadence fixture" }),
      listVisibleTracks: () => [visibleTrack],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/dev/null" }),
      createTrackFromPath: async () => undefined,
      createTracksFromOpenPath: async (): Promise<LocalOpenResult> => ({ tracks: [], capped: false, cancelled: false }),
      onTrackMetadataChange(nextListener) {
        listener = nextListener;
        return () => { listener = undefined; };
      },
    };
    const config = createDefaultTmuConfig({ lowPower: { providerProgressThrottleMs: 500 } });
    const queue = new MemoryQueue();
    queue.enqueue(visibleTrack);
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ local: provider }, { config }),
      uiState: createInitialUiState(),
      queue,
      player: new NoopPlayer(),
    });
    emitProgress = () => {
      for (const [delayMs, title] of [[500, "Provider metadata 1"], [550, "Provider metadata 2"], [1_500, "Provider metadata 3"]] as const) {
        setTimeout(() => {
          visibleTrack = track(title);
          listener?.(visibleTrack);
        }, delayMs);
      }
    };
    return { coordinator };
  },
  afterMount() {
    emitProgress();
  },
});

function track(title: string): Track {
  return {
    identity: { providerId: "local", stableId: "/cadence.flac" },
    title,
    providerLabel: "Local",
  };
}
