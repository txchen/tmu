# Lean TUI Music Player Wayfinder Map

## Destination

A ready-to-build MVP architecture and product spec for TMU, a lean, low-power TUI music player inspired by cliamp but intentionally smaller. The map is complete when language/runtime, audio pipeline, provider boundaries, local/download storage, low-power TUI behavior, and MVP UX scope are decided well enough to split into implementation issues.

## Notes

- Use `wayfinder` for planning, `research` for primary-source API/library checks, `prototype` for cheap UI or playback spikes, and `grilling` plus `domain-modeling` for user-owned scope decisions.
- Treat cliamp as a reference implementation and cautionary example, not as a codebase to fork wholesale.
- Optimize for idle efficiency and battery life: no terminal visualizer, no live EQ rendering, no high-frequency render loop unless a prototype proves it is cheap.
- Initial provider scope: file/folder local music, Navidrome via Subsonic/OpenSubsonic with artist/album browsing, URL-only YouTube downloads via yt-dlp, and local playback from the Offline YouTube Cache.
- Prefer decisions that keep the first implementation small and reversible.

## Decisions so far

- [Define MVP Playback And Source Scope](./issues/01-define-mvp-playback-and-source-scope.md) — TMU's MVP is queue-first: simple local file/folder playback, full Navidrome artist/album browsing, URL-only YouTube downloads into an offline cache, tight playback/queue controls, and minimal persisted state.
- [Compare Go Rust And Bun For TMU](./issues/02-compare-go-rust-and-bun-for-tmu.md) — Build the MVP in Bun/TypeScript with subprocess-centered playback; keep Go and Rust as fallback candidates if the prototype exposes idle CPU, subprocess, packaging, or TUI overhead problems.
- [Characterize cliamp Costs And Reusable Lessons](./issues/03-characterize-cliamp-costs-and-reusable-lessons.md) — Reuse cliamp's bounded tick, provider, Navidrome, subprocess, and test-seam lessons, but avoid inheriting its visualizer/EQ, plugin, IPC, broad provider, live YouTube streaming, and large config surfaces.
- [Choose Audio Playback And Decode Strategy](./issues/04-choose-audio-playback-and-decode-strategy.md) — Use a long-lived audio-only `mpv` subprocess controlled by Bun over JSON IPC for all MVP playback inputs, with `ffprobe` as the metadata/duration helper.
- [Define Navidrome OpenSubsonic Scope](./issues/05-define-navidrome-opensubsonic-scope.md) — Build a read-only, queue-first Navidrome provider around token-authenticated ID3 browsing, playlists, song search, raw stream URLs, optional cover-art fetches, and best-effort scrobble reporting.
- [Define Local Library Indexing Model](./issues/06-define-local-library-indexing-model.md) — Keep Local as direct file/folder expansion into the shared queue with lazy ffprobe metadata, exact-path dedupe, no persistent library index, no watcher, and no local playlist manager.
- [Define YouTube URL Download Pipeline](./issues/07-define-youtube-music-and-download-pipeline.md) — Treat YouTube as URL-only download-to-cache: identify with yt-dlp, store one media file plus sidecars under stable extractor/id directories, skip existing cache entries, and enqueue the cached local file.

## Not yet specified

- Cross-platform packaging and install story for Bun plus required `mpv` and recommended `ffprobe`.
- Background/daemon mode, desktop media keys, MPRIS, notifications, and IPC after the foreground MVP is shaped.
- Authentication and credential storage UX after the Navidrome API approach and config model are narrowed.

## Out of scope

- cliamp parity: Spotify, SoundCloud, NetEase, Plex, Jellyfin, radio browser, podcasts, Lua plugins, remote control, SSH streaming, themes, lyrics, and broad provider expansion are outside this first map.
- Terminal spectrum visualizers and always-on EQ displays are outside the MVP because they conflict with the low-power constraint.
- Installing or activating a Go toolchain is outside the current MVP route because Bun/TypeScript is now the chosen implementation runtime.
- Automatic Offline YouTube Cache eviction, stale archive repair UI, thumbnail/comment/chapter downloads, cache migrations, and broad yt-dlp site support are outside the MVP.
