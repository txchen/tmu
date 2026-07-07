# Define YouTube URL Download Pipeline

Type: research
Status: resolved
Blocked by: 01

## Question

How should TMU connect pasted YouTube/YouTube Music URLs to yt-dlp download, Offline YouTube Cache metadata, and local playback while keeping the implementation reliable and maintainable?

Evaluate yt-dlp URL extraction, cookies-from-browser support, download archive behavior, metadata sidecars, file naming, retry/cancellation, progress reporting, cache lookup before redownload, and user-facing policy around platform terms and copyrighted content. YouTube search, Google OAuth, account library browsing, playlist import, liked songs, and YouTube-vs-YouTube-Music classification are out of scope for this MVP.

## Answer

Research note: [07-define-youtube-url-download-pipeline.md](../research/07-define-youtube-url-download-pipeline.md)

TMU should implement YouTube/YouTube Music as a URL-only, download-first provider. A pasted URL resolves to one cached local media file, and playback goes through the shared mpv controller exactly like other local files.

Required MVP pipeline:

- Accept direct YouTube and YouTube Music URLs only. Reject search strings, `ytsearch:` inputs, playlist/channel/account/library URLs, live streams, and non-YouTube sites.
- Identify first with `yt-dlp --skip-download --no-playlist --dump-single-json` under a finite timeout.
- Use `<extractor_key lowercased>:<id>` as stable identity, usually `youtube:<video-id>`.
- Store downloaded media under `$XDG_DATA_HOME/tmu/offline-youtube/<extractor>/<id>/media.<ext>`, with temp files under `$XDG_CACHE_HOME/tmu/yt-dlp-tmp`.
- Store yt-dlp's cleaned `source.info.json` plus TMU's normalized `tmu.json`; use `tmu.json` plus an existing media file as the primary cache lookup.
- Skip redownload when the cache entry exists and the media file is present.
- Download with `--no-playlist`, best audio, `--extract-audio --audio-format best`, stable output templates, `.part`/resume enabled, a download archive as a secondary guard, line-oriented progress output, and optional `--cookies-from-browser`.
- Run only one download at a time by default. Cancel by terminating the yt-dlp child process, then force-killing after a short grace period.
- On successful download, validate the media file, write `tmu.json` atomically, and enqueue the resulting local file.

Cookie policy:

- Support one optional config value, `youtube.cookies_from_browser`, passed as a single argv argument to `--cookies-from-browser`.
- Do not copy browser cookies into TMU storage.
- Do not implement Google OAuth in the MVP.

User-facing policy:

- Document that users are responsible for downloading only content they have the right to download and keep.
- Do not attempt to bypass DRM, copy restrictions, account restrictions, region restrictions, or unavailable media.
- Surface yt-dlp stderr for bot detection, age gating, private media, unavailable media, DRM, and region failures instead of hiding it behind generic errors.

Postpone YouTube search, OAuth, account/library browsing, playlist import, liked songs, YouTube-vs-YouTube-Music classification, live streaming, live downloads, fixed-format transcoding preferences, automatic cache eviction, stale archive repair UI, thumbnail downloading, SponsorBlock, lyrics, comments, chapters, and broad yt-dlp site support.
