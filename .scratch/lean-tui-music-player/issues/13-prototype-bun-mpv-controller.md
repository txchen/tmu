# Prototype Bun mpv Controller

Type: prototype
Status: open
Blocked by: 04

## Question

Can Bun reliably control a long-lived audio-only `mpv` subprocess over JSON IPC for TMU's MVP playback controls?

Build the smallest controller prototype that starts `mpv` idle with an IPC socket, sends `loadfile`, observes `time-pos`, `duration`, `pause`, `idle-active`, and `eof-reached`, supports pause/resume, stop, seek, volume, and teardown, and reports process/IPC errors cleanly. Use a local audio file or generated short sample if needed.
