# Choose Audio Playback And Decode Strategy

Type: research
Status: resolved
Blocked by: 02

## Question

What subprocess-centered playback strategy should Bun-based TMU use for local files, Navidrome streams, and offline YouTube downloads?

Evaluate mpv, ffmpeg/ffplay, gstreamer, or another external player/decoder controlled from Bun. Cover local file playback, Navidrome stream URLs, cached YouTube downloads, seeking, volume, metadata/duration accuracy, cancellation, progress reporting, cross-platform dependencies, packaging, and idle CPU behavior.

## Answer

Research note: [Choose Audio Playback And Decode Strategy](../research/04-choose-audio-playback-and-decode-strategy.md).

Choose a long-lived **mpv** subprocess as TMU's primary playback engine, controlled from Bun/TypeScript through mpv JSON IPC. Use **ffprobe** as a short-lived metadata/duration helper when provider or cache metadata is missing or needs verification.

Playback shape:

- Start one `mpv` process in audio-only idle mode with `--idle=yes`, `--terminal=no`, `--vid=no`, `--audio-display=no`, and `--input-ipc-server=<path>`.
- Use mpv `loadfile` for all MVP playback inputs: local files, Navidrome authenticated stream URLs, and cached YouTube downloads.
- Use mpv JSON IPC for pause/resume, stop, seek, volume, observed properties, progress, end-of-track, and error/exit handling.
- Keep provider/cache metadata as the source of truth for lists and display. Use mpv runtime properties for current playback state and `ffprobe` for local/cached file verification.
- For cancellation, prefer mpv stop/load replacement during normal control and Bun process kill/reap on teardown or broken IPC.

Rejected for the MVP:

- `ffplay`: usable for manual debugging, but lacks a documented JSON request/reply/property observation control surface comparable to mpv.
- `ffmpeg` as primary decoder/player: powerful but would force TMU to own PCM, buffering, audio output, seek behavior, and more process cleanup.
- GStreamer subprocesses: strong media framework, but `gst-launch` is a pipeline launcher, not a stable TUI playback-control protocol; native bindings/custom helper would add too much packaging and platform work.

Dependency policy:

- Required runtime dependency: `mpv`.
- Recommended helper dependency: `ffprobe`.
- Not required for MVP playback: `ffplay`, GStreamer, native audio bindings, in-process EQ/DSP, or live YouTube streaming.

Local verification: this workspace has `/usr/bin/mpv`, `/usr/bin/ffmpeg`, `/usr/bin/ffplay`, `gst-launch-1.0`, Bun 1.3.11, and yt-dlp 2026.03.17. A local smoke test successfully started `mpv --idle=yes --terminal=no --no-video --audio-display=no --input-ipc-server=<socket>` and queried `idle-active` over JSON IPC.
