# Define YouTube URL Download Pipeline

Research date: 2026-07-07

## Recommendation

TMU should implement YouTube/YouTube Music as a URL-only, download-first provider. A pasted URL is resolved through `yt-dlp`, downloaded into the Offline YouTube Cache if missing, normalized into TMU cache metadata, and then played as a local file through the shared mpv controller.

Do not live-stream YouTube through yt-dlp in the MVP. Do not implement YouTube search, Google OAuth, account library browsing, playlist import, liked songs, or YouTube-vs-YouTube-Music classification. This follows [Define MVP Playback And Source Scope](../issues/01-define-mvp-playback-and-source-scope.md).

## Primary Sources And Local Facts

- `yt-dlp` 2026.03.17 is installed locally. Its own warning says this local version is more than 90 days old as of this research date, so TMU should surface yt-dlp failures clearly and packaging should document that a fresh yt-dlp matters. Source: local `yt-dlp --version` and `yt-dlp` warning during URL extraction.
- `yt-dlp --help` documents `--no-playlist`, `--download-archive`, retry controls, `--paths`, output templates, `.part` files, `--write-info-json`, `--cookies-from-browser`, `--dump-json`/`--dump-single-json`, `--print`, `--newline`, `--progress-template`, `--extract-audio`, `--audio-format`, and `--embed-metadata`. Source: local `yt-dlp --help`.
- `yt-dlp --help` documents `--cookies-from-browser BROWSER[+KEYRING][:PROFILE][::CONTAINER]` and lists supported browsers including Brave, Chrome, Chromium, Edge, Firefox, Opera, Safari, Vivaldi, and Whale. Source: local `yt-dlp --help`.
- `yt-dlp --help` says `--write-info-json` may contain personal information; TMU should not treat raw infojson as harmless display data. Source: local `yt-dlp --help`.
- `yt-dlp --list-extractors` includes `youtube`, `youtube:music:search_url`, `youtube:playlist`, `youtube:tab`, and related YouTube extractors, but TMU should accept only direct video/music URLs in the MVP. Source: local `yt-dlp --list-extractors`.
- Bun documents `Bun.spawn()` for child processes, stdout/stderr handling, exit handling, process killing, timeout, and AbortSignal support, which is enough for line-oriented yt-dlp progress and cancellation from TypeScript. Source: [Bun child process docs](https://bun.com/docs/runtime/child-process).
- The XDG Base Directory Specification defines `$XDG_DATA_HOME` for user-specific data and `$XDG_CACHE_HOME` for non-essential cached data. Offline media should live under data, while temporary download fragments can live under cache. Source: [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/).
- YouTube's Terms of Service restrict downloading or otherwise using content except as authorized by the service or with permission, and restrict circumventing features that prevent copying or limit use. TMU should make this a user-responsibility policy and should not present the feature as a terms bypass. Source: [YouTube Terms of Service](https://www.youtube.com/t/terms).
- cliamp streams yt-dlp output through a yt-dlp plus ffmpeg pipe and carries hard-earned subprocess lessons: use explicit timeouts, capture stderr, surface the upstream error instead of a generic EOF, and kill both child processes on close. TMU should reuse those process-control lessons but not cliamp's live-streaming architecture. Sources: [/home/txchen/code/github/cliamp/player/ytdl.go](/home/txchen/code/github/cliamp/player/ytdl.go), [/home/txchen/code/github/cliamp/docs/yt-dlp.md](/home/txchen/code/github/cliamp/docs/yt-dlp.md).

## Scope Boundary

Accepted input:

- Direct YouTube and YouTube Music URLs that resolve to one playable item.
- URLs may contain extra query parameters, including playlist context, but TMU must pass `--no-playlist` so a watch URL downloads only the selected item.

Rejected or postponed:

- Search strings and `ytsearch:` pseudo-URLs.
- Playlist, channel, album, radio, mix, liked-song, library, and subscription import.
- Google OAuth.
- YouTube Data API usage.
- Live streams and currently live premieres.
- DRM/copy-protected content or attempts to bypass unavailable formats.
- Non-YouTube sites, even if yt-dlp supports them.

This keeps the MVP honest: a URL becomes one cached local track.

## Cache Layout

Use an app-owned data directory:

```text
$XDG_DATA_HOME/tmu/offline-youtube/
  youtube/<video-id>/
    media.<ext>
    source.info.json
    tmu.json
  download-archive.txt

$XDG_CACHE_HOME/tmu/yt-dlp-tmp/
  ...
```

Fallbacks:

- `$XDG_DATA_HOME` unset: `~/.local/share/tmu/offline-youtube`
- `$XDG_CACHE_HOME` unset: `~/.cache/tmu/yt-dlp-tmp`

Use permissions `0700` for directories and `0600` for metadata files where possible. Media files can inherit the process umask.

Use stable ID directories rather than title-based identity. The normalized cache key is:

```text
<extractor_key lowercased>:<id>
```

For YouTube, this is usually `youtube:<video-id>`. Titles, channels, thumbnails, and webpage URLs are metadata, not identity.

## Metadata Model

Keep two metadata layers:

1. `source.info.json`: yt-dlp's cleaned infojson, written with `--write-info-json --clean-info-json --no-write-comments`.
2. `tmu.json`: TMU's small stable manifest for browse, queue restore, and cache lookup.

`tmu.json` should contain:

```json
{
  "schemaVersion": 1,
  "provider": "youtube-cache",
  "source": "youtube",
  "sourceId": "VIDEO_ID",
  "cacheKey": "youtube:VIDEO_ID",
  "originalUrl": "https://...",
  "webpageUrl": "https://...",
  "title": "Title",
  "artist": "Uploader or channel",
  "album": "",
  "durationSeconds": 123,
  "thumbnailUrl": "https://...",
  "mediaPath": "/absolute/path/to/media.ext",
  "mediaExt": "m4a",
  "downloadedAt": "2026-07-07T00:00:00.000Z",
  "ytDlpVersion": "2026.03.17"
}
```

Do not expose raw `source.info.json` wholesale in the TUI. It can contain more information than the player needs.

## Two-Phase Pipeline

### Phase 1: identify

Run a metadata-only command with a finite timeout:

```sh
yt-dlp \
  --skip-download \
  --no-playlist \
  --dump-single-json \
  --socket-timeout 15 \
  <optional cookies args> \
  "$url"
```

Parse JSON and require:

- an extractor key that is YouTube/YouTube Music compatible
- a non-empty `id`
- not live/currently live
- one item, not a playlist import

Then check the cache by `cacheKey`. If `tmu.json` exists and `mediaPath` exists, enqueue that local file immediately. If `tmu.json` is missing but the stable ID directory contains exactly one playable `media.*`, reconstruct minimal metadata from `source.info.json` and repair `tmu.json`.

### Phase 2: download

Run one download job at a time by default:

```sh
yt-dlp \
  --no-playlist \
  --match-filter '!is_live' \
  -f 'bestaudio[acodec!=none]/bestaudio/best' \
  --extract-audio \
  --audio-format best \
  --paths "home:$XDG_DATA_HOME/tmu/offline-youtube" \
  --paths "temp:$XDG_CACHE_HOME/tmu/yt-dlp-tmp" \
  --output '%(extractor_key)s/%(id)s/media.%(ext)s' \
  --output 'infojson:%(extractor_key)s/%(id)s/source.info.json' \
  --write-info-json \
  --clean-info-json \
  --no-write-comments \
  --download-archive "$XDG_DATA_HOME/tmu/offline-youtube/download-archive.txt" \
  --continue \
  --part \
  --retries 10 \
  --fragment-retries 10 \
  --socket-timeout 15 \
  --newline \
  --progress \
  --progress-template 'download:%(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s' \
  --print after_move:filepath \
  <optional cookies args> \
  "$url"
```

After the process exits successfully:

1. Read the `after_move:filepath` line or locate `media.*` in the stable ID directory.
2. Validate the resulting file exists and is non-empty.
3. Optionally run ffprobe if duration or codec metadata is missing.
4. Write `tmu.json` atomically.
5. Enqueue the resulting local file.

The format choice intentionally avoids a default MP3 transcode. Keep the downloaded audio in yt-dlp/ffmpeg's best audio-only output, because mpv can play common YouTube audio containers and transcoding wastes CPU during download. Add a later user preference only if users want fixed formats for portability.

## Cookies And Authentication

MVP supports one optional cookie setting:

```toml
[youtube]
cookies_from_browser = "firefox"
```

Pass it as:

```sh
--cookies-from-browser "$cookies_from_browser"
```

Also allow profile-qualified values that yt-dlp supports, such as `firefox:~/.config/zen`, but treat the whole value as a single argv argument and never shell-concatenate it.

Do not copy browser cookies into TMU's own storage. Do not log the value at debug level if it contains a profile path. Do not implement Google OAuth for this MVP.

If yt-dlp reports bot detection, age gating, unavailable media, private media, DRM, or region restrictions, surface the stderr message as the download failure. Do not retry with more invasive behavior.

## Download Archive Policy

Use `download-archive.txt` as a secondary guard, not as TMU's source of truth:

- Primary truth: `tmu.json` plus an existing media file.
- Secondary guard: yt-dlp archive prevents accidental duplicate downloads after successful downloads.
- Repair path: if the archive says downloaded but TMU cannot find media, TMU should offer a redownload/repair action later. MVP can surface a clear cache inconsistency error.

This avoids relying on the archive to answer UI questions it was not designed to answer.

## Progress, Retry, And Cancellation

Progress:

- Use line-oriented progress with `--newline` and `--progress-template`.
- Parse progress opportunistically; missing total size, ETA, or speed should not fail the job.
- Throttle TUI redraws independently of yt-dlp output, e.g. at most 2 Hz.

Retry:

- Accept yt-dlp's default 10 retries and 10 fragment retries for MVP.
- Keep `--continue` and `.part` files enabled so interrupted downloads can resume.
- Do not implement multi-download concurrency in the MVP. One active download is friendlier to battery, disk, and network behavior.

Cancellation:

- Spawn yt-dlp directly from Bun with argv arrays, not through a shell.
- On cancel, send termination to the child process, then force kill after a short grace period if it remains alive.
- Leave `.part` files in the temp directory so a later retry can resume; add stale temp cleanup in a later cache-maintenance ticket.

## User-Facing Policy

TMU should document and lightly surface this policy:

- Only download content you have the right to download and keep.
- You are responsible for complying with YouTube/YouTube Music terms and copyright law.
- TMU does not bypass DRM, copy restrictions, account restrictions, or unavailable media.
- Cookies are optional and use your existing browser session only because yt-dlp supports that mode; TMU does not store copied cookies.

This should live in setup/docs and in actionable error text, not as noisy repeated prompts.

## Decision

Implement YouTube URL support as a URL-to-cache-to-local-file pipeline:

1. Use yt-dlp to identify a single URL with `--skip-download --no-playlist --dump-single-json`.
2. Use `extractor_key:id` as the stable cache identity.
3. Store media under `$XDG_DATA_HOME/tmu/offline-youtube/<extractor>/<id>/media.<ext>`.
4. Store yt-dlp's cleaned `source.info.json` plus TMU's normalized `tmu.json`.
5. Skip redownload when `tmu.json` points to an existing media file.
6. Download with `--no-playlist`, best audio, audio extraction, stable output templates, `.part` resume, a download archive, line-oriented progress, and optional `--cookies-from-browser`.
7. Enqueue the downloaded media as a local mpv-playable track.

Postpone YouTube search, OAuth, account/library browsing, playlist imports, liked songs, live streaming, live downloads, fixed-format transcoding preferences, automatic cache eviction, stale archive repair UI, thumbnail downloading, SponsorBlock, lyrics, comments, chapters, and broad yt-dlp site support.
