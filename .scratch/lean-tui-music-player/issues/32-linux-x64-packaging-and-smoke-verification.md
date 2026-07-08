# Linux x64 Packaging And Smoke Verification

Status: resolved

## Parent

../PRD.md

## What to build

Add the first official MVP packaging and smoke verification path for Linux x64. TMU should compile the Bun application into a Linux x64 executable while keeping mpv, ffprobe, and yt-dlp as external runtime helpers. Smoke verification should prove the packaged app starts, checks dependency health, and can exercise representative Local, Navidrome-fake, Offline YouTube Cache, and YouTube URL Download-gated flows without requiring bundled helper binaries.

## Acceptance criteria

- [x] A documented build command produces a Linux x64 compiled TMU executable from the Bun/TypeScript app.
- [x] The packaged executable does not bundle mpv, ffprobe, or yt-dlp.
- [x] The packaged executable starts and renders the TUI shell.
- [x] Dependency health checks work in the packaged executable with helpers present and missing.
- [x] Missing mpv, ffprobe, and yt-dlp produce the same source-specific health behavior as development mode.
- [x] A smoke verification path covers startup, config loading, Local queue seed or fake local flow, dependency health, and source navigation.
- [x] A smoke verification path covers YouTube URL Download being disabled when yt-dlp is missing.
- [x] Packaging notes clearly state Linux x64 as the official MVP target, macOS as best-effort, and Windows as out of official MVP scope.
- [x] Tests or scripts verify the build artifact and smoke checks in a repeatable way on Linux x64.

## Answer

Implemented the Linux x64 MVP packaging and smoke verification path.

- `bun run build:linux-x64` runs `bun build --compile --target=bun-linux-x64-baseline --outfile=dist/tmu-linux-x64 src/main.ts`.
- `bun run smoke:linux-x64` rebuilds the packaged executable and runs it with isolated config/state/cache directories.
- The smoke path uses external helper commands supplied through TMU Config: fake `mpv`, `ffprobe`, and `yt-dlp` for the present-helper path, then missing paths for the source-specific missing-helper path.
- Smoke snapshots cover startup shell rendering, Local CLI seeding, fake Navidrome navigation, Offline YouTube Cache navigation, dependency health rendering, and YouTube URL Download disabled when `yt-dlp` is missing.
- Packaging notes in `README.md` mark Linux x64 as the official MVP target, macOS as best-effort, and Windows as outside official MVP scope.

Validation: `bun run typecheck`, `bun test`, `git diff --check`, and `bun run smoke:linux-x64` pass.

## Blocked by

- 16 - TMU Config And Dependency Health Surface
- 18 - mpv Player Adapter And Playback Controls
- 29 - YouTube Download Progress, Cancellation, And Cookies
- 31 - MVP Persistence Completeness
