# Local Restore And Track Availability

Status: ready-for-agent

## Parent

../PRD.md

## What to build

Complete Local restore behavior and Track Availability for missing or failed local files. When a Last Queue Snapshot references a Local Track that no longer resolves to a playable file, TMU should keep it visible in the Queue as unavailable instead of silently removing it. Playback and auto-advance should handle unavailable local Tracks predictably.

## Acceptance criteria

- [ ] Restored Local Tracks are checked for current file availability.
- [ ] Missing restored local files remain visible in the Queue as unavailable.
- [ ] Unavailable Local Tracks display an actionable availability reason in App State and TUI.
- [ ] Attempting to play an unavailable Local Track does not crash the app or erase the Track.
- [ ] Auto-advance can skip unavailable local Tracks while preserving visible failure state.
- [ ] Restoring a Queue does not rescan a local library or rebuild an index.
- [ ] Tests cover missing restored files, failed playback resolution, visible availability state, auto-advance skip behavior, and no library rescan.

## Blocked by

- 17 - Queue State, Modes, And Last Queue Snapshot
- 19 - Local CLI File Playback End To End
