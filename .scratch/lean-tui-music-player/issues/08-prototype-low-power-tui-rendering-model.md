# Prototype Low-Power TUI Rendering Model

Type: prototype
Status: resolved
Blocked by: 01, 02

## Question

Can TMU's foreground UI feel responsive while rendering only on input, state changes, and coarse playback ticks rather than on a continuous visualizer-style loop?

Build the smallest possible Bun/TypeScript prototype in the chosen UI stack that has a source list, track list, queue/current-track region, progress display, and keyboard navigation. Measure idle CPU and redraw behavior with and without playback-position ticks.

## Answer

Prototype asset: [Low-Power TUI Rendering Prototype](../prototypes/08-low-power-tui-rendering/README.md).

The low-power TUI model is viable for TMU's MVP. A dependency-free Bun/TypeScript terminal prototype rendered the required source list, track list, current/progress region, queue region, and keyboard navigation without a continuous loop. Rendering can be driven by user input, state changes, and an optional coarse playback-position tick.

Local measurement from `bun .scratch/lean-tui-music-player/prototypes/08-low-power-tui-rendering/prototype.ts --bench`:

| Scenario | Wall ms | CPU ms | CPU % | Renders | Bytes rendered |
| --- | ---: | ---: | ---: | ---: | ---: |
| event-only idle | 6002 | 11.9 | 0.20 | 1 | 687 |
| 500ms progress ticks | 6000 | 58.1 | 0.97 | 13 | 8958 |

Decision:

- Use an event-driven TUI render scheduler for the MVP.
- Redraw immediately on input and provider/player state changes.
- While playing, allow a coarse 500ms progress tick if mpv property events are not enough.
- While idle or paused, stop progress ticks and render only on state changes.
- Keep visualizers, EQ displays, animation loops, and fixed 30/60 FPS rendering out of the MVP.
- Throttle download/provider progress updates separately, targeting no faster than 2 Hz for ordinary status output.

The prototype does not choose a production TUI framework. It proves the cadence and state shape; the production framework should be accepted only if TMU can preserve this explicit render-scheduling boundary.
