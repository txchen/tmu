# mpv Player Adapter And Playback Controls

Status: resolved

## Parent

../PRD.md

## What to build

Implement the Player boundary around a long-lived audio-only mpv subprocess controlled through JSON IPC. Wire playback controls through the App Coordinator so queued Tracks can resolve to Playback Locators and be loaded, paused, resumed, stopped, seeked, and volume-adjusted without the TUI owning Player rules.

The Player should expose observed playback state, command failures, and reliable end-of-file transitions while preserving command recovery and clean teardown.

Prototype context: the Bun mpv controller prototype validates the intended subprocess and JSON IPC shape.

## Acceptance criteria

- [ ] Player starts one long-lived audio-only idle mpv process when playback is available.
- [ ] Player sends mpv JSON IPC commands with request IDs and command timeouts.
- [ ] Player supports load, play/pause, stop, seek, set volume, and teardown.
- [ ] Player observes playback state needed by App State, including position, duration, pause state, idle state, and end-of-file transition.
- [ ] Player treats command failures as recoverable state and allows later commands and teardown.
- [ ] App Coordinator resolves queued Tracks into Playback Locators before loading Player.
- [ ] Missing mpv dependency health prevents playback attempts cleanly.
- [ ] Tests cover the Player contract with fakes and include an integration smoke path gated on mpv availability.

## Blocked by

- 15 - Walking Skeleton For Queue-First TMU
- 16 - TMU Config And Dependency Health Surface
- 17 - Queue State, Modes, And Last Queue Snapshot
