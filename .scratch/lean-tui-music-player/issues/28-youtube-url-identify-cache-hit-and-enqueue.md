# YouTube URL Identify, Cache Hit, And Enqueue

Status: resolved

## Parent

../PRD.md

## What to build

Implement the first YouTube URL Download Flow tracer bullet: paste a direct YouTube or YouTube Music URL, validate that it is in MVP scope, identify it with yt-dlp metadata extraction under a finite timeout, check the Offline YouTube Cache, and enqueue the cached Track when it already exists.

This slice should establish URL validation, identity, metadata normalization, cache-hit behavior, dependency gating, and user-facing failure messages before adding full download execution.

## Acceptance criteria

- [x] YouTube URL Download accepts direct YouTube and YouTube Music URLs.
- [x] YouTube URL Download rejects search strings, ytsearch-style inputs, playlists, channels, account/library URLs, live streams, and non-YouTube sites with clear messages.
- [x] yt-dlp identify runs before any download attempt and uses a finite timeout.
- [x] Stable identity uses lowercased extractor key plus extracted ID.
- [x] Existing complete cache entries are detected from normalized metadata plus media file presence.
- [x] Cache hits enqueue the cached Track without redownloading.
- [x] Missing yt-dlp disables this source action while leaving other sources usable.
- [x] yt-dlp identify stderr is surfaced when it explains unavailable, restricted, bot-detected, DRM, or region failures.
- [x] Tests cover accepted URL forms, rejected inputs, identify timeout, identity generation, cache-hit enqueue, dependency gating, stderr surfacing, and no-redownload behavior.

## Blocked by

- 16 - TMU Config And Dependency Health Surface
- 17 - Queue State, Modes, And Last Queue Snapshot
- 27 - Offline YouTube Cache Provider
