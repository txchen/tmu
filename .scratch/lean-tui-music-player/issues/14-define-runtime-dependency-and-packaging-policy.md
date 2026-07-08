# Define Runtime Dependency And Packaging Policy

Type: research
Status: resolved
Blocked by: 04

## Question

What should TMU's MVP install and packaging policy be for Bun plus external media helpers?

Decide how TMU checks for required `mpv`, recommended `ffprobe`, and required `yt-dlp` for URL downloads; how errors/install hints should be shown; whether packaged TMU uses `bun build --compile`; and what platforms are officially supported in the MVP.

## Answer

Research note: [14-define-runtime-dependency-and-packaging-policy.md](../research/14-define-runtime-dependency-and-packaging-policy.md)

TMU's MVP should package its own Bun/TypeScript application code, but should not bundle media helper binaries. Use `bun build --compile` for packaged builds, with Linux x64 as the first official MVP target. Prefer the baseline Linux x64 target for the first binary so older x64 CPUs are less likely to hit Bun target assumptions.

Runtime helpers stay external and are discovered from `PATH` or explicit config paths:

- `mpv` is required for playback. Check it at startup and before playback loads. If missing, keep the TUI usable for config/help, but disable playback actions and show a blocking dependency health message.
- `ffprobe` is recommended, not globally required. Check it at startup. If missing, warn that metadata, duration verification, and cache/local repair behavior may be degraded, but do not block playback.
- `yt-dlp` is required only for YouTube URL Download. Check it when entering that source surface and before download. If missing, disable that source action, while leaving Local, Navidrome, Offline YouTube Cache, and playback usable.

Dependency errors should be source-specific health messages rather than raw stack traces. Each message should include the attempted command or configured path, whether TMU found it, the detected version when available, and concise install hints. Helper stderr belongs in logs or diagnostics, not in normal TUI panels.

Official MVP platform support is Linux x64 with a compiled Bun executable plus user-installed `mpv`, optional `ffprobe`, and source-gated `yt-dlp`. macOS can remain best-effort until install paths, signing, and helper discovery are tested. Windows is outside official MVP support until mpv named-pipe IPC, helper discovery, path quoting, terminal behavior, and Bun's Windows compiled target are tested in a real Windows environment.
