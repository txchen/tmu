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

Node.js and npm are TMU's runtime and installation requirements. TMU requires Node.js 24 or newer. Run it directly from the npm package:

```sh
npx tmu
```

Or install it globally and use the sole production launch form:

```sh
npm install --global tmu
tmu
```

The npm package contains a prebuilt JavaScript executable, so no TypeScript loader or build step is needed after installation. Linux, macOS, and WSL (through Linux behavior) are supported; native Windows is not supported.

`mpv` and `yt-dlp` are separate External Tools discovered through TMU Config and dependency health checks. They are not Node packages or npm runtime requirements. When either is missing, only its corresponding feature is disabled.

## Development

Install the locked dependencies with `npm ci`, then use the public npm scripts:

```sh
npm run build
npm run start
npm run typecheck
npm test
npm run smoke:package
```

To capture a Node CPU profile for a representative full-Track playback, run `npm run benchmark:playback`, play a cached Track through to completion, and quit TMU. The profile is written to `tmu-playback.cpuprofile`; repeat the same Track and environment when comparing runs. This measurement reports runtime CPU activity, not hardware energy use.
