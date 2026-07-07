# Compare Go Rust And Bun For TMU

Type: research
Status: resolved
Blocked by:

## Question

Given TMU's low-power TUI constraint, audio playback needs, provider integrations, distribution goals, and developer ergonomics, should the first implementation be in Go, Rust, or Bun/TypeScript?

Compare ecosystem fit for terminal UI, native audio playback, spawning/controlling yt-dlp and ffmpeg, metadata parsing, static/single-binary distribution, memory/CPU profile, testability, and implementation complexity.

## Answer

Choose **Bun/TypeScript** for the first TMU implementation.

Research note: [Compare Go, Rust, and Bun/TypeScript for TMU](../research/02-compare-go-rust-and-bun-for-tmu.md).

Rationale:

- The MVP playback model is subprocess-centered: local files, Navidrome streams, and cached YouTube downloads can be delegated to a player/decoder subprocess, while TMU owns provider browsing, queue state, downloads, metadata, and TUI state. Under that model, Go's native audio advantage is much less important.
- Fast iteration matters for this effort. Bun avoids the compile/build step during normal development and is already available in this workspace, while `go` is not currently on `PATH`.
- Bun/TypeScript is a strong fit for provider/API work, filesystem metadata, queue/cache state, process orchestration, and fast UI iteration.
- The low-power rule still applies: TMU must avoid React-style always-redrawing UI behavior and should explicitly prototype redraw cadence and idle CPU before locking the TUI stack.
- Go and Rust remain fallback candidates if the Bun prototype shows unacceptable idle CPU, subprocess control problems, packaging friction, or terminal rendering overhead.

Consequences:

- The audio playback research should evaluate subprocess-first playback from Bun: mpv, ffmpeg/ffplay, or another small external player/decoder controlled by TMU.
- The low-power TUI prototype should be built in Bun/TypeScript and should measure idle CPU/redraw cadence explicitly.
- Installing Go is no longer an MVP blocker.
