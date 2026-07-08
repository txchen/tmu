# Queue-Focused View And Persistent Player Strip

Status: ready-for-agent

## Parent

../PRD.md

## What to build

Make the Queue and current Player status ergonomic in the TUI. The persistent queue/player strip should remain visible while browsing Providers, and the Queue source should expand into a focused Queue view for inspect, reorder, remove, clear, start, seek, volume, shuffle, repeat-all, and unavailable Track display.

This slice turns the already-working Queue and Player behavior into the core user-facing playback surface.

## Acceptance criteria

- [ ] The persistent queue/player strip shows current Track, playback state, progress, volume, shuffle, repeat-all, and basic availability information.
- [ ] Provider browsing keeps queue/player context visible.
- [ ] The Queue source opens an expanded Queue view.
- [ ] The expanded Queue view supports remove, move, clear, start selected Track, next, previous, play/pause, stop, seek, volume, shuffle, and repeat-all through App Coordinator intents.
- [ ] Unavailable Tracks remain visible with useful status in both persistent and expanded Queue surfaces.
- [ ] Layout states are covered by stable snapshot or rendered-model tests without brittle terminal escape assertions.
- [ ] App Coordinator tests cover Queue-focused user workflows end to end.

## Blocked by

- 17 - Queue State, Modes, And Last Queue Snapshot
- 18 - mpv Player Adapter And Playback Controls
- 22 - Low-Power TUI Render Scheduler
