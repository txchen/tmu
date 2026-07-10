# TMU

TMU is a lean terminal music player focused on downloading YouTube media, caching it on disk, and playing Tracks from that YouTube Cache.

TMU opens on Playback and provides three top-level tabs:

- Playback manages the shared Queue and Current Track.
- Library searches healthy cached Tracks locally and provides Play Now, Play Next, Add to Queue, Cache Deletion, and Cache Health cleanup.
- YouTube Downloader submits video or playlist URLs to a session-only Download Pipeline without adding Tracks to the Queue.

YouTube Cache is the only current Provider. TMU keeps a narrow internal Provider boundary for listing/searching Tracks and resolving local playback, as documented in [`docs/adr/0001-keep-narrow-provider-abstraction.md`](docs/adr/0001-keep-narrow-provider-abstraction.md).

## YouTube URL Download

YouTube URL Download stores downloaded audio in the YouTube Cache without adding it to the Queue. Users are responsible for downloading and keeping only content they have the right to download and keep.

## Install and run

TMU requires [Bun](https://bun.sh/). Run it directly from the npm package:

```sh
bunx tmu
```

Or install it globally and use the sole production launch form:

```sh
bun install --global tmu
tmu
```

The npm executable uses Bun at runtime. `mpv` and `yt-dlp` remain external helpers discovered through TMU Config and dependency health checks.
