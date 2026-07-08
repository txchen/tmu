# TMU

TMU is a lean terminal music player focused on a shared Queue across Local, Navidrome, and Offline YouTube Cache Providers, with a YouTube URL Download Flow for adding cached Tracks.

## YouTube URL Download

YouTube URL Download stores downloaded audio in the Offline YouTube Cache. Users are responsible for downloading and keeping only content they have the right to download and keep.

## Linux x64 MVP Packaging

Linux x64 is the official MVP packaging target. Build the standalone executable with:

```sh
bun run build:linux-x64
```

The underlying Bun compile command is:

```sh
bun build --compile --target=bun-linux-x64-baseline --outfile=dist/tmu-linux-x64 src/main.ts
```

The artifact is written to `dist/tmu-linux-x64`. The compiled TMU executable contains the Bun/TypeScript app code only; `mpv`, `ffprobe`, and `yt-dlp` remain external runtime helpers discovered through TMU Config and dependency health checks. The MVP does not bundle helper binaries.

Run repeatable packaged smoke verification with:

```sh
bun run smoke:linux-x64
```

The smoke path builds the executable, runs it with isolated config/state/cache directories, uses fake external helper commands for the present-helper path, verifies missing-helper health behavior, exercises Local CLI queue seeding, Navidrome against a fake local Subsonic server, Offline YouTube Cache navigation, and YouTube URL Download disabled when `yt-dlp` is missing.

macOS packaging is best-effort until helper discovery, install paths, signing, and terminal behavior are tested. Windows is outside the official MVP scope.
