# Prototype Low-Power TUI Rendering Model

Type: prototype
Status: open
Blocked by: 01, 02

## Question

Can TMU's foreground UI feel responsive while rendering only on input, state changes, and coarse playback ticks rather than on a continuous visualizer-style loop?

Build the smallest possible Bun/TypeScript prototype in the chosen UI stack that has a source list, track list, queue/current-track region, progress display, and keyboard navigation. Measure idle CPU and redraw behavior with and without playback-position ticks.
