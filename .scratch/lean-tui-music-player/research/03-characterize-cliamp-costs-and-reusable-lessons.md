# Characterize cliamp Costs And Reusable Lessons

Research date: 2026-07-07

## Summary

cliamp is valuable as a source of patterns, but it is too broad to serve as TMU's architecture template. Its complexity comes from feature parity with a full terminal media center: many remote providers, a large provider capability matrix, in-process audio DSP, visualizers, plugin APIs, IPC, media controls, themes, setup flows, and cross-platform packaging. The local checkout contains 321 Go files, 123 test files, and about 64k lines of Go, with the largest clusters in `ui/model`, `ui`, `luaplugin`, `player`, `ipc`, config, playlist, and provider packages.

TMU should reuse cliamp's lessons around bounded ticks, subprocess lifecycle care, explicit provider capabilities, and Navidrome API hygiene. TMU should not reuse cliamp's full player surface, visualizer/EQ path, provider sprawl, plugin system, IPC/media-control surface, or local playlist manager in the MVP.

## What Explains cliamp's Cost

### Broad Product Surface

cliamp's README describes support for local files, streams, podcasts, YouTube, YouTube Music, SoundCloud, Bilibili, Spotify, NetEase, Xiaoyuzhou, Navidrome, Plex, Jellyfin, spectrum visualizer, parametric EQ, and playlist management. That breadth alone forces a large app shape: provider auth, provider browsing, URL handling, stream handling, setup, optional runtime dependencies, and cross-platform packaging all appear before ordinary playback is considered. Source: `/home/txchen/code/github/cliamp/README.md:1`.

The dependency graph reflects that breadth: Bubble Tea/Lip Gloss for UI, Beep/Oto for audio, go-librespot for Spotify, Google APIs and OAuth for YouTube Music, DBus for media control, GopherLua for plugins, metadata parsing, and many indirect dependencies. Source: `/home/txchen/code/github/cliamp/go.mod:5`.

### Provider Capability Matrix

cliamp has a small nominal provider idea, but the real provider surface is many optional capability interfaces: search, artist browsing, album browsing, album sort persistence, album track loading, playback reporting, playlist writes, batch writes, playlist save/create/delete/rename, bookmarks, custom streamers, favorites, catalog paging, catalog search, sectioned lists, and closers. Source: `/home/txchen/code/github/cliamp/provider/interfaces.go:12`.

That pattern is flexible, but every optional interface creates UI branching and test cases. TMU only needs Local, Navidrome, Offline YouTube Cache, and URL download in the MVP, so it should start with fewer capabilities: `browse`, `search` only where needed, `tracksFor`, `streamUrl/filePath`, and `enqueue`.

### Audio Engine Surface

cliamp's `player.Engine` includes local playback, live yt-dlp playback, preload/gapless, normal seeking, yt-dlp seek-by-restart, volume, speed, mono, EQ, stream errors, stream title, stream byte stats, visualizer samples, and sample rate. Source: `/home/txchen/code/github/cliamp/player/engine.go:7`.

This is a powerful API, but for TMU it is the wrong center of gravity. Since TMU is now Bun/TypeScript with subprocess-centered playback, the MVP player interface should be closer to a process controller: load, play/pause, stop, seek, volume, status, duration, position, stderr/error, and exit lifecycle. Avoid in-process sample taps, EQ, speed control, and gapless until there is measured demand.

### Visualizer And EQ Coupling

cliamp has 30 visualizer files under `ui/vis_*.go`, plus an FFT implementation and visualizer driver state. The visualizer path is not isolated ornamentation: it drives tick cadence, asks the player for audio samples, caches analysis, and renders at animation cadences. Source: `/home/txchen/code/github/cliamp/ui/visualizer.go:28`; `/home/txchen/code/github/cliamp/ui/fft.go:1`; `/home/txchen/code/github/cliamp/ui/model/tick.go:20`.

The tick constants show the battery risk directly: visualizer animation can run at 16ms, spectrum at 50ms, analysis at 33ms, ordinary slow ticks at 200ms, low-power playback at 500ms, and idle at 1500ms. Source: `/home/txchen/code/github/cliamp/ui/tick.go:5`.

EQ also lives in the audio stream path as ten biquad filters, with per-sample processing when a band is active. Source: `/home/txchen/code/github/cliamp/player/eq.go:10`.

For TMU, the reusable idea is the low-power cadence split, not the visualizer or EQ. The MVP should have no audio sample tap, no FFT, no terminal animation, and no in-process EQ.

### TUI Model Accretion

cliamp's `ui/model/state.go` shows many overlay and workflow states: playlist search, network search, provider search, seek debounce, theme picker, visualizer picker, lyrics overlay, keymap overlay, queue overlay, playlist manager, playlist picker, file browser, Navidrome browser, Spotify search/add-to-playlist, catalog paging, yt-dlp batch loading, reconnect state, and device picker. Source: `/home/txchen/code/github/cliamp/ui/model/state.go:13`.

The update loop is consequently dense: a tick handles cached position/duration, visualizer ticking, debounced seek, status expiry, log expiry, speed save, reconnect handling, ICY stream title changes, lyric fetching, network speed sampling, scheduled reconnect, gapless transitions, and command batching. Source: `/home/txchen/code/github/cliamp/ui/model/update.go:20`.

TMU should keep the MVP model smaller: source switcher, one provider view, one queue/playback view, one download status surface, and one config/error surface.

### Live yt-dlp Streaming Pipeline

cliamp streams YouTube-like URLs through a `yt-dlp | ffmpeg` pipe, captures stderr, manages process cleanup, prefers yt-dlp errors over opaque EOF, and waits for initial audio so the speaker goroutine does not block on an empty pipe. Source: `/home/txchen/code/github/cliamp/player/ytdl.go:272`.

This is useful evidence that subprocess lifecycle is subtle. But TMU already decided YouTube is URL-download-first, so TMU should reuse the process hygiene and error policy while avoiding live playback pipes for YouTube in the MVP.

### Plugins, IPC, Media Controls, And External Surfaces

cliamp's Lua plugin manager exposes state, controls, UI callbacks, plugin commands, timers, exec permissions, keybinds, and visualizer plugins. Source: `/home/txchen/code/github/cliamp/luaplugin/luaplugin.go:1`.

cliamp's IPC protocol exposes many remote-control fields and messages: status, theme, visualizer, shuffle, repeat, mono, speed, EQ, device, plugin calls, and visualizer bands. Source: `/home/txchen/code/github/cliamp/ipc/protocol.go:1`.

These are deliberate extensibility features, but they pull a foreground music player into daemon/control-plane territory. TMU should exclude them until after the foreground MVP is stable.

## Reuse The Idea

- **Bounded render cadences**: copy the principle of separate playing, low-power playing, and idle cadences. In TMU, the default should be event-driven rendering plus coarse position ticks, not a high-frequency loop. Source: `/home/txchen/code/github/cliamp/ui/tick.go:12`.
- **Capability-oriented providers**: keep a provider capability vocabulary, but make it much smaller. Use capabilities for Navidrome browse/search and URL/cache behavior without implementing cliamp's write/bookmark/favorite/catalog/custom-streamer matrix. Source: `/home/txchen/code/github/cliamp/provider/interfaces.go:12`.
- **Navidrome API hygiene**: reuse the ideas of finite HTTP timeouts, response-size limits, Subsonic token+salt auth, API-level error decoding, stream/download URL detection, and simple caching. Source: `/home/txchen/code/github/cliamp/external/navidrome/client.go:35`; `/home/txchen/code/github/cliamp/external/navidrome/client.go:53`; `/home/txchen/code/github/cliamp/external/navidrome/client.go:182`; `/home/txchen/code/github/cliamp/external/navidrome/client.go:207`.
- **Subprocess lifecycle discipline**: reuse availability checks, stderr capture, explicit kill/wait cleanup, timeouts, and meaningful error surfacing for `yt-dlp`, `ffmpeg`, or `mpv`. Source: `/home/txchen/code/github/cliamp/player/ytdl.go:276`; `/home/txchen/code/github/cliamp/player/ytdl.go:304`; `/home/txchen/code/github/cliamp/player/ytdl.go:330`; `/home/txchen/code/github/cliamp/player/ytdl.go:356`.
- **Test seams around engine/provider boundaries**: cliamp's `player.Engine` exists so the UI model can be tested with a mock. TMU should keep that seam, but with a much smaller subprocess-player interface. Source: `/home/txchen/code/github/cliamp/player/engine.go:5`.
- **Streaming and download errors as product states**: cliamp's reconnect/error logic shows that stream failure, timeout, and stderr messages need first-class UI states. TMU should make download/playback process errors visible and cancellable instead of logging them only. Source: `/home/txchen/code/github/cliamp/ui/model/update.go:118`.

## Avoid This In TMU

- **Do not fork cliamp wholesale**. The feature surface and dependency graph encode a different product: terminal Winamp/media-center parity, not TMU's lean queue-first MVP.
- **Do not implement terminal visualizers** in the MVP. They require audio taps, FFT/analysis state, animation cadences, and render drivers that directly conflict with the low-power constraint.
- **Do not implement in-process EQ/speed/mono/gapless** in the MVP. The chosen Bun/subprocess approach should delegate playback to an external player and avoid building an audio DSP engine.
- **Do not model every provider feature as a generic optional interface**. Start with the exact capabilities TMU needs: local file/folder enqueue, Navidrome artist/album browsing, cached-download browsing, URL download/enqueue.
- **Do not add provider playlist editing, bookmarks, favorites, scrobbling, ratings, or catalog paging** in the MVP. These features multiply UI states and persistence rules.
- **Do not add Lua plugins, IPC, media keys, MPRIS, external visualizer band streams, or headless mode** before the foreground player is proven.
- **Do not keep YouTube live streaming** as an MVP path. Download-first avoids the most fragile `yt-dlp | ffmpeg` pipe behavior and gives TMU a stable local playback path.
- **Do not mirror cliamp's config object**. TMU config should start with app paths, low-power cadence settings, Navidrome credentials/reference, playback subprocess choice, queue state, and cache settings only.

## Direct Consequences For Later Tickets

- [Choose Audio Playback And Decode Strategy](../issues/04-choose-audio-playback-and-decode-strategy.md) should focus on external player control, not native audio libraries or in-process DSP.
- [Define Navidrome OpenSubsonic Scope](../issues/05-define-navidrome-opensubsonic-scope.md) should reuse cliamp's Navidrome endpoint set as a starting point, but should explicitly choose which browse/search/scrobble features are in MVP.
- [Prototype Low-Power TUI Rendering Model](../issues/08-prototype-low-power-tui-rendering-model.md) should prove a Bun TUI can idle near cliamp's low-power/idle intent without using visualizer cadences.
- [Choose Core Domain And State Boundaries](../issues/09-choose-core-domain-and-state-boundaries.md) should include a narrow `PlaybackProcess` boundary and avoid importing visualizer, plugin, IPC, and broad provider abstractions into the core model.
