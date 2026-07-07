# Characterize cliamp Costs And Reusable Lessons

Type: research
Status: resolved
Blocked by:

## Question

Which parts of cliamp explain the complexity and resource profile TMU wants to avoid, and which ideas are still worth reusing conceptually?

Inspect cliamp's provider model, audio pipeline, TUI update loop, visualizer/EQ path, yt-dlp integration, configuration, tests, and dependency graph. The answer should produce explicit "reuse the idea" and "avoid this in TMU" lists.

## Answer

Research note: [Characterize cliamp Costs And Reusable Lessons](../research/03-characterize-cliamp-costs-and-reusable-lessons.md).

cliamp is useful as a source of lessons, but it should not be treated as TMU's architecture template. The local checkout is roughly 64k lines of Go across 321 files, with the largest complexity clusters in UI/model state, visualizers, Lua plugins, player internals, IPC, provider integrations, config, and playlist management.

Reuse conceptually:

- bounded render cadences, especially explicit low-power and idle tick policies
- capability-oriented provider thinking, but with a much smaller capability set
- Navidrome/Subsonic API hygiene: timeout, response cap, token+salt auth, API-level error decoding, stream URL detection, and simple caching
- subprocess lifecycle discipline: availability checks, stderr capture, kill/wait cleanup, timeouts, and useful error surfacing
- a test seam between TUI state and playback control

Avoid in TMU's MVP:

- forking or closely mirroring cliamp
- terminal visualizers, FFT, audio sample taps, and high-frequency render loops
- in-process EQ, speed, mono, gapless, or audio DSP engine work
- broad provider interfaces for playlist editing, bookmarks, favorites, scrobbling, ratings, catalog paging, custom streamers, and plugin hooks
- Lua plugins, IPC, media keys, MPRIS, external band streams, headless mode, and rich remote-control surfaces
- YouTube live streaming; keep URL-download-first for the MVP
- cliamp's large config object; start with only TMU's paths, subprocess playback choice, low-power cadence, queue state, Navidrome settings, and cache settings
