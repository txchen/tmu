# MVP Persistence Completeness

Status: ready-for-agent

## Parent

../PRD.md

## What to build

Complete the MVP persistence surface and recovery behavior. TMU should persist only the approved narrow set: TMU Config, Offline YouTube Cache metadata, Last Queue Snapshot, last selected Provider, shuffle/repeat mode, and volume. It should restore cleanly from missing or corrupted persistence without creating a general app database or Provider metadata mirror.

## Acceptance criteria

- [ ] Last selected Provider is persisted and used on startup without CLI args.
- [ ] Last Queue Snapshot persists and restores Tracks from Local, Navidrome, and Offline YouTube Cache using durable Track Identity.
- [ ] Shuffle mode, repeat-all mode, and volume are persisted and restored.
- [ ] Offline YouTube Cache metadata persists and recovers independently of Last Queue Snapshot.
- [ ] Corrupted or missing persistence files produce clear recoverable state and do not crash startup.
- [ ] Secret fields remain redacted in persistence-related logs, diagnostics, and TUI display.
- [ ] No general app database, persistent local library index, Navidrome mirror, play history, analytics, ratings, favorites, or complete Provider metadata mirror is introduced.
- [ ] Tests cover startup restore, CLI startup overriding source focus as specified, corrupted persistence recovery, secret redaction, cache metadata persistence, and absence of out-of-scope persistence.

## Blocked by

- 16 - TMU Config And Dependency Health Surface
- 17 - Queue State, Modes, And Last Queue Snapshot
- 21 - Local Restore And Track Availability
- 25 - Navidrome Artist Album Playback Path
- 29 - YouTube Download Progress, Cancellation, And Cookies
