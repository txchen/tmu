# TMU

TMU is a lean terminal music player focused on downloading YouTube media, caching it on disk, and playing Tracks from that YouTube Cache.

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

The npm executable uses Bun at runtime. `mpv`, `ffprobe`, and `yt-dlp` remain external helpers discovered through TMU Config and dependency health checks.
