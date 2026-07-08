# Prototype Bun mpv Controller

Type: prototype
Status: resolved
Blocked by: 04

## Question

Can Bun reliably control a long-lived audio-only `mpv` subprocess over JSON IPC for TMU's MVP playback controls?

Build the smallest controller prototype that starts `mpv` idle with an IPC socket, sends `loadfile`, observes `time-pos`, `duration`, `pause`, `idle-active`, and `eof-reached`, supports pause/resume, stop, seek, volume, and teardown, and reports process/IPC errors cleanly. Use a local audio file or generated short sample if needed.

## Answer

Prototype asset: [Bun mpv Controller Prototype](../prototypes/13-bun-mpv-controller/README.md).

Bun can reliably control a long-lived audio-only `mpv` subprocess over JSON IPC for TMU's MVP playback boundary.

Validated controller shape:

```text
Bun App Coordinator
  -> MpvController
      -> long-lived mpv --idle=yes --terminal=no --vid=no --audio-display=no
      -> newline-delimited JSON IPC over Unix socket
```

The prototype generated a short WAV file, started `mpv` idle, connected through a Unix IPC socket, sent `loadfile`, observed playback properties, exercised pause/resume, seek, volume, stop, EOF, and teardown, and reported process/IPC errors through controller state.

Local smoke result from `bun .scratch/lean-tui-music-player/prototypes/13-bun-mpv-controller/prototype.ts`:

| Field | Value |
| --- | --- |
| connected | true |
| observedDuration | 2.500 |
| observedTimePos | 0.245 |
| pause after resume | false |
| eofReached | true |
| volume | 35 |
| lastError | none |

Implementation decisions:

- Start one long-lived mpv process with `--idle=yes`, `--terminal=no`, `--vid=no`, `--audio-display=no`, and `--input-ipc-server=<socket>`.
- Use request IDs and command timeouts for JSON IPC replies.
- Observe `time-pos`, `duration`, `pause`, `idle-active`, and `eof-reached`, but treat mpv's `end-file` event as the reliable EOF signal. In local testing, the initial `eof-reached` property update carried `undefined`, while `end-file` produced the useful transition.
- Keep command failures local to the controller state. A failed command must not prevent later commands or teardown.
- Teardown should try mpv `quit`, destroy the IPC socket, kill/reap the process if needed, and remove the socket path.

Interactive verification: `--interactive` opened in a PTY, accepted control keys, handled a command-before-load path, and exited cleanly with no leftover prototype or mpv process.
