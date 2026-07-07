# Choose Audio Playback And Decode Strategy

Research date: 2026-07-07

## Recommendation

Use **mpv as the primary long-lived playback subprocess**, controlled from Bun/TypeScript through mpv's JSON IPC protocol. Use **ffprobe as a short-lived metadata/duration probe helper** where provider metadata is missing or cached-download metadata needs verification. Do **not** build the MVP around ffplay, ffmpeg-as-decoder, or GStreamer subprocesses.

This fits Bun because Bun documents direct subprocess spawning and process control through `Bun.spawn`, including configurable stdio, stdout/stderr readers, process exit handling, and `kill()` for termination ([Bun child process docs](https://bun.com/docs/runtime/child-process)). It fits mpv because mpv documents a JSON IPC command surface over `--input-ipc-server`, including request/reply messages, events, `get_property`, `set_property`, `observe_property`, and player commands such as `loadfile` and `seek` ([mpv JSON IPC](https://mpv.io/manual/stable/#json-ipc), [mpv commands](https://mpv.io/manual/stable/#list-of-input-commands), [mpv properties](https://mpv.io/manual/stable/#properties)).

The default TMU playback process should start a single `mpv` instance with audio-only, no terminal UI, and idle behavior, then send `loadfile` commands for local files, Navidrome stream URLs, and cached YouTube downloads. mpv documents `--input-ipc-server=<filename>` for IPC, `--idle` behavior for staying alive with no file loaded, `--terminal` to control terminal output, and video-selection options such as `--vid=<ID|auto|no>` for disabling video output in an audio player ([mpv options](https://mpv.io/manual/stable/#options), [mpv IPC](https://mpv.io/manual/stable/#json-ipc)).

Recommended launch shape:

```ts
const mpv = Bun.spawn([
  "mpv",
  "--no-config",
  "--idle=yes",
  "--terminal=no",
  "--vid=no",
  "--audio-display=no",
  `--input-ipc-server=${ipcPath}`,
], {
  stdout: "pipe",
  stderr: "pipe",
});
```

Keep one controller boundary in TMU:

```ts
interface PlaybackProcess {
  load(item: { pathOrUrl: string; knownDurationSecs?: number }): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  stop(): Promise<void>;
  seekAbsolute(seconds: number): Promise<void>;
  seekRelative(deltaSeconds: number): Promise<void>;
  setVolume(percent: number): Promise<void>;
  status(): PlaybackStatus;
  close(): Promise<void>;
}
```

The controller should serialize JSON IPC requests, correlate responses by `request_id`, observe properties for progress/state, and treat subprocess exit as a first-class playback error. mpv's IPC docs define command arrays, replies, events, numbered `request_id` fields, `observe_property`, and `property-change` events ([mpv JSON IPC](https://mpv.io/manual/stable/#json-ipc)).

## Source-Specific Playback

### Local Files

For local audio files, send `loadfile <path> replace` to the running mpv process and let mpv decode/output audio. mpv documents `loadfile` as a command that loads a file, optionally replacing the current playlist entry, and mpv accepts local files as ordinary playback inputs ([mpv `loadfile`](https://mpv.io/manual/stable/#command-interface-loadfile), [mpv command interface](https://mpv.io/manual/stable/#command-interface)).

Use mpv properties for active playback state and position, but do not make mpv the only library-index metadata source. mpv documents playback properties such as `time-pos`, `duration`, `percent-pos`, `metadata`, `pause`, `eof-reached`, and `idle-active`; ffprobe documents machine-readable probing with selectable writers such as JSON and sections such as streams, format, packets, and metadata ([mpv properties](https://mpv.io/manual/stable/#properties), [ffprobe documentation](https://ffmpeg.org/ffprobe.html)).

TMU should use provider/index metadata for display first, then use ffprobe to fill gaps or verify local/cached files. This avoids tying library indexing to a currently playing mpv instance while still giving accurate runtime progress from the player ([ffprobe documentation](https://ffmpeg.org/ffprobe.html)).

### Navidrome Stream URLs

For Navidrome, TMU should pass the authenticated HTTP stream URL directly to mpv with `loadfile <url> replace`. The local cliamp Navidrome client builds stream URLs from track IDs, marks those tracks as streams, and carries `DurationSecs` from the Subsonic song response into the track model ([cliamp Navidrome stream URL](/home/txchen/code/github/cliamp/external/navidrome/client.go:455), [cliamp track model](/home/txchen/code/github/cliamp/playlist/playlist.go:34)).

TMU should keep Navidrome metadata and duration as provider-owned facts, then reconcile mpv's `duration` and `time-pos` after playback begins. mpv documents `duration` and `time-pos` properties; cliamp's Navidrome mapping shows the provider response already includes title, artist, album, year, track number, genre, and duration before playback starts ([mpv properties](https://mpv.io/manual/stable/#properties), [cliamp Navidrome song mapping](/home/txchen/code/github/cliamp/external/navidrome/client.go:455)).

Seeking over Navidrome streams should be enabled only after the controller has a known duration and the mpv seek command succeeds. mpv documents the `seek` command and does not make HTTP servers' range support a TMU-level guarantee; cliamp treats Subsonic stream/download endpoints specially because remote stream handling differs from local file handling ([mpv `seek`](https://mpv.io/manual/stable/#command-interface-seek), [cliamp Subsonic stream URL detection](/home/txchen/code/github/cliamp/external/navidrome/client.go:53)).

### Cached YouTube Downloads

For cached YouTube downloads, TMU should play the cached file exactly like a local file. The TMU domain model says the MVP's Offline YouTube Cache is a local library created by downloading YouTube or YouTube Music items before playback, not live streaming; local cliamp shows live `yt-dlp | ffmpeg` playback has non-trivial process lifecycle, timeout, stderr, and cleanup behavior that TMU can avoid in the MVP ([TMU context](/home/txchen/code/vibe/tmu/CONTEXT.md:16), [cliamp `yt-dlp | ffmpeg` pipeline](/home/txchen/code/github/cliamp/player/ytdl.go:272), [cliamp process cleanup](/home/txchen/code/github/cliamp/player/ytdl.go:234)).

TMU should store downloader-side metadata in the cache and verify the final file with ffprobe after download completion. ffprobe documents extracting format, stream, and metadata information in machine-readable output, while mpv documents runtime properties for current playback status and duration once the file is loaded ([ffprobe documentation](https://ffmpeg.org/ffprobe.html), [mpv properties](https://mpv.io/manual/stable/#properties)).

## Controls And Reporting

| Need | Strategy | Source |
| --- | --- | --- |
| Load local/cached file | `loadfile <path> replace` over mpv JSON IPC. | [mpv `loadfile`](https://mpv.io/manual/stable/#command-interface-loadfile) |
| Load Navidrome stream URL | `loadfile <authenticated-url> replace`; keep provider metadata from Navidrome model. | [mpv `loadfile`](https://mpv.io/manual/stable/#command-interface-loadfile), [cliamp Navidrome stream mapping](/home/txchen/code/github/cliamp/external/navidrome/client.go:466) |
| Pause/resume | `set_property pause true/false`; observe `pause`. | [mpv JSON IPC](https://mpv.io/manual/stable/#json-ipc), [mpv properties](https://mpv.io/manual/stable/#properties) |
| Seek | Use mpv `seek` for absolute and relative seeks; degrade gracefully on streams where the command fails. | [mpv `seek`](https://mpv.io/manual/stable/#command-interface-seek) |
| Volume | Use `set_property volume <percent>` and observe `volume`; mpv exposes `volume` as a property and supports property setting over JSON IPC. | [mpv properties](https://mpv.io/manual/stable/#properties), [mpv JSON IPC](https://mpv.io/manual/stable/#json-ipc) |
| Progress | Observe `time-pos`, `duration`, `percent-pos`, `pause`, `eof-reached`, and `idle-active`; render TMU progress from observed property-change events plus a coarse UI tick. | [mpv properties](https://mpv.io/manual/stable/#properties), [mpv `observe_property`](https://mpv.io/manual/stable/#json-ipc) |
| End of track | Treat `end-file` events and `eof-reached` changes as playback-completion signals. | [mpv events](https://mpv.io/manual/stable/#events), [mpv properties](https://mpv.io/manual/stable/#properties) |
| Cancellation | For normal stop, send `stop` or `loadfile` replacement; for teardown, call Bun's subprocess `kill()` and close IPC. | [mpv commands](https://mpv.io/manual/stable/#list-of-input-commands), [Bun child process docs](https://bun.com/docs/runtime/child-process) |
| Metadata | Prefer provider/index/cache metadata; use ffprobe for local/cached probes; use mpv `metadata` as currently loaded media metadata. | [ffprobe documentation](https://ffmpeg.org/ffprobe.html), [mpv properties](https://mpv.io/manual/stable/#properties), [cliamp local tag/index lesson](/home/txchen/code/github/cliamp/playlist/tags.go:55) |

## Alternative Evaluation

### mpv

mpv is the best subprocess-centered player for TMU because it is both a player and a controllable process. Its manual documents JSON IPC, command replies, events, property observation, `loadfile`, `seek`, and player properties; those surfaces map directly to a Bun controller without requiring TMU to process PCM or own an audio device ([mpv JSON IPC](https://mpv.io/manual/stable/#json-ipc), [mpv commands](https://mpv.io/manual/stable/#list-of-input-commands), [mpv properties](https://mpv.io/manual/stable/#properties)).

mpv also matches TMU's three playback inputs. Local files and cached YouTube downloads are file paths loaded by `loadfile`; Navidrome tracks are HTTP URLs loaded by the same command; progress and duration come from the same observed properties after load ([mpv `loadfile`](https://mpv.io/manual/stable/#command-interface-loadfile), [mpv properties](https://mpv.io/manual/stable/#properties)).

Main risk: mpv is an external runtime dependency. Bun can compile a standalone executable, but Bun's executable packaging documentation covers bundling the Bun runtime and project code, not bundling external media-player binaries into that executable; TMU therefore needs install checks and platform-specific help for `mpv` and optional `ffprobe` ([Bun executable docs](https://bun.com/docs/bundler/executables), [mpv installation docs](https://mpv.io/installation/)).

### ffplay

ffplay is not a good TMU control surface. The official docs describe ffplay as a simple media player using FFmpeg libraries and SDL, and its interaction model is command-line options plus keyboard/mouse controls such as pause, seek, volume, and frame stepping; the docs do not define a JSON IPC/property/event protocol comparable to mpv's documented IPC surface ([ffplay documentation](https://ffmpeg.org/ffplay.html), [mpv JSON IPC](https://mpv.io/manual/stable/#json-ipc)).

ffplay can be useful as a human debugging tool for "does this URL/file produce audio?", but TMU would have to infer progress from stderr/status output or wrap an SDL player process with brittle control assumptions. That is weaker than mpv's documented request/reply and property observation protocol ([ffplay documentation](https://ffmpeg.org/ffplay.html), [mpv JSON IPC](https://mpv.io/manual/stable/#json-ipc)).

### ffmpeg As Decoder

ffmpeg is excellent as a decoder/transcoder subprocess but not as TMU's player. FFmpeg's command-line tool can read inputs, transcode, write pipes, and report progress with `-progress`, and cliamp uses `ffmpeg` to decode streams into PCM over stdout; however, that model makes TMU own the audio output layer, buffering, sample format, seek behavior, and process cleanup ([FFmpeg documentation](https://ffmpeg.org/ffmpeg.html), [cliamp ffmpeg pipe](/home/txchen/code/github/cliamp/player/ffmpeg.go:176)).

The local cliamp source shows the real cost of that path: it creates stdout pipes, converts audio to fixed PCM formats, tracks sample positions itself, closes source readers to unblock subprocess I/O, kills processes, waits for children, and adds timeout logic so a stream that never emits PCM cannot wedge the player ([cliamp ffmpeg pipe state](/home/txchen/code/github/cliamp/player/ffmpeg.go:207), [cliamp ffmpeg stop cleanup](/home/txchen/code/github/cliamp/player/ffmpeg.go:232), [cliamp initial audio timeout](/home/txchen/code/github/cliamp/player/ffmpeg.go:267)).

Use ffmpeg/ffprobe as helpers, not as the primary playback engine. ffprobe gives structured metadata and duration probing, while mpv already owns decode and audio output as the foreground playback subprocess ([ffprobe documentation](https://ffmpeg.org/ffprobe.html), [mpv command interface](https://mpv.io/manual/stable/#command-interface)).

### GStreamer

GStreamer is the wrong fit for "subprocess-centered Bun playback" even though it is a strong media framework. GStreamer documents application-level playback through libraries/elements such as `playbin`, while the `gst-launch-1.0` command-line tool is documented as a pipeline launcher useful for testing/prototyping rather than a stable remote-control player protocol for a TUI ([GStreamer playbin docs](https://gstreamer.freedesktop.org/documentation/playback/playbin.html), [GStreamer gst-launch docs](https://gstreamer.freedesktop.org/documentation/tools/gst-launch.html)).

Choosing GStreamer would either push TMU toward native bindings or force a custom helper daemon that exposes the control protocol TMU needs. That adds more packaging and platform work than using mpv's already documented IPC surface ([GStreamer application development docs](https://gstreamer.freedesktop.org/documentation/application-development/), [mpv JSON IPC](https://mpv.io/manual/stable/#json-ipc)).

## Cross-Platform And Packaging

Bun can build standalone executables for supported targets, but that does not remove the need for external media dependencies. TMU should treat `mpv` as required and `ffprobe` as recommended for metadata repair/verification, then fail early with actionable install guidance if either helper required for the current action is missing ([Bun executable docs](https://bun.com/docs/bundler/executables), [mpv installation docs](https://mpv.io/installation/), [ffprobe documentation](https://ffmpeg.org/ffprobe.html)).

The controller should make the IPC endpoint platform-aware. mpv documents `--input-ipc-server=<filename>` as the IPC server option, while Bun documents subprocess control and Node-compatible APIs; TMU should verify Unix socket and Windows named-pipe behavior in integration tests before claiming Windows support ([mpv IPC](https://mpv.io/manual/stable/#json-ipc), [Bun child process docs](https://bun.com/docs/runtime/child-process), [Bun Node.js compatibility docs](https://bun.com/docs/runtime/nodejs-apis)).

Package policy for MVP:

- Required at runtime: `bun` during development, built TMU executable for packaged use, and `mpv` on `PATH` ([Bun runtime docs](https://bun.com/docs/runtime), [Bun executable docs](https://bun.com/docs/bundler/executables), [mpv installation docs](https://mpv.io/installation/)).
- Recommended helper: `ffprobe` on `PATH` for local/cached file verification and metadata repair ([ffprobe documentation](https://ffmpeg.org/ffprobe.html)).
- Not required for playback: `ffplay`, GStreamer command-line tools, or native GStreamer bindings ([ffplay documentation](https://ffmpeg.org/ffplay.html), [GStreamer gst-launch docs](https://gstreamer.freedesktop.org/documentation/tools/gst-launch.html)).

## Idle CPU Behavior

The best idle-CPU strategy is architectural: keep mpv alive in idle mode, observe mpv properties/events, and keep the TUI event-driven with coarse progress ticks. mpv documents idle operation and property/event observation, while cliamp's local tick constants show why TMU should avoid visualizer-like redraw cadences and prefer low-power playback or idle cadences such as 500 ms while playing and 1500 ms when idle ([mpv options](https://mpv.io/manual/stable/#options), [mpv JSON IPC](https://mpv.io/manual/stable/#json-ipc), [cliamp tick constants](/home/txchen/code/github/cliamp/ui/tick.go:5)).

The docs do not provide a reliable cross-platform CPU percentage for any candidate. TMU should measure idle CPU with the actual Bun TUI, mpv process, and IPC observer loop on target platforms, but the documented control surfaces make mpv the only candidate here that can be event-driven without TMU owning PCM decode/audio output ([mpv JSON IPC](https://mpv.io/manual/stable/#json-ipc), [Bun child process docs](https://bun.com/docs/runtime/child-process)).

## Decision

Choose this MVP strategy:

1. **Primary playback:** one long-lived `mpv` subprocess, audio-only, controlled by JSON IPC.
2. **Inputs:** use `loadfile` for local files, Navidrome stream URLs, and cached YouTube files.
3. **Metadata:** provider/cache/index metadata first; `ffprobe` for local/cached verification; mpv runtime properties for currently loaded playback state.
4. **Progress:** observe mpv properties/events and redraw the TUI on events plus a coarse timer.
5. **Cancellation:** prefer mpv stop/load replacement for normal control; kill and reap the process on teardown or broken IPC.
6. **Packaging:** require `mpv`; recommend `ffprobe`; exclude ffplay and GStreamer from the MVP dependency set.

This gives Bun-based TMU the narrowest subprocess boundary that still supports local playback, HTTP stream URLs, seeking, volume, metadata reconciliation, cancellation, progress reporting, and low-power UI behavior.
