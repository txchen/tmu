# PROTOTYPE - Low-Power TUI Rendering

Question: can TMU's foreground UI feel responsive while rendering only on input,
state changes, and coarse playback ticks rather than on a continuous visualizer
loop?

Run the interactive prototype:

```sh
bun .scratch/lean-tui-music-player/prototypes/08-low-power-tui-rendering/prototype.ts
```

Run the measurement mode:

```sh
bun .scratch/lean-tui-music-player/prototypes/08-low-power-tui-rendering/prototype.ts --bench
```

Keys in interactive mode:

- `tab` changes focus between Sources, Tracks, and Queue
- Arrow keys move within the focused list
- `enter` enqueues the selected track or starts the selected queue item
- `space` toggles play/pause
- `n` advances to the next queued track
- `t` toggles playback-position ticks on or off
- `q` quits

This code is intentionally dependency-free and disposable. It is not a chosen
production TUI framework; it isolates the render cadence decision for Bun and
terminal output.
