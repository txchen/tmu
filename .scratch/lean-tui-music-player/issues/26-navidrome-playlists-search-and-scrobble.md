# Navidrome Playlists, Search, And Scrobble

Status: resolved

## Parent

../PRD.md

## What to build

Extend the Navidrome Provider with read-only playlist browsing, song search-to-queue, and best-effort playback reporting. Playlists and search results should enqueue canonical Navidrome Tracks into the shared Queue. Reporting should send now-playing and completed-play scrobble calls when enabled, and failures must never block playback.

## Acceptance criteria

- [x] Users can browse Navidrome playlists read-only and enqueue playlist Tracks.
- [x] Navidrome playlist browsing does not use unsupported username filtering.
- [x] Users can search Navidrome songs with simple text and enqueue song results.
- [x] Search results page lazily around the MVP page size.
- [x] Now-playing scrobble reporting is sent when playback starts and reporting is enabled.
- [x] Completed-play scrobble reporting is sent after the local completed-play threshold and reporting is enabled.
- [x] Scrobble reporting failures are visible only as non-blocking state or diagnostics and never block playback.
- [x] Tests cover playlist browsing, search pagination, enqueue, reporting opt-out, now-playing scrobble, completed-play scrobble, and reporting failure behavior.

## Blocked by

- 25 - Navidrome Artist Album Playback Path
