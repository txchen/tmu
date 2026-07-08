# PROTOTYPE - Source Switcher And Navigation Shell

Question: what should the MVP TUI shell look and feel like for switching
between Local, Navidrome, Offline YouTube Cache, YouTube URL Download, and the
shared Queue?

Run the interactive prototype:

```sh
bun .scratch/lean-tui-music-player/prototypes/11-source-switcher-navigation-shell/prototype.ts
```

Run it as if CLI args seeded the queue:

```sh
bun .scratch/lean-tui-music-player/prototypes/11-source-switcher-navigation-shell/prototype.ts --seed ./song-a.flac ./song-b.mp3
```

Print static snapshots of all variants:

```sh
bun .scratch/lean-tui-music-player/prototypes/11-source-switcher-navigation-shell/prototype.ts --snapshot
```

Keys:

- `v` cycles layout variants
- `1`-`5` jumps to Local, Navidrome, Offline Cache, YouTube URL, or Queue
- `tab` changes focus inside the shell
- Arrow keys move the focused selection
- `enter` or `a` adds the selected item to the queue or starts the selected queue item
- `p` toggles play/pause
- `n` advances the current queue item
- `q` quits

This is throwaway code. It compares navigation models; it is not production UI.
