# Source Switcher And Navigation Shell Prototype Notes

## Question

What should the MVP TUI shell look and feel like for switching between Local,
Navidrome, Offline YouTube Cache, YouTube URL Download, and the shared Queue?

## Prototype

Asset: `prototype.ts`

The prototype provides three terminal shell variants:

- Variant A: source rail, content pane, persistent queue/player strip
- Variant B: queue-first shell with source tabs below the now-playing region
- Variant C: command-palette shell with compact source actions

It supports empty startup, CLI-seeded queue startup, provider switching, queue
view, adding provider items to the shared queue, and a YouTube URL download
intent placeholder.

## Verdict

Use Variant A as the MVP baseline: a source rail, a provider browsing surface,
and a persistent queue/player strip.

Why:

- It makes the Queue-First MVP visible without turning the Queue into a separate
  app the user must navigate away to inspect.
- It handles empty startup naturally: open on the source switcher, or the last
  selected provider once that preference exists.
- It handles CLI-seeded startup naturally: start with the Queue focused and the
  seeded tracks playing/ready, while keeping sources one key away.
- It keeps Local, Navidrome, Offline YouTube Cache, and YouTube URL Download as
  sibling source surfaces that all feed one shared Queue.
- It preserves the Low-Power TUI decision: render on input/state changes, with
  no animated shell requirement.

Variant B is useful as an expanded Queue view, especially for CLI-seeded
sessions, but should not be the default shell because it makes provider browsing
feel secondary. Variant C is useful as a future command palette, but it is too
abstract as the primary MVP navigation model.

Local verification:

- `bun .scratch/lean-tui-music-player/prototypes/11-source-switcher-navigation-shell/prototype.ts --snapshot`
- PTY smoke test with `--seed ./song-a.flac ./song-b.mp3`, batched keys
  `v2aq`, and clean quit.
