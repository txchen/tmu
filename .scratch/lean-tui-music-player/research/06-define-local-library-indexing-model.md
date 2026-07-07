# Define Local Library Indexing Model

Research date: 2026-07-07

## Recommendation

TMU should not build a persistent local music library index in the MVP. Local music should be an explicit input source: the user opens files, directories, or configured roots; TMU expands those paths into queue candidates; metadata is probed lazily or in a bounded background batch; playback uses the same mpv controller as every other source.

This matches the already-decided MVP boundary: local music is file/folder based, not artist/album database based, and the shared queue is the primary user object. See [Define MVP Playback And Source Scope](../issues/01-define-mvp-playback-and-source-scope.md).

## Primary Sources And Local Facts

- Bun 1.3.11 is available in this workspace. Bun documents Node.js API compatibility, so TMU can use the standard `node:fs`, `node:path`, and process APIs from TypeScript for traversal and subprocess work. Sources: [Bun Node.js APIs](https://bun.com/docs/runtime/nodejs-apis), local check: `bun --version`.
- Node's `fs.readdir`/`fsPromises.readdir` support directory reads with options, and modern Node documents recursive reads through the `recursive` option. TMU can still implement its own async iterator walker for better caps, cancellation, symlink policy, and progress reporting. Source: [Node.js fs docs](https://nodejs.org/api/fs.html#fspromisesreaddirpath-options).
- Node's `fs.watch` docs warn that filesystem watching behavior is not fully consistent across platforms and can be unreliable or unavailable in some conditions. That makes a background file watcher a poor MVP fit for a battery-focused TUI. Source: [Node.js fs.watch caveats](https://nodejs.org/api/fs.html#fswatchfilename-options-listener).
- ffprobe can emit machine-readable JSON with selected stream, format, and tag fields via `-show_entries` and `-of json`; a local smoke check against cliamp's bundled MP3 returned codec, duration, title, and artist without decoding audio. Source: [ffprobe documentation](https://ffmpeg.org/ffprobe.html), local command: `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type,codec_name:format=duration:format_tags=title,artist,album,genre,date -of json`.
- The installed ffmpeg/ffprobe build has demuxers for the common MVP audio containers TMU should consider discoverable by extension: MP3, FLAC, Ogg, WAV, AAC, MP4/M4A, Matroska/WebM, APE, WavPack, and TTA. Source: local `ffmpeg -hide_banner -demuxers`; upstream source for demuxer/format behavior: [FFmpeg formats documentation](https://ffmpeg.org/ffmpeg-formats.html).
- mpv 0.41.0 is available locally and is already the chosen playback authority for TMU. Therefore local discovery should not try to perfectly duplicate mpv's full playable-format matrix; it should find likely audio files cheaply and let mpv/ffprobe make the final call. Sources: [Choose Audio Playback And Decode Strategy](../issues/04-choose-audio-playback-and-decode-strategy.md), [mpv manual](https://mpv.io/manual/stable/), local check: `mpv --version`.
- cliamp's local provider is a durable playlist manager backed by TOML files in `~/.config/cliamp/playlists/`, with creation, writes, bookmarks, search, history, imports/exports, enrichment, and feed handling. That is useful as a cautionary example, but larger than TMU's MVP local source. Sources: [/home/txchen/code/github/cliamp/external/local/provider.go](/home/txchen/code/github/cliamp/external/local/provider.go), [/home/txchen/code/github/cliamp/docs/playlists.md](/home/txchen/code/github/cliamp/docs/playlists.md).
- cliamp's reusable local lessons are narrower than its feature surface: reject path traversal for named local files, skip exact duplicate paths when appending, store basic track metadata as optional fields, and use ffprobe-style enrichment rather than decoding in the TUI path. Sources: [/home/txchen/code/github/cliamp/external/local/provider.go](/home/txchen/code/github/cliamp/external/local/provider.go), [/home/txchen/code/github/cliamp/player/ffmpeg.go](/home/txchen/code/github/cliamp/player/ffmpeg.go).

## Local Source Model

Represent local items as `Track` records with:

- `provider = "local"`
- `id = canonical file path` for MVP identity
- `path = absolute file path` for playback
- `title = metadata title || basename without extension`
- optional `artist`, `album`, `genre`, `year`, `trackNumber`, `durationSeconds`
- optional `mtimeMs` and `sizeBytes` for stale metadata detection inside persisted queue snapshots

Do not create local `Artist`, `Album`, or `Playlist` domain objects in the MVP. Those concepts belong to Navidrome and the Offline YouTube Cache, not to the simple local file source.

## Discovery Behavior

TMU should support three local entry points:

1. CLI args: `tmu file.flac dir/ other.mp3` expands into the shared queue.
2. Local source view: a configured list of roots, plus a minimal file browser/open-path action.
3. Last queue restore: restore previously enqueued local tracks by path, marking missing files as unavailable rather than rescanning the library.

Directory expansion should be explicit and user-triggered:

- Recursively walk selected directories.
- Sort entries by path for stable queue order.
- Skip directories that cannot be read and report a count, not a fatal error.
- Do not follow directory symlinks by default, to avoid cycles.
- Allow symlinked files if their target resolves to a regular file.
- Skip hidden directories by default unless the hidden directory itself was explicitly selected.
- Stop at a configurable cap; use 10,000 discovered audio files as the default MVP soft cap and show a truncation notice when reached.

No watcher or automatic rescan should run in the MVP. A user can re-open or refresh a directory when they want TMU to notice changes.

## Supported Formats

Use a conservative extension allowlist for cheap directory discovery:

- Required: `.mp3`, `.flac`, `.m4a`, `.aac`, `.ogg`, `.opus`, `.wav`
- Useful and cheap if mpv/ffmpeg are present: `.webm`, `.weba`, `.mp4`, `.aiff`, `.aif`, `.ape`, `.wv`

For an explicitly selected file, TMU may attempt ffprobe even when the extension is unknown. If ffprobe reports an audio stream, enqueue it. If ffprobe fails, report it as unsupported before playback. This avoids making the extension list a false authority while keeping directory scans cheap.

## Metadata Extraction

Metadata should be best-effort and non-blocking:

- On directory expansion, enqueue quickly using path-derived titles.
- Probe visible rows and currently playing/next tracks first.
- Probe additional queued tracks in a low-concurrency background batch, default concurrency 1 or 2.
- Use `ffprobe -v error -select_streams a:0 -show_entries stream=codec_type,codec_name:format=duration:format_tags=title,artist,album,genre,date,track -of json <path>`.
- Treat ffprobe failure as "metadata unknown", not as "track unplayable"; mpv remains the playback authority.
- Cache probe results in memory by `realpath + size + mtimeMs` during the process lifetime.

Persist metadata only as part of the last queue snapshot. Do not maintain a separate local metadata database, repair job, embedded-art cache, lyrics extraction, ReplayGain scan, waveform cache, or local search index in the MVP.

## Duplicate Handling

Use exact canonical path duplicate handling only:

- When expanding a directory into the current queue, skip files whose canonical path is already queued from the same local provider.
- When the same physical file is reached through two symlink paths, keep the first canonical path and skip the later duplicate.
- Do not do audio fingerprinting, tag-based duplicate detection, album-version collapsing, or "same title/artist" heuristics in the MVP.

This is intentionally simpler than a media-server clone and avoids expensive whole-library analysis.

## Playlists

Do not implement a local playlist manager in the MVP. The shared queue plus last-queue persistence is enough.

Postpone:

- named local playlists
- TOML playlist files
- M3U/M3U8/PLS import/export
- playlist editing commands
- bookmarks
- local smart playlists
- local history

If implementation discovers that M3U loading is a tiny vertical slice, it can be added later as "open this playlist file and expand it into the queue", but it should not become a provider-level local playlist browser.

## Performance Limits

Default MVP limits:

- Directory expansion cap: 10,000 audio files per user action.
- Metadata probing concurrency: 1 by default, 2 maximum unless profiling says otherwise.
- No background work while idle except the active mpv process and user-requested metadata probes.
- Cancel directory expansion and pending probes when the user switches roots, clears the queue, or exits.
- Surface partial results quickly; do not block the TUI until the whole directory is scanned.

For very large folders, TMU should favor an honest truncation warning over silently becoming a local media server. A future local-library feature can revisit a persistent SQLite index, file watching, rescans, and richer duplicate detection if users actually need it.

## Decision

TMU local music MVP should use a direct file/directory playback model with a bounded in-memory metadata cache. It should not use a persistent local library index or a hybrid local database.

Implement:

1. Explicit file/folder open from CLI args and the local source view.
2. Recursive, sorted, cancellable directory expansion with symlink-cycle protection and a 10,000-audio-file soft cap.
3. Cheap extension filtering for common audio files, plus ffprobe validation for explicit unknown-extension files.
4. Lazy ffprobe metadata extraction for display and queue persistence.
5. Exact canonical-path duplicate skipping within the shared queue.
6. Last-queue restore that marks missing local files unavailable.

Postpone local artist/album browsing, persistent indexes, file watchers, named local playlists, playlist import/export, smart playlists, bookmarks, play history, embedded art extraction, lyrics extraction, metadata repair, and fingerprint duplicate detection.
