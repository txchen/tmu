# Define Source Switcher And Navigation Shell

Type: prototype
Status: resolved
Blocked by: 02, 08

## Question

What should the MVP TUI shell look and feel like for switching between Local, Navidrome, Offline YouTube Cache, YouTube URL Download, and the shared queue?

Prototype the minimum navigation model after the language/runtime and low-power rendering model are chosen. It must cover startup without CLI args, startup with CLI args seeding the queue, moving between provider views and playback/queue view, and adding items without turning each provider into a separate app.

## Answer

Prototype asset: [Source Switcher And Navigation Shell Prototype](../prototypes/11-source-switcher-navigation-shell/README.md).

Use a source-rail shell with a provider browsing surface and persistent queue/player strip as the MVP baseline.

Recommended shell:

```text
Sources rail -> Provider Browsing Surface
             -> Persistent Queue / Player strip
```

Startup behavior:

- Without CLI args, open on the source switcher, or the last selected provider once that preference exists.
- With CLI args, seed the shared Queue with local Tracks and focus the Queue/player region immediately.
- Keep sources visible or one key away even when CLI args start playback, so the app does not feel like a one-shot file player.

Navigation model:

- Treat Local, Navidrome, Offline YouTube Cache, YouTube URL Download, and Queue as sibling source targets.
- Local, Navidrome, and Offline YouTube Cache browse provider-specific surfaces that enqueue Tracks.
- YouTube URL Download is an action/prompt surface: paste URL, download into Offline YouTube Cache, then enqueue the cached Track.
- Queue is always visible as the persistent player/queue strip, and can also expand into a focused Queue view for reordering/removing/starting items.
- Provider views should never own separate queues or separate playback models.

Rejected as default shell:

- A queue-first layout is useful as an expanded Queue view, especially when CLI args seeded playback, but it makes provider browsing feel secondary if used as the default shell.
- A command-palette layout is useful later for fast commands, but it is too abstract as the primary MVP navigation model.

Local verification:

- `bun .scratch/lean-tui-music-player/prototypes/11-source-switcher-navigation-shell/prototype.ts --snapshot`
- PTY smoke test with `--seed ./song-a.flac ./song-b.mp3`, batched keys `v2aq`, and clean quit.
