# Choose Core Domain And State Boundaries

Type: grilling
Status: resolved
Blocked by: 04, 05, 06, 07, 08

## Question

What are TMU's core modules and domain boundaries once provider, audio, cache, and TUI constraints are known?

Define the stable interfaces between Provider, Track, Queue, Player, Library, Offline YouTube Cache, Config, Credentials, and UI state. The answer should be implementation-oriented enough to support issue slicing but should not implement code.

## Answer

TMU's MVP should use a queue-first domain shape:

```text
Provider -> Track -> Queue -> App Coordinator -> Player
                         ^              |
                         |              v
                      UI State      App State
```

Core decisions:

- `Track` is the canonical playable item across every Provider. Local files, Navidrome songs, and Offline YouTube Cache entries should all enter the Queue as Tracks rather than creating provider-specific playback paths.
- A Track has a durable `Track Identity` separate from a runtime `Playback Locator`. Durable identity is used for dedupe, queue restore, and provider refresh; playback locators are generated when playback starts and may be local file paths or auth-bearing stream URLs.
- `Provider` owns browsing/search/open-input behavior and resolving Track identities into Playback Locators. The Queue stays provider-agnostic.
- `Queue` owns ordered Track entries, current index, identity-based dedupe, queue mutations, visible availability/failure state, and Last Queue Snapshot restore behavior.
- `Player` is only the mpv boundary: load a Playback Locator, control playback, and report playback state. It does not know about Providers, Queue, metadata fetching, or auto-advance.
- `App Coordinator` owns workflows between UI intents, Provider resolution, Queue mutation, and Player commands. The TUI should dispatch intents and render state, not orchestrate playback rules directly.
- Do not introduce a top-level `Library` module in the MVP. Library-like behavior should remain Provider-specific browsing: Local file/directory opening, Navidrome artist/album/search browsing, and Offline YouTube Cache listing.
- Offline YouTube Cache is both storage and a Provider for cached tracks. The YouTube URL Download Flow downloads into the cache and then enqueues cached Tracks; it is not a live YouTube playback Provider.
- `TMU Config` is one MVP config file that can include both non-secret settings and credential material. There is no separate Credentials storage boundary in the MVP, but secret fields must not be logged or displayed casually.
- Split App State from UI State. App State owns providers, Queue, playback, downloads, availability, and app errors. UI State owns focused pane, selected row, active prompt, filter text, and scroll positions.
- Unavailable or failed Tracks remain visible in the Queue rather than being silently removed. The App Coordinator may skip them during auto-advance, but user-visible state should explain what failed.
- Default queue dedupe is by Track Identity: same canonical local path, same Navidrome server URL plus song ID, or same Offline YouTube Cache extractor plus ID should not enqueue twice by default.
- Persistence should stay narrow: TMU Config, Offline YouTube Cache metadata, a Last Queue Snapshot, and small nearby preferences such as last volume/current source. Do not add a general app database, persistent local library index, Navidrome mirror, play-history database, or generic app-state database in the MVP.

Interface sketch for issue slicing:

```text
Provider
  browse/open/search -> Track[]
  resolve(track.identity) -> PlaybackLocator | unavailable
  refresh(track.identity) -> Track | unavailable

Queue
  enqueue(track)
  remove/reorder/clear()
  current/next/previous()
  markAvailability(track.identity, availability)
  snapshot()/restore(snapshot)

Player
  load(locator)
  playPause()
  stop()
  seek()
  setVolume()
  observePlaybackState()

App Coordinator
  handle UI intents
  resolve queued Tracks through Providers
  load Playback Locators into Player
  advance on ended/failed according to Queue policy
  coordinate download completion into Offline YouTube Cache tracks
```

Glossary updates were captured in [CONTEXT.md](../../CONTEXT.md).
