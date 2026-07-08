# YouTube Download Progress, Cancellation, And Cookies

Status: ready-for-agent

## Parent

../PRD.md

## What to build

Complete the YouTube URL Download Flow by running yt-dlp downloads for cache misses, showing throttled line-oriented progress, supporting cancellation, validating the downloaded media, writing normalized metadata atomically, and enqueueing the cached Track on success. Support the optional cookies-from-browser config value without copying browser cookies into TMU storage.

## Acceptance criteria

- [ ] Cache misses download with no-playlist behavior, best audio, stable output naming, resume-capable partial files, and a download archive as a secondary guard.
- [ ] Only one YouTube download runs at a time by default.
- [ ] Download progress is parsed from line-oriented yt-dlp output and throttled for TUI display.
- [ ] Cancellation terminates the yt-dlp child process and force-kills after a short grace period if needed.
- [ ] Successful downloads validate the media file before writing normalized TMU metadata.
- [ ] Normalized cache metadata is written atomically.
- [ ] Successful downloads enqueue the resulting cached Track.
- [ ] Optional cookies-from-browser config is passed as a single yt-dlp argument.
- [ ] Browser cookies are not copied into TMU storage.
- [ ] Tests cover download command shape, one-download default, progress parsing and throttling, cancellation, media validation, atomic metadata write, enqueue, cookies argument handling, and failure stderr surfacing.

## Blocked by

- 22 - Low-Power TUI Render Scheduler
- 28 - YouTube URL Identify, Cache Hit, And Enqueue
