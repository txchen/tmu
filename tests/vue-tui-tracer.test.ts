import { afterEach, describe, expect, test } from "bun:test";
import { render, cleanup } from "@vue-tui/testing";
import { createVueTuiTracer } from "../src/prototypes/vue-tui-tracer/component";
import {
  DevelopmentTracerPlayer,
  createDevelopmentTracerRuntime,
  developmentTracerTrack,
} from "../src/prototypes/vue-tui-tracer/app";

afterEach(() => cleanup());

async function developmentTracerHarness() {
  const player = new DevelopmentTracerPlayer();
  const { coordinator } = await createDevelopmentTracerRuntime({ player });
  return { coordinator, player };
}

describe("development-only vue-tui tracer", () => {
  test("restores Queue Home without autoplay, resumes through registry dispatch, and traps overlay input", async () => {
    const { coordinator, player } = await developmentTracerHarness();
    const terminal = await render(createVueTuiTracer({ coordinator }), { columns: 120, rows: 24 });

    expect(terminal.lastFrame()).toContain("Queue Home · wide");
    expect(terminal.lastFrame()).toContain("Restored Track");
    expect(terminal.lastFrame()).toContain("Restored — Space to Resume");
    expect(player.toggles).toBe(0);

    await terminal.stdin.write(" ");
    expect(player.toggles).toBe(1);
    expect(terminal.lastFrame()).toContain("Playing");

    await terminal.stdin.write("o");
    expect(terminal.lastFrame()).toContain("Picker Overlay · music-picker");
    await terminal.stdin.write(" ");
    expect(player.toggles).toBe(1);
    await terminal.stdin.write("q");
    expect(terminal.lastFrame()).not.toContain("Picker Overlay");
    expect(terminal.lastFrame()).toContain("Restored Track");
  });

  test("crosses responsive tiers without losing Current Track, Track Identity selection, or overlay state", async () => {
    const { coordinator } = await developmentTracerHarness();
    const terminal = await render(createVueTuiTracer({ coordinator }), { columns: 120, rows: 24 });
    await terminal.stdin.write("o");

    for (const [columns, rows, tier] of [
      [100, 24, "medium"],
      [70, 24, "narrow"],
      [50, 14, "terminal-too-small"],
      [130, 30, "wide"],
    ] as const) {
      await terminal.terminal.resize(columns, rows);
      await terminal.waitUntilRenderFlush();
      expect(coordinator.uiState.terminal.tier).toBe(tier);
      expect(coordinator.uiState.selectedQueueIdentity).toEqual(developmentTracerTrack.identity);
      expect(coordinator.appState.playback.currentTrackIdentity).toEqual(developmentTracerTrack.identity);
      expect(coordinator.uiState.overlays.at(-1)?.kind).toBe("music-picker");
    }
  });

  test("does not redraw while idle or for playback-position-only publications", async () => {
    const { coordinator, player } = await developmentTracerHarness();
    const terminal = await render(createVueTuiTracer({ coordinator }), { columns: 120, rows: 24 });
    const initialFrames = terminal.frames.length;

    await Bun.sleep(80);
    expect(terminal.frames).toHaveLength(initialFrames);

    await terminal.stdin.write(" ");
    const playingFrames = terminal.frames.length;
    player.publishPosition(1);
    await Bun.sleep(80);
    expect(terminal.frames).toHaveLength(playingFrames);
  });
});
