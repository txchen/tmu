# PROTOTYPE - Bun mpv Controller

Question: can Bun reliably control a long-lived audio-only `mpv` subprocess over
JSON IPC for TMU's MVP playback controls?

Run the scripted smoke test:

```sh
bun .scratch/lean-tui-music-player/prototypes/13-bun-mpv-controller/prototype.ts
```

Run an interactive shell around the same controller:

```sh
bun .scratch/lean-tui-music-player/prototypes/13-bun-mpv-controller/prototype.ts --interactive
```

Interactive keys:

- `l` load the generated sample
- `p` pause/resume
- `s` stop
- `[` seek back
- `]` seek forward
- `-` volume down
- `+` volume up
- `q` quit and tear down mpv

The prototype generates a short WAV file under `/tmp`, starts `mpv` with
`--idle=yes`, `--terminal=no`, `--vid=no`, `--audio-display=no`, and controls it
through a Unix IPC socket. It is disposable; keep only the decision.
