# Low-Power TUI Rendering Prototype Notes

## Question

Can TMU's foreground UI feel responsive while rendering only on input, state
changes, and coarse playback ticks rather than on a continuous visualizer-style
loop?

## Prototype

Asset: `prototype.ts`

The prototype is a dependency-free Bun/TypeScript terminal UI with:

- source list
- track list
- current track and progress display
- shared queue
- keyboard navigation
- a runtime toggle for playback-position ticks
- benchmark mode comparing event-only idle rendering with 500ms progress ticks

## Measurement

Run:

```sh
bun .scratch/lean-tui-music-player/prototypes/08-low-power-tui-rendering/prototype.ts --bench
```

Latest local run:

| Scenario | Wall ms | CPU ms | CPU % | Renders | Bytes rendered |
| --- | ---: | ---: | ---: | ---: | ---: |
| event-only idle | 6002 | 11.9 | 0.20 | 1 | 687 |
| 500ms progress ticks | 6000 | 58.1 | 0.97 | 13 | 8958 |

The interactive prototype was also smoke-tested in a PTY and accepted `q` to
quit cleanly.

## Verdict

The low-power model is viable for the MVP. A Bun/TypeScript terminal UI can keep
the full foreground layout responsive with renders triggered by input, state
changes, and 500ms playback-position ticks. Event-only idle mode renders once
and then sleeps; the 500ms playing cadence kept redraws bounded to roughly two
per second in this prototype.

The production TUI should make render scheduling an explicit boundary:

- No continuous visualizer, EQ, animation, or fixed 30/60 FPS loop in the MVP.
- Redraw immediately on user input and playback/provider state changes.
- While playing, redraw progress on a coarse 500ms cadence unless mpv property
  events already provide sufficient updates.
- While idle or paused, stop progress ticks and render only on state changes.
- Keep provider/download progress throttled independently, with a target no
  faster than 2 Hz for ordinary status updates.
