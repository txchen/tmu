# MVP Persistence Completeness

Status: resolved

## Parent

../PRD.md

## What to build

Complete the MVP persistence surface and recovery behavior. TMU should persist only the approved narrow set: TMU Config, Offline YouTube Cache metadata, Last Queue Snapshot, last selected Provider, shuffle/repeat mode, and volume. It should restore cleanly from missing or corrupted persistence without creating a general app database or Provider metadata mirror.

## Acceptance criteria

- [x] Last selected Provider is persisted and used on startup without CLI args.
- [x] Last Queue Snapshot persists and restores Tracks from Local, Navidrome, and Offline YouTube Cache using durable Track Identity.
- [x] Shuffle mode, repeat-all mode, and volume are persisted and restored.
- [x] Offline YouTube Cache metadata persists and recovers independently of Last Queue Snapshot.
- [x] Corrupted or missing persistence files produce clear recoverable state and do not crash startup.
- [x] Secret fields remain redacted in persistence-related logs, diagnostics, and TUI display.
- [x] No general app database, persistent local library index, Navidrome mirror, play history, analytics, ratings, favorites, or complete Provider metadata mirror is introduced.
- [x] Tests cover startup restore, CLI startup overriding Provider focus as specified, corrupted persistence recovery, secret redaction, cache metadata persistence, and absence of out-of-scope persistence.

## Blocked by

- 16 - TMU Config And Dependency Health Surface
- 17 - Queue State, Modes, And Last Queue Snapshot
- 21 - Local Restore And Track Availability
- 25 - Navidrome Artist Album Playback Path
- 29 - YouTube Download Progress, Cancellation, And Cookies

## Answer

Implemented the MVP persistence completion pass. TMU now has a narrow app preferences persistence record for the last selected Provider target and routine playback settings, restores Last Queue Snapshot state during no-arg startup, lets CLI args seed a fresh Queue while focusing Queue, refreshes restored Local and Offline YouTube Cache availability through Provider identities, and keeps Offline YouTube Cache metadata as independent sidecar storage. Missing or corrupted snapshot/preferences files recover to Local startup without crashing, and persistence remains limited to config, cache sidecars, last queue snapshot, last selected Provider, modes, and volume.

Validation: `bun run typecheck` and `bun test` pass.
