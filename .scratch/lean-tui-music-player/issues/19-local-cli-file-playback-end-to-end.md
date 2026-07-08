# Local CLI File Playback End To End

Status: ready-for-agent

## Parent

../PRD.md

## What to build

Make explicit local audio files passed as CLI arguments seed the shared Queue and play through the mpv Player path. TMU should derive initial display metadata quickly, lazily fill metadata with ffprobe when available, dedupe by canonical local path, and focus the Queue/player region on startup with seeded Tracks.

This is the first real Provider-to-Queue-to-Player tracer bullet for TMU.

## Acceptance criteria

- [ ] CLI file arguments are interpreted as Local Tracks and added to the shared Queue on startup.
- [ ] Startup with CLI file arguments focuses the Queue/player region immediately.
- [ ] Local Track Identity uses canonical local path and does not use display title or Playback Locator as identity.
- [ ] Common audio extensions are accepted cheaply for explicit files.
- [ ] Explicit unknown-extension files are probed with ffprobe when available and only enqueued if they contain audio.
- [ ] Initial display names are available before lazy metadata completes.
- [ ] Lazy metadata updates App State and the TUI without blocking enqueue.
- [ ] Seeded local Tracks can be loaded through the App Coordinator into mpv playback.
- [ ] Tests cover CLI seeding, identity/dedupe, unknown-extension probing, lazy metadata, Queue focus, and playback handoff.

## Blocked by

- 16 - TMU Config And Dependency Health Surface
- 17 - Queue State, Modes, And Last Queue Snapshot
- 18 - mpv Player Adapter And Playback Controls
