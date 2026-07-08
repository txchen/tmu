# Queue State, Modes, And Last Queue Snapshot

Status: ready-for-agent

## Parent

../PRD.md

## What to build

Implement Queue behavior for canonical Tracks and wire it into the App Coordinator and TUI shell. The Queue should support enqueue, identity-based dedupe, remove, move, clear, current Track selection, next, previous, shuffle, repeat-all, visible Track Availability, and Last Queue Snapshot persistence.

This slice should remain Provider-agnostic. It may use fake or stub Providers to enqueue Tracks, but the completed behavior must be visible in App State and the TUI.

## Acceptance criteria

- [ ] Tracks from any Provider can be enqueued into one shared Queue.
- [ ] Duplicate Tracks are avoided by durable Track Identity by default.
- [ ] Queue remove, move, clear, current, next, and previous behavior works through App Coordinator intents.
- [ ] Shuffle and repeat-all modes are represented in App State and affect Queue navigation as specified.
- [ ] Track Availability can be marked and remains visible in the Queue.
- [ ] A Last Queue Snapshot can be saved and restored with Queue contents, current position, shuffle mode, repeat mode, and volume-ready state.
- [ ] Restored Tracks keep durable Track Identity and do not require Playback Locators to have been persisted.
- [ ] Tests cover Queue operations, dedupe, modes, availability marking, snapshot, restore, and App Coordinator integration.

## Blocked by

- 15 - Walking Skeleton For Queue-First TMU
