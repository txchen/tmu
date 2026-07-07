# Define MVP Playback And Source Scope

Type: grilling
Status: resolved
Blocked by:

## Question

What exact behavior must the first TMU MVP support across local music, Navidrome, YouTube Music, and the Offline YouTube Cache, and what behavior should be deliberately postponed even if cliamp already has it?

This ticket should end with a short MVP/non-MVP boundary: commands, browse/search expectations, queue controls, playback controls, and persistence expectations.

## Comments

- Decision: the MVP is queue-first. Each provider should feed a shared playback queue; rich source-specific library management is postponed.
- Decision: YouTube Music is download-first in the MVP. YouTube or YouTube Music items are downloaded into the Offline YouTube Cache before playback, rather than streamed live through a yt-dlp pipe.
- Decision: Navidrome needs full artist/album browsing in the MVP, not only playlist/search-to-queue. The browsing surface should still feed the shared queue rather than becoming a separate playback model.
- Decision: local music stays file/folder based in the MVP. It should support opening files/directories and basic metadata display, but no local artist/album index or local media-library database.
- Decision: MVP controls are play/pause, stop, next, previous, supported seeking, add/remove/move/clear queue operations, shuffle, repeat-all, app volume, and remembering the last queue plus selected provider. EQ, speed, crossfade, bookmarks, ratings, named queues, provider playlist editing, and hard gapless requirements are postponed.
- Decision: MVP persistence is limited to config, last selected provider, last queue, shuffle/repeat mode, volume, Offline YouTube Cache metadata, and lightweight Navidrome browse preferences. Local library indexes, play history, scrobbles, ratings/favorites, analytics, and full provider metadata mirrors are postponed.
- Decision: CLI arguments seed the shared queue; launching without arguments starts in the last selected provider when configured, otherwise a source switcher. MVP sources are Local, Navidrome, Offline YouTube Cache, and YouTube URL Download. Rich subcommands, daemon/headless mode, remote control, and command-line provider search are postponed.
- Decision: YouTube discovery in the MVP is URL-only. TMU should accept pasted YouTube/YouTube Music URLs, download them into the Offline YouTube Cache, and enqueue cached tracks. YouTube search, Google OAuth, YouTube Music library browsing, playlist import, liked songs, and YouTube-vs-YouTube-Music classification are postponed.

## Answer

TMU's MVP is a queue-first foreground TUI. Every source feeds one shared queue, and provider browsing exists to enqueue playable items rather than to build a full media manager.

MVP sources:

- Local music: file/folder based only. TMU can open files/directories from CLI args or a configured music root, show basic metadata, and enqueue local files. No local artist/album database, persistent local index, file watcher, duplicate detection, or local smart playlist behavior.
- Navidrome: full remote artist/album browsing is required in the MVP, alongside playlist and likely search support if the API research confirms it is straightforward. Navidrome browsing still feeds the shared queue; it does not create a separate playback model.
- YouTube URL Download: URL-only. TMU accepts pasted YouTube/YouTube Music URLs, downloads them into the Offline YouTube Cache, then plays cached local files. YouTube live streaming, search, Google OAuth, account library browsing, playlist import, liked songs, and YouTube-vs-YouTube-Music classification are not MVP features.
- Offline YouTube Cache: stores downloaded YouTube audio and enough metadata to browse cached downloads and enqueue them.

MVP controls:

- Playback: play/pause, stop, next, previous, supported seeking, and app volume.
- Queue: add, remove, move, clear.
- Modes: shuffle and repeat-all.
- Startup/navigation: CLI arguments seed the queue; launching without arguments starts in the last selected provider when configured, otherwise in a source switcher. The playback view remains available from provider views.

MVP persistence:

- Persist config, last selected provider, last queue, shuffle/repeat mode, volume, Offline YouTube Cache metadata, and lightweight Navidrome browse preferences.
- Do not persist local library indexes, play history, scrobbles, ratings/favorites, analytics, or complete provider metadata mirrors.

Postponed even if cliamp supports it: EQ, speed control, crossfade, bookmarks, named queues, provider playlist editing, hard gapless requirements, daemon/headless mode, remote control, rich subcommands, command-line provider search, broad provider expansion, visualizers, and always-on EQ displays.
