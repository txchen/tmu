# Bun mpv Controller Prototype Notes

## Question

Can Bun reliably control a long-lived audio-only `mpv` subprocess over JSON IPC
for TMU's MVP playback controls?

## Prototype

Asset: `prototype.ts`

The prototype:

- generates a short local WAV sample
- starts a long-lived idle `mpv` subprocess
- connects to mpv JSON IPC over a Unix socket
- observes `time-pos`, `duration`, `pause`, `idle-active`, and `eof-reached`
- exercises `loadfile`, pause/resume, seek, volume, stop, and teardown
- reports process and IPC failures as structured controller errors

## Verdict

Bun can reliably control a long-lived audio-only `mpv` subprocess over JSON IPC
for the MVP playback boundary.

Local smoke test:

```sh
bun .scratch/lean-tui-music-player/prototypes/13-bun-mpv-controller/prototype.ts
```

Observed result:

| Field | Value |
| --- | --- |
| connected | true |
| observedDuration | 2.500 |
| observedTimePos | 0.245 |
| pause after resume | false |
| eofReached | true |
| volume | 35 |
| lastError | none |

Interactive PTY check:

- Started with `--interactive`
- Sent a command sequence including a command before load and `q`
- Confirmed teardown still ran and no prototype/mpv process was left running

Decision notes:

- Use one long-lived `mpv` process in idle mode, controlled over JSON IPC.
- Use newline-delimited request/reply JSON with request IDs and a timeout per
  command.
- Observe `time-pos`, `duration`, `pause`, `idle-active`, and `eof-reached`, but
  treat the `end-file` event as the reliable EOF signal. In local testing,
  `eof-reached` initially emitted `undefined`, while `end-file` gave the useful
  transition.
- Serialize controller commands at the App Coordinator boundary. A command error
  must be recorded without poisoning teardown or later commands.
- Teardown should attempt mpv `quit`, destroy the socket, kill/reap the process
  if needed, and remove the IPC socket path.
