# TMU TUI Experience

TMU is a keyboard-first YouTube Cache player with three top-level tabs: Playback, Library, and YouTube Downloader. It always opens on Playback and restores the Last Queue Snapshot without autoplay.

## Playback

Playback shows the shared Queue and Current Track. Global playback shortcuts remain available from every tab except while a text input captures keys. Queue entries stay visible when unavailable and show the current runtime reason.

## Library

Library searches only healthy YouTube Cache Tracks by title, uploader, or YouTube video ID. Its actions are Play Now, Play Next, Add to Queue, and confirmed permanent Cache Deletion. Cache Health is a separate non-blocking area for confirmed cleanup of incomplete TMU-shaped entries.

## YouTube Downloader

YouTube Downloader accepts one YouTube URL per submission. Explicit playlists require all-or-cancel confirmation. Accepted Download Batches enter a session-only FIFO Download Pipeline with one active Track download globally. The tab shows active work, progress, pending batches, cancellation/removal actions, and categorical session summaries. Downloading never changes the playback Queue.

## Navigation and help

`1`, `2`, and `3` switch tabs. Vim-style movement and conventional arrow aliases navigate lists. Each tab has contextual shortcut help, while the optional Command Palette exposes actions by name without being required for core workflows.

The canonical domain rules and vocabulary live in [`../CONTEXT.md`](../CONTEXT.md).
