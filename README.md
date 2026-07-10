# TMU

TMU is a lean terminal music player focused on a shared Queue across Local, Navidrome, and Offline YouTube Cache Providers, with a YouTube URL Download Flow for adding cached Tracks.

## YouTube URL Download

YouTube URL Download stores downloaded audio in the Offline YouTube Cache. Users are responsible for downloading and keeping only content they have the right to download and keep.

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
