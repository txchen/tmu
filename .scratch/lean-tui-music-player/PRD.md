# TMU Queue-First MVP PRD

Status: ready-for-agent

## Problem Statement

TMU needs a ready-to-build product and architecture specification for a lean terminal music player that can handle everyday playback without inheriting the size, provider breadth, render cost, and audio-engine complexity of cliamp. The MVP must support local files and folders, Navidrome libraries, and URL-only YouTube downloads while staying small, low-power, and queue-first.

Users need one reliable foreground TUI where every Provider feeds the same Queue, playback is controlled through a single Player boundary, and failed or unavailable Tracks remain understandable instead of silently disappearing. They also need the implementation to be simple enough for agent-driven slicing: narrow Provider boundaries, explicit App Coordinator workflows, limited persistence, external media helper policy, and a test strategy that exercises observable behavior rather than internal rendering or subprocess details.

## Solution

Build TMU as a Bun/TypeScript foreground TUI for Linux x64. The MVP is a Queue-First MVP: Local, Navidrome, Offline YouTube Cache, and YouTube URL Download all produce canonical Tracks that enter one shared Queue. The App Coordinator resolves Track Identity into Playback Locators at play time and sends them to a long-lived audio-only mpv Player over JSON IPC.

The TUI uses a source-rail shell with a Provider Browsing Surface and persistent queue/player strip. Local supports direct file and folder opening. Navidrome supports read-only artist/album browsing, playlists, song search-to-queue, stream URL generation, and best-effort scrobble reporting. YouTube is URL-only and download-first: pasted YouTube or YouTube Music URLs are identified and downloaded with yt-dlp into the Offline YouTube Cache, then enqueued as cached local Tracks. Offline YouTube Cache can also be browsed directly.

Rendering must follow the Low-Power TUI rule: redraw on input, App State changes, Player state changes, and coarse playback ticks while playing; stop playback-position ticks while idle or paused. No visualizer, fixed-FPS render loop, always-on EQ display, DSP engine, broad provider expansion, daemon mode, remote control, or full local media-library database is part of the MVP.

## User Stories

1. As a TMU user, I want all Providers to add Tracks to one Queue, so that playback behaves consistently regardless of where music came from.
2. As a TMU user, I want CLI file arguments to seed the Queue on startup, so that I can quickly play local music from my shell.
3. As a TMU user, I want startup without CLI args to open the source switcher or last selected Provider, so that I can resume browsing without extra setup.
4. As a TMU user, I want Local, Navidrome, Offline YouTube Cache, YouTube URL Download, and Queue to be sibling source targets, so that navigation is predictable.
5. As a TMU user, I want the Queue and current Player status visible while browsing Providers, so that I do not lose playback context.
6. As a TMU user, I want an expanded Queue view, so that I can inspect, reorder, remove, and start queued Tracks.
7. As a TMU user, I want playback controls for play, pause, stop, next, and previous, so that I can control the current Track without leaving the TUI.
8. As a TMU user, I want seeking when the current Playback Locator supports it, so that I can move within a Track.
9. As a TMU user, I want app volume control, so that I can adjust playback without changing every Provider.
10. As a TMU user, I want shuffle and repeat-all modes, so that the Queue can support common listening patterns.
11. As a TMU user, I want to add Tracks from any Provider without creating separate Provider queues, so that the Queue remains the source of playback order.
12. As a TMU user, I want duplicate Tracks to be avoided by Track Identity by default, so that accidental repeat adds do not clutter the Queue.
13. As a TMU user, I want unavailable Tracks to stay visible with Track Availability state, so that I understand what failed and can fix it.
14. As a TMU user, I want TMU to skip failed Tracks during auto-advance when appropriate, so that one unavailable item does not stop a long session.
15. As a TMU user, I want a Last Queue Snapshot, so that my recent queue can be restored after restarting TMU.
16. As a TMU user, I want the last selected Provider to be remembered, so that TMU opens near where I left off.
17. As a TMU user, I want volume, shuffle mode, and repeat mode persisted, so that routine settings survive restarts.
18. As a local music listener, I want to open explicit audio files from CLI args, so that TMU can act as a quick file player.
19. As a local music listener, I want to open folders from the Local Provider Browsing Surface, so that I can enqueue albums or collections without indexing them first.
20. As a local music listener, I want directory expansion to be stable and sorted, so that queue order is predictable.
21. As a local music listener, I want directory expansion to be cancellable, so that accidentally selecting a huge tree does not trap the UI.
22. As a local music listener, I want a soft cap on discovered audio files per action, so that TMU remains responsive on large folders.
23. As a local music listener, I want common audio extensions recognized cheaply, so that folder adds do not require probing every file first.
24. As a local music listener, I want explicitly selected unknown-extension files probed for audio streams, so that valid files are not rejected only by filename.
25. As a local music listener, I want metadata to appear lazily after Tracks are enqueued, so that adding music feels immediate.
26. As a local music listener, I want missing restored files to remain visible as unavailable, so that I know why they cannot play.
27. As a local music listener, I do not want TMU to build a persistent local library index, so that the MVP stays simple and direct.
28. As a Navidrome user, I want to configure a server URL and token-auth credentials, so that TMU can browse my remote library.
29. As a Navidrome user, I want TMU to validate the connection with ping, so that auth or server problems are caught clearly.
30. As a Navidrome user, I want full artist and album browsing, so that TMU can navigate my remote music library naturally.
31. As a Navidrome user, I want read-only playlist browsing, so that I can enqueue Tracks from existing server playlists.
32. As a Navidrome user, I want song search-to-queue, so that I can find a specific Track quickly.
33. As a Navidrome user, I want remote stream URLs generated only when playback starts, so that auth-bearing URLs are not persisted as Track Identity.
34. As a Navidrome user, I want IDs treated as strings, so that TMU remains compatible with Subsonic/OpenSubsonic responses.
35. As a Navidrome user, I want artist data loaded once per session and refreshed explicitly, so that browsing avoids unnecessary network work.
36. As a Navidrome user, I want album and search results paged lazily, so that large libraries remain usable.
37. As a Navidrome user, I want best-effort now-playing and completed-play scrobble reporting with an opt-out, so that server listening history can be updated without risking playback.
38. As a Navidrome user, I want API errors surfaced even when HTTP status is 200, so that failed Subsonic responses are not mistaken for valid data.
39. As a Navidrome user, I want coverArt IDs preserved, so that cover art can be fetched later without corrupting metadata assumptions.
40. As a YouTube URL Download user, I want to paste a direct YouTube or YouTube Music URL, so that TMU can download it into the Offline YouTube Cache.
41. As a YouTube URL Download user, I want TMU to reject search strings, account URLs, playlists, live streams, and unsupported sites, so that the MVP behavior is clear.
42. As a YouTube URL Download user, I want TMU to identify a URL before downloading, so that cache lookup and errors happen before a long operation starts.
43. As a YouTube URL Download user, I want downloaded media stored under a stable extractor and ID identity, so that the cache can find it later.
44. As a YouTube URL Download user, I want TMU to skip redownload when a cache entry and media file already exist, so that repeated adds are fast.
45. As a YouTube URL Download user, I want line-oriented download progress in the TUI, so that I know whether a download is active.
46. As a YouTube URL Download user, I want one download at a time by default, so that subprocess and bandwidth behavior remain predictable.
47. As a YouTube URL Download user, I want cancellation to terminate yt-dlp and clean up safely, so that I can stop a mistaken download.
48. As a YouTube URL Download user, I want optional cookies-from-browser configuration, so that age-gated or account-visible media can work when yt-dlp supports it.
49. As a YouTube URL Download user, I do not want TMU to copy browser cookies into its own storage, so that sensitive cookie material is not duplicated.
50. As a YouTube URL Download user, I want yt-dlp stderr surfaced for unavailable, restricted, age-gated, bot-detected, DRM, or region failures, so that failures are actionable.
51. As an Offline YouTube Cache user, I want cached downloads browseable as a Provider, so that downloaded Tracks can be replayed without pasting URLs again.
52. As an Offline YouTube Cache user, I want cache metadata normalized into TMU metadata, so that cached Tracks behave like other Tracks in the Queue.
53. As a low-power terminal user, I want idle and paused TMU sessions to stop playback-position ticks, so that CPU use stays low.
54. As a low-power terminal user, I want progress updates while playing to be coarse, so that playback feedback does not require a high-frequency render loop.
55. As a low-power terminal user, I want download and Provider progress throttled, so that status updates do not make the UI busy.
56. As a terminal user, I want the TUI to redraw immediately on key input and state changes, so that low-power behavior still feels responsive.
57. As a TMU user, I want dependency health messages for missing mpv, ffprobe, or yt-dlp, so that I know what must be installed for each feature.
58. As a TMU user, I want missing mpv to disable playback while leaving config and help usable, so that I can recover inside the app.
59. As a TMU user, I want missing ffprobe to warn but not block playback, so that metadata degradation does not prevent listening.
60. As a TMU user, I want missing yt-dlp to disable only YouTube URL Download, so that Local, Navidrome, Offline YouTube Cache, and playback still work.
61. As a TMU user, I want dependency messages to include the attempted command or configured path and detected version when present, so that troubleshooting is concrete.
62. As a TMU user, I want helper stderr kept out of normal panels unless it explains an action failure, so that routine UI stays readable.
63. As a TMU user, I want TMU Config to hold paths, Provider settings, low-power cadence, helper paths, cache settings, and Navidrome auth fields, so that setup is explicit.
64. As a TMU user, I want secret fields excluded from casual logs and display, so that credentials are not exposed during normal use.
65. As an implementer, I want Track Identity separated from Playback Locator, so that durable queue state does not persist auth-bearing or ephemeral playback addresses.
66. As an implementer, I want Provider, Queue, Player, App Coordinator, App State, and UI State separated, so that each boundary can be tested and changed independently.
67. As an implementer, I want no central Library module in the MVP, so that Provider browsing remains focused and the app avoids premature media-manager behavior.
68. As an implementer, I want Player to know only about mpv playback control and playback state, so that provider and queue rules do not leak into the subprocess boundary.
69. As an implementer, I want App Coordinator to own workflows between UI intents, Providers, Queue, Player, and downloads, so that the TUI remains a renderer and intent dispatcher.
70. As an implementer, I want app packaging to compile the Bun application while keeping media helpers external, so that the first Linux x64 release remains simple and reversible.

## Implementation Decisions

- Build the MVP in Bun/TypeScript. Keep Go and Rust as fallback candidates only if Bun exposes unacceptable idle CPU, subprocess control, packaging, or terminal rendering problems.
- Package TMU with Bun's compiled executable path for the first official Linux x64 MVP target. Do not bundle external media helper binaries.
- Treat `mpv` as the required playback helper. The TUI remains usable for config and help if `mpv` is missing, but playback actions are disabled until dependency health is restored.
- Treat `ffprobe` as a recommended metadata and duration helper. Warn when it is missing, but do not block playback globally.
- Treat `yt-dlp` as required only for YouTube URL Download. Check it when entering that source and before starting a download.
- Use one long-lived audio-only `mpv` process in idle mode as the Player. Control it through JSON IPC from Bun/TypeScript.
- Use mpv `loadfile` for all MVP Playback Locators: local files, Navidrome authenticated stream URLs, and cached YouTube media files.
- Use request IDs, command timeouts, observed playback properties, and reliable end-of-file events in the mpv controller.
- Keep mpv command failures local to Player state. A failed Player command must not prevent later commands or teardown.
- Teardown should ask mpv to quit, close IPC resources, kill and reap the process if needed, and remove any transient IPC endpoint.
- Use `ffprobe` for lazy metadata and duration verification when Provider or cache metadata is missing or needs checking.
- Use Track as the canonical item every Provider adds to the Queue.
- Split durable Track Identity from runtime Playback Locator. Track Identity supports dedupe, queue restore, and refresh; Playback Locator is generated at play time.
- Provider owns browsing, search, open-input behavior, and resolving Track Identity into Playback Locator or unavailable state.
- Queue owns ordered Track entries, current index, identity-based dedupe, queue mutations, Track Availability, and Last Queue Snapshot behavior.
- App Coordinator owns workflows between UI intents, Provider resolution, Queue mutation, Player commands, download completion, and auto-advance.
- TUI dispatches intents and renders App State plus UI State. It must not directly orchestrate Provider resolution or Player rules.
- App State owns Providers, Queue, playback state, downloads, dependency availability, Track Availability, and app-level errors.
- UI State owns focused pane, selected row, active prompt, filter text, and scroll positions.
- Do not introduce a central Library module in the MVP. Local, Navidrome, and Offline YouTube Cache each expose Provider-specific browsing.
- Offline YouTube Cache is both persistent cache storage and a Provider for cached Tracks.
- YouTube URL Download is an action surface that downloads into Offline YouTube Cache and enqueues the resulting cached Track. It is not live YouTube playback.
- Use a source-rail shell with Provider Browsing Surface and persistent queue/player strip as the baseline TUI.
- Without CLI args, open on source switcher or last selected Provider once that preference exists.
- With CLI args, seed the shared Queue with local Tracks and focus the Queue/player region immediately.
- Keep Provider views and Queue as sibling navigation targets. Queue can also expand into a focused view for queue operations.
- Use event-driven rendering. Redraw on input, Provider state changes, Player state changes, Queue changes, download state changes, dependency health changes, and app errors.
- While playing, allow coarse 500ms playback-position ticks only if mpv property events are not enough for acceptable progress display.
- While idle or paused, stop playback-position ticks and render only on state changes.
- Throttle download and Provider progress updates separately, targeting no faster than 2 Hz for ordinary status.
- Local accepts explicit files and directories from CLI args and the Local Provider Browsing Surface.
- Local expands directories recursively in stable sorted order, with cancellation and a default soft cap of 10,000 discovered audio files per user action.
- Local does not follow directory symlinks by default. Symlinked files are allowed after resolving them to regular files.
- Local skips hidden directories by default unless the user explicitly selected that hidden directory.
- Local discovers by cheap audio-extension allowlist during directory walks, with explicit unknown-extension files probed by ffprobe.
- Local enqueues quickly using path-derived display names, then fills metadata lazily with low-concurrency ffprobe work.
- Local caches metadata in memory by canonical file path, size, and mtime for the current process.
- Local persists metadata only when needed in Last Queue Snapshot. Do not create a persistent local library index.
- Local dedupe uses canonical local path as Track Identity.
- On restore, missing local files remain visible and unavailable rather than being silently dropped.
- Navidrome Provider is read-only and targeted at Navidrome semantics through Subsonic/OpenSubsonic-compatible JSON endpoints.
- Navidrome authenticates requests with token and salt auth, API version, client name, and JSON format.
- Navidrome validates setup with ping and treats failed Subsonic response payloads as API errors even when HTTP succeeds.
- Navidrome supports read-only playlist browsing, artist browsing, album browsing, and song search-to-queue.
- Navidrome uses ID3 browsing endpoints for artist and album flows. Folder browsing is outside the MVP.
- Navidrome stores all server IDs as strings.
- Navidrome Track Identity is Provider name plus server URL plus song ID. Auth-bearing stream URLs are not persisted as durable identity.
- Navidrome generates authenticated raw stream URLs at playback time and passes them to Player as Playback Locators.
- Navidrome preserves coverArt IDs and only fetches cover art if a later UI surface needs it.
- Navidrome reports now-playing and completed-play with best-effort scrobble calls. Reporting failures never block playback and can be disabled in config.
- Navidrome uses in-memory caches only for MVP. Do not mirror the remote library into a local database.
- Navidrome loads artists once per session and refreshes explicitly. Album lists and search results page lazily.
- YouTube URL Download accepts direct YouTube and YouTube Music URLs only.
- YouTube URL Download rejects search strings, ytsearch-style inputs, playlist URLs, channel URLs, account/library URLs, live streams, and non-YouTube sites.
- YouTube URL Download identifies URLs first with yt-dlp metadata extraction under a finite timeout.
- YouTube URL Download uses lowercased extractor key plus extracted ID as stable identity, usually `youtube:<video-id>`.
- YouTube URL Download stores one media file plus source and TMU metadata sidecars for each cache entry.
- YouTube URL Download uses normalized TMU metadata plus an existing media file as the primary cache lookup.
- YouTube URL Download skips redownload when a complete cache entry exists.
- YouTube URL Download uses best-audio download, no-playlist behavior, stable output templates, resume-capable partial files, a download archive as secondary guard, and line-oriented progress.
- YouTube URL Download runs one download at a time by default.
- YouTube URL Download cancellation terminates the yt-dlp child process and force-kills after a short grace period if needed.
- YouTube URL Download validates the media file, writes normalized cache metadata atomically, and enqueues the cached local file on success.
- Support one optional `youtube.cookies_from_browser` config value passed to yt-dlp as a single argument. Do not copy browser cookies into TMU storage.
- Document that users are responsible for downloading only content they have the right to download and keep.
- Do not attempt to bypass DRM, copy restrictions, account restrictions, region restrictions, or unavailable media.
- TMU Config is a single MVP config file for paths, Provider settings, helper command paths, low-power cadence, dependency policy, Offline YouTube Cache settings, and Navidrome auth fields.
- There is no separate Credentials storage boundary in the MVP, but secret fields must be redacted from normal logs, diagnostics, and UI display.
- Persist only TMU Config, Offline YouTube Cache metadata, Last Queue Snapshot, last selected Provider, shuffle/repeat mode, and volume.
- Do not persist a general app database, persistent local library index, Navidrome mirror, analytics, ratings, favorites, play history, or complete Provider metadata mirror.

## Testing Decisions

- Tests should verify external behavior at stable seams: UI intent in, observable App State, Queue state, Provider calls, Player commands, dependency health, and persisted records out. They should not assert private data structures, render-loop internals, or exact subprocess implementation details unless those details are the public contract of an adapter.
- The highest-value test seam is the App Coordinator intent boundary. Coordinator tests should use fake Providers, a fake Queue persistence layer, a fake Player, fake dependency health, and fake download/cache services to verify complete workflows.
- App Coordinator tests should cover startup without CLI args, startup with CLI-seeded local Tracks, provider navigation intents, enqueue intents, playback control intents, Track resolution, auto-advance, failed resolution, unavailable Tracks, download completion, and dependency-gated actions.
- Queue tests should cover enqueue, identity-based dedupe, remove, move, clear, current index behavior, next/previous, shuffle, repeat-all, Track Availability marking, failed Track visibility, snapshot, and restore.
- Provider contract tests should verify that every Provider produces canonical Tracks with durable Track Identity and resolves playable items into Playback Locators or unavailable state.
- Local Provider tests should use temporary directories and files to verify recursive expansion, stable sorting, cancellation behavior, hidden-directory policy, symlink policy, extension allowlist behavior, unknown-extension probing, dedupe identity, lazy metadata scheduling, soft-cap behavior, and missing-file restore state.
- Navidrome Provider tests should use fake HTTP responses to verify token+salt auth parameters, ping validation, Subsonic failed payload handling, ID string preservation, artist/album browsing, playlist browsing, song search pagination, raw stream URL generation at playback time, coverArt preservation, and best-effort scrobble opt-out/failure handling.
- YouTube URL Download tests should use fake yt-dlp process results to verify URL acceptance/rejection, identify-before-download behavior, stable extractor/id identity, cache-hit skip behavior, output metadata normalization, line-oriented progress parsing, one-download default, cancellation, atomic metadata write behavior, stderr surfacing, and cookies-from-browser argument handling.
- Offline YouTube Cache tests should verify cache lookup by normalized metadata and media presence, Track generation, browse ordering, unavailable media handling, and enqueue behavior.
- Player adapter tests should verify the public mpv controller contract: startup, IPC connection, request IDs, command timeout behavior, load, pause/resume, stop, seek, volume, observed playback state, end-of-file transition, command error recovery, and teardown. Full mpv smoke tests can remain integration tests gated on helper availability.
- Dependency health tests should cover missing, present, configured-path, version-detected, and source-gated helper behavior for mpv, ffprobe, and yt-dlp.
- Low-Power TUI tests should verify the render scheduler contract rather than terminal bytes: input/state changes request immediate redraw, playing state enables coarse progress ticks, idle/paused state disables ticks, and progress/download events are throttled.
- TUI snapshot or golden tests may cover stable major layout states such as source switcher, Provider browsing surface, Queue-focused view, YouTube URL prompt, dependency health message, and unavailable Track display. These should avoid brittle assertions on terminal escape details when a higher-level rendered model is available.
- Persistence tests should cover TMU Config loading, secret redaction, Last Queue Snapshot write/restore, volume/mode/last Provider persistence, Offline YouTube Cache metadata persistence, and corrupted or missing persistence recovery.
- Packaging tests should verify that the compiled Bun executable starts, performs dependency checks, and reports source-specific helper availability on Linux x64.
- Prior art for the tests exists in the wayfinder prototypes: the Low-Power TUI rendering prototype establishes the render cadence seam, the source-switcher/navigation shell prototype establishes the shell behavior, and the Bun mpv controller prototype establishes the Player adapter contract.
- Existing seams should be preferred over adding many new seams. The ideal cross-feature seam is App Coordinator intent testing, with focused adapter contract tests only where external systems require them.

## Out of Scope

- cliamp parity is out of scope, including Spotify, SoundCloud, NetEase, Plex, Jellyfin, radio browser, podcasts, Lua plugins, broad provider expansion, remote control, SSH streaming, themes, lyrics, and rich plugin systems.
- Terminal spectrum visualizers, always-on EQ displays, fixed-FPS render loops, audio sample taps, FFT, and high-frequency animation are out of scope.
- In-process EQ, speed control, mono mode, crossfade, gapless guarantees, audio DSP, native audio bindings, and custom PCM buffering are out of scope.
- YouTube live streaming is out of scope. YouTube playback in the MVP goes through the Offline YouTube Cache.
- YouTube search, Google OAuth, account library browsing, playlist import, liked songs, YouTube-vs-YouTube-Music classification, live downloads, SponsorBlock, comments, chapters, lyrics, thumbnails, broad yt-dlp site support, and automatic cache eviction are out of scope.
- Persistent local media-library indexing, local artist/album database, local file watcher, automatic rescans, smart playlists, named local playlists, playlist import/export, metadata repair, waveform analysis, ReplayGain, fingerprint duplicate detection, and embedded-art extraction are out of scope.
- Navidrome playlist writes, ratings/stars, shares, bookmarks, server-side play queues, server scan controls, internet radio, user management, folder browsing, video, lyrics, OpenSubsonic-only extensions, API-key auth, offline mirroring, and broad non-Navidrome compatibility work are out of scope.
- Daemon/headless mode, IPC, desktop media keys, MPRIS, notifications, background service behavior, rich subcommands, command-line provider search, and remote-control surfaces are out of scope.
- macOS is best-effort until helper discovery, install paths, signing, and terminal behavior are tested. Windows is outside official MVP support until mpv named-pipe IPC, helper discovery, path quoting, terminal behavior, and Bun compiled target behavior are tested on Windows.
- Installing or activating a Go toolchain is out of scope because Bun/TypeScript is the chosen MVP runtime.
- Creating implementation issues is out of scope for this PRD. That belongs to the follow-on issue-slicing step.

## Further Notes

- This PRD was synthesized from the completed Lean TUI Music Player wayfinder map and its resolved research, prototype, and grilling tickets.
- The assumed test seam is App Coordinator intent testing plus focused Provider, Queue, Player, dependency, cache, persistence, and render-scheduler contract tests.
- The implementation should stay small and reversible. Prefer dependency health gates, narrow Provider behavior, and explicit App Coordinator workflows over building broad abstractions before the MVP proves them necessary.
