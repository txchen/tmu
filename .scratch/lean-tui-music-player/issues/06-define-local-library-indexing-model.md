# Define Local Library Indexing Model

Type: research
Status: resolved
Blocked by: 01

## Question

How should TMU discover, index, and play local music in the MVP without becoming a full media-server clone?

Decide whether the MVP uses direct file/directory playback only, a persistent local library index, or a hybrid. Include metadata extraction, supported formats, watch/rescan behavior, duplicate handling, playlists, and performance limits for large libraries.

## Answer

Research note: [06-define-local-library-indexing-model.md](../research/06-define-local-library-indexing-model.md)

TMU's local music MVP should use direct file/directory playback only. It should not create a persistent local library index, local artist/album database, file watcher, or local playlist manager.

Required MVP local behavior:

- Accept explicit local files and directories from CLI args and from the Local source view.
- Expand directories recursively, in stable sorted order, with cancellation and a default soft cap of 10,000 discovered audio files per user action.
- Do not follow directory symlinks by default; allow symlinked files after resolving them to regular files.
- Skip hidden directories by default unless the user explicitly selected that hidden directory.
- Discover by a cheap audio-extension allowlist for directory walks: `.mp3`, `.flac`, `.m4a`, `.aac`, `.ogg`, `.opus`, `.wav`, with `.webm`, `.weba`, `.mp4`, `.aiff`, `.aif`, `.ape`, and `.wv` acceptable when mpv/ffmpeg are present.
- For explicitly selected unknown-extension files, try ffprobe; enqueue only if it reports an audio stream.
- Enqueue quickly with path-derived display names, then fill metadata lazily with low-concurrency ffprobe calls.
- Cache metadata in memory by `realpath + size + mtimeMs` for the current process, and persist metadata only as part of the last queue snapshot.
- Deduplicate only by canonical local path within the shared queue.
- On last-queue restore, keep missing local files visible but mark them unavailable rather than rescanning a library.

Postpone named local playlists, M3U/M3U8/PLS import/export, TOML playlists, playlist editing commands, local smart playlists, bookmarks, play history, embedded-art extraction, lyrics extraction, metadata repair, ReplayGain/waveform analysis, fingerprint duplicate detection, persistent SQLite indexing, automatic rescans, and filesystem watching.

This deliberately keeps Local much simpler than cliamp: it is a queue feeder and file opener, not a local media server.
