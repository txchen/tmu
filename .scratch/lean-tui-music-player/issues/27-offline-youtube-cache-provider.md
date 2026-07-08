# Offline YouTube Cache Provider

Status: resolved

## Parent

../PRD.md

## What to build

Implement the Offline YouTube Cache as both storage and a Provider for cached Tracks. TMU should read normalized cache metadata, verify media presence, expose cached entries in a Provider Browsing Surface, enqueue cached Tracks into the shared Queue, and play cached media through the same Local-file mpv path.

This slice does not need to run yt-dlp yet. It prepares the cache behavior that the YouTube URL Download Flow will feed.

## Acceptance criteria

- [x] Offline YouTube Cache entries are discovered from normalized TMU metadata plus media file presence.
- [x] Cache entries produce canonical Tracks with durable extractor/id Track Identity.
- [x] Missing media files are represented as unavailable cache entries rather than crashing or disappearing silently.
- [x] Users can browse Offline YouTube Cache entries as a Provider.
- [x] Users can enqueue cached Tracks into the shared Queue.
- [x] Cached Tracks resolve to local media Playback Locators and play through mpv.
- [x] Cache metadata persistence is covered without introducing a broad app database.
- [x] Tests cover cache lookup, metadata parsing, media presence checks, Track generation, browse ordering, unavailable media, enqueue, and playback resolution.

## Blocked by

- 16 - TMU Config And Dependency Health Surface
- 17 - Queue State, Modes, And Last Queue Snapshot
- 18 - mpv Player Adapter And Playback Controls
