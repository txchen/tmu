# Linux x64 Packaging And Smoke Verification

Status: ready-for-agent

## Parent

../PRD.md

## What to build

Add the first official MVP packaging and smoke verification path for Linux x64. TMU should compile the Bun application into a Linux x64 executable while keeping mpv, ffprobe, and yt-dlp as external runtime helpers. Smoke verification should prove the packaged app starts, checks dependency health, and can exercise representative Local, Navidrome-fake, Offline YouTube Cache, and YouTube URL Download-gated flows without requiring bundled helper binaries.

## Acceptance criteria

- [ ] A documented build command produces a Linux x64 compiled TMU executable from the Bun/TypeScript app.
- [ ] The packaged executable does not bundle mpv, ffprobe, or yt-dlp.
- [ ] The packaged executable starts and renders the TUI shell.
- [ ] Dependency health checks work in the packaged executable with helpers present and missing.
- [ ] Missing mpv, ffprobe, and yt-dlp produce the same source-specific health behavior as development mode.
- [ ] A smoke verification path covers startup, config loading, Local queue seed or fake local flow, dependency health, and source navigation.
- [ ] A smoke verification path covers YouTube URL Download being disabled when yt-dlp is missing.
- [ ] Packaging notes clearly state Linux x64 as the official MVP target, macOS as best-effort, and Windows as out of official MVP scope.
- [ ] Tests or scripts verify the build artifact and smoke checks in a repeatable way on Linux x64.

## Blocked by

- 16 - TMU Config And Dependency Health Surface
- 18 - mpv Player Adapter And Playback Controls
- 29 - YouTube Download Progress, Cancellation, And Cookies
- 31 - MVP Persistence Completeness
