# Define Runtime Dependency And Packaging Policy

Research date: 2026-07-07

## Sources

- Bun single-file executable docs: https://bun.com/docs/bundler/executables
- mpv stable manual: https://mpv.io/manual/stable/
- mpv installation docs: https://mpv.io/installation/
- FFmpeg ffprobe docs: https://ffmpeg.org/ffprobe.html
- FFmpeg download docs: https://ffmpeg.org/download.html
- yt-dlp installation docs: https://github.com/yt-dlp/yt-dlp/wiki/Installation

## Findings

Bun is suitable for packaging TMU's application code as a single executable.
Bun documents `bun build --compile` for generating standalone binaries from
TypeScript or JavaScript, and those binaries include the Bun runtime plus
imported files and packages. Bun also documents cross-compile targets for Linux,
Windows, and macOS across x64 and arm64 variants.

The Bun executable should not be treated as a complete media bundle. TMU still
depends on external helper executables for playback, metadata probing, and URL
downloads:

- `mpv` is required for playback. mpv documents `--idle=yes` for staying alive
  when there is no file loaded, `--terminal=no` for silencing terminal/stdin
  behavior, `--audio-display=no` for disabling cover-art display as video, and
  `--input-ipc-server=<path>` for JSON IPC over Unix sockets or Windows named
  pipes.
- `ffprobe` is recommended, not globally required. FFmpeg documents ffprobe as
  the tool for gathering multimedia stream information in human- and
  machine-readable form. TMU needs it for local/cache metadata and duration
  verification, but core playback can still run through mpv when ffprobe is
  missing.
- `yt-dlp` is required only for the YouTube URL Download Flow. The yt-dlp
  project documents installation through official release binaries, pip, and
  platform package managers. TMU should not bundle or auto-update it in the MVP.

FFmpeg's official download page says FFmpeg provides source code and links to
compiled packages/executables separately. mpv's installation page recommends
latest builds and notes that Windows binary packages are generally unofficial
third-party builds except as noted. That makes bundled helper binaries a bad MVP
default: licensing, update cadence, platform variation, and user trust are all
harder than checking PATH and giving clear install hints.

Local environment check:

```text
bun:    /home/txchen/.local/share/mise/installs/bun/latest/bin/bun, version 1.3.11
mpv:    /usr/bin/mpv, version 0.41.0
ffprobe:/usr/bin/ffprobe, version n8.1.1
yt-dlp: /usr/bin/yt-dlp, version 2026.03.17
```

## Policy

Package TMU application code with Bun, but do not bundle `mpv`, `ffprobe`, or
`yt-dlp` in the MVP.

Development install:

- Require Bun for source installs and development commands.
- Run dependency checks with `command -v`/spawn checks rather than assuming PATH
  shape.
- Print detected paths and versions in a diagnostics view or `tmu doctor`.

Packaged install:

- Use `bun build --compile` for TMU's own executable.
- Target `bun-linux-x64-baseline` for the first official MVP binary so older x64
  CPUs are less likely to hit Bun AVX2/modern CPU issues.
- Use deterministic compile flags that avoid accidental `.env`/`bunfig.toml`
  autoloading unless TMU explicitly wants that behavior.
- Keep external media helpers as user-installed executables discovered from
  PATH or explicit config paths.

Runtime dependency checks:

- `mpv`: required for playback. Check at startup and before any playback load.
  If missing, keep the TUI usable for config/help, but disable playback actions
  and show a blocking health item with install hints.
- `ffprobe`: recommended. Check at startup. If missing, warn that metadata,
  duration verification, and local/cache repair may be degraded; do not block
  playback.
- `yt-dlp`: required for YouTube URL Download only. Check when entering the
  YouTube URL surface and before download. If missing, disable that source
  action and show install hints; do not block Local/Navidrome/cache playback.

Error display:

- Show dependency failures as source-specific health messages, not stack traces.
- Include the command TMU tried, whether it was found, the detected version when
  available, and concise install hints.
- Keep stderr from helper probes available in logs/diagnostics, but avoid
  dumping noisy tool output into normal TUI panels.

Platform support:

- Official MVP support: Linux x64 with a compiled Bun executable plus
  user-installed `mpv`, optional `ffprobe`, and source-specific `yt-dlp`.
- Best-effort but not official MVP support: macOS, because the same Unix-socket
  mpv IPC model should be close, but install paths, signing, and helper
  discovery still need platform testing.
- Out of official MVP support: Windows, until TMU tests mpv named-pipe IPC,
  helper discovery, path quoting, terminal behavior, and Bun's Windows compiled
  target in a real Windows environment.

## Decision

TMU's MVP should ship as a foreground Linux x64 terminal app. It should compile
its own Bun/TypeScript code with Bun for packaged builds, but treat media
helpers as external runtime dependencies. The app should have a first-class
dependency health check, graceful source-specific disabling, and copyable install
guidance rather than trying to hide missing helper tools behind generic playback
errors.
