# Local Folder Browsing And Enqueue

Status: ready-for-agent

## Parent

../PRD.md

## What to build

Implement the Local Provider Browsing Surface for selecting files and directories from inside the TUI. Directory selection should recursively expand audio files in stable sorted order, enqueue quickly into the shared Queue, and respect the MVP policies for cancellation, soft caps, hidden directories, symlinks, extension allowlists, and lazy metadata.

This slice should not create a persistent local library index or local artist/album database.

## Acceptance criteria

- [ ] The Local Provider Browsing Surface lets the user choose explicit files and directories for enqueue.
- [ ] Directory expansion is recursive, stable, sorted, cancellable, and bounded by the configured soft cap.
- [ ] Directory symlinks are not followed by default.
- [ ] Symlinked files are accepted only after resolving to regular files.
- [ ] Hidden directories are skipped unless the user explicitly selected that hidden directory.
- [ ] Directory walks use the MVP audio-extension allowlist and avoid probing every discovered file.
- [ ] Enqueued Local Tracks enter the same shared Queue as CLI-seeded Tracks.
- [ ] No persistent local library index, watcher, or local playlist manager is introduced.
- [ ] Tests cover directory expansion, cancellation, cap behavior, hidden directory policy, symlink policy, extension allowlist behavior, enqueue, and absence of persistent indexing.

## Blocked by

- 15 - Walking Skeleton For Queue-First TMU
- 17 - Queue State, Modes, And Last Queue Snapshot
- 19 - Local CLI File Playback End To End
