# TMU Config And Dependency Health Surface

Status: ready-for-agent

## Parent

../PRD.md

## What to build

Add TMU Config loading plus source-specific dependency health to the runnable skeleton. TMU should understand configured helper command paths, Provider settings, low-power cadence settings, Offline YouTube Cache settings, and Navidrome auth fields. It should check mpv, ffprobe, and yt-dlp according to the PRD policy and surface dependency health in the TUI without crashing.

The behavior should be source-gated: missing mpv disables playback actions, missing ffprobe warns without blocking playback, and missing yt-dlp disables only YouTube URL Download.

## Acceptance criteria

- [ ] TMU loads a single MVP config file with defaults when no file exists.
- [ ] TMU Config can hold helper command paths, Provider settings, low-power cadence settings, Offline YouTube Cache settings, and Navidrome auth fields.
- [ ] Secret config fields are redacted from normal logs, diagnostics, and TUI display.
- [ ] Dependency health checks report attempted command or configured path, found or missing status, and detected version when available.
- [ ] Missing mpv leaves the TUI usable but disables playback actions with a blocking playback health message.
- [ ] Missing ffprobe shows a non-blocking warning about degraded metadata behavior.
- [ ] Missing yt-dlp disables YouTube URL Download while leaving other sources usable.
- [ ] Tests cover present, missing, configured-path, version-detected, redaction, and source-gated dependency behavior.

## Blocked by

- 15 - Walking Skeleton For Queue-First TMU
