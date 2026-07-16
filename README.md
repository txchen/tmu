# TMU

TMU optionally shows a Background Sounds tab on macOS 26.5 and newer. This is a lazy, best-effort integration with a private macOS framework: the version check only makes the Mac a candidate, availability is checked when the tab is first opened, and failures stay isolated to the tab. Apple does not provide a compatibility guarantee for this private interface and may change it in a future macOS release.

TMU is a lean terminal music player focused on downloading YouTube media, caching it on disk, and playing Tracks from that YouTube Cache.

TMU opens on Playback and provides three standard top-level tabs, plus the optional Background Sounds tab on candidate Macs:

- Playback shows the TUI Client's Viewed Playlist; the Now Playing Bar separately identifies the daemon-owned Playing Playlist and its Current Track.
- Library searches healthy cached Tracks locally and provides Play Now, Play Next, Add to Playlist, opening on YouTube, Cache Deletion, and Cache Health cleanup.
- YouTube Downloader submits video or playlist URLs to the daemon-lifetime Download Pipeline without adding Tracks to a TMU Playlist.
- Background Sounds reads and controls the authoritative enabled state, immediately usable sound, and independent volume without affecting TMU playback. macOS System Settings owns Background Sound downloads; download another sound there, then refresh TMU with `u`.

TMU supports multiple persistent, user-named Playlists. Press uppercase `P` outside text entry to open the Playlist Manager, where you can change this TUI Client's Viewed Playlist (`Enter`), create (`c`), rename (`e`), delete (`x`), and reorder (`J`/`K`) Playlists. Browsing never changes the shared Playing Playlist; Play Selected or Play Now deliberately promotes the Viewed Playlist to Playing. Lowercase `p` remains Previous Track.

YouTube Cache is the only current Provider. TMU keeps a narrow internal Provider boundary for listing/searching Tracks and resolving local playback, as documented in [`docs/adr/0001-keep-narrow-provider-abstraction.md`](docs/adr/0001-keep-narrow-provider-abstraction.md).

## macOS Background Sounds

On macOS 26.5 and newer, TMU can control Apple's Background Sounds from the optional `Background` tab. The tab can enable or disable Background Sounds, select an immediately usable sound, and adjust its independent volume without affecting TMU playback.

TMU does not download Apple's Background Sound assets. Before selecting a sound in TMU, open macOS **System Settings → Accessibility → Audio → Background Sounds** and download it using Apple's native interface. Return to TMU and press `u` in the `Background` tab to refresh the available sounds. Sounds that have not been downloaded do not appear in TMU's picker.

Background Sounds remain owned by macOS rather than TMU: their enabled state, selected sound, and volume are shared with System Settings and are not saved in TMU's configuration.

## YouTube URL Download

YouTube URL Download stores downloaded audio in the YouTube Cache without adding it to any TMU Playlist. Users are responsible for downloading and keeping only content they have the right to download and keep.

The cache lives at `$XDG_CACHE_HOME/tmu/youtube-cache`, or `~/.cache/tmu/youtube-cache` when `XDG_CACHE_HOME` is not set. TMU manages the files in this directory; use the Library actions to rename or delete Tracks.

## Install and run

Node.js and npm are TMU's runtime and installation requirements. TMU requires Node.js 24 or newer. Run it directly from the npm package:

```sh
npx @txchen/tmu
```

Or install it globally and use the sole production launch form:

```sh
npm install --global @txchen/tmu
tmu
```

The npm package contains a prebuilt JavaScript executable, so no TypeScript loader or build step is needed after installation. Linux, macOS, and WSL (through Linux behavior) are supported; native Windows is not supported.

Running `tmu` connects a TUI Client to the per-user TMU Daemon, auto-starting it when needed. The TMU Daemon owns playback, downloads, Playlists, persistence, and configuration and remains running with no connected clients. There is no legacy single-process mode or public daemon-start command. The only operational subcommands are `tmu daemon status` and `tmu daemon stop [--force]`.

`mpv` and `yt-dlp` are separate command-line External Tools used for playback and downloading, respectively. They must be available on `PATH` or configured explicitly, and are not installed by npm. When either is missing, TMU keeps running and disables only the corresponding feature.

## Quick tutorial

1. Start TMU with `npx @txchen/tmu`. It opens on the Playback Tab, labeled `Player`. TMU requires a terminal at least 60 columns by 16 rows.
2. Press `]` twice to open Downloads. Paste a YouTube, YouTube Music, or `youtu.be` video URL and press `Enter`. Explicit playlist URLs are also supported and require confirmation before the batch starts.
3. Wait for the batch summary, then press `[` to open Library. Downloading caches Tracks but does not add them to a TMU Playlist automatically.
4. Select a Track with `j`/`k` or the arrow keys. Press `Enter` to Play Now, `a` to add it to the end of the Viewed Playlist without playing, or `N` to make it Play Next.
5. Press `[` to return to Player. Use `j`/`k` to select a Playlist Track, `Enter` to play it, and `Space` to pause or resume. Press uppercase `P` to open the Playlist Manager and create or switch listening contexts.

Useful global controls include `n`/`p` for next/previous, `h`/`l` to seek five seconds, and `+`/`-` for volume. `q` and `Ctrl-C` Quit Client, leaving daemon-owned playback and downloads running. `Ctrl-Q` shows the live impact and, after confirmation, performs Shutdown Daemon for every connected client. Press `?` outside a text input for the complete shortcut reference. Use `Esc` or `Tab` to leave a focused search or URL input first.

Cache Search is local: press `/`, type part of a title, channel, or YouTube video ID, and press `Enter` to return focus to the results.

## Configuration

TMU reads optional JSON configuration from `$XDG_CONFIG_HOME/tmu/config.json`, or `~/.config/tmu/config.json` when `XDG_CONFIG_HOME` is not set. No file is required for the defaults. For example, External Tool commands can be overridden when they are not on `PATH`:

```json
{
  "helpers": {
    "mpv": "/path/to/mpv",
    "ytDlp": "/path/to/yt-dlp"
  }
}
```

TMU Config is loaded once by the TMU Daemon. After editing it, run `tmu daemon stop`, confirm Shutdown Daemon, and launch `tmu` again. Runtime and socket locations are selected securely by TMU and are not configurable. `tmu daemon status` reports the loaded config source plus runtime and log paths.

## Development

Install the locked dependencies with `npm ci`, then use the public npm scripts:

```sh
npm run build
npm run start
npm run typecheck
npm test
npm run smoke:package
```

To benchmark production mpv control on Linux, put a canonical `track` and its resolved file `playbackLocator` in JSON, then run `npm run benchmark:playback -- track-input.json --power-mode "AC power, balanced"`. The command plays the complete Track with null audio and one-second position polling. Its JSON report keeps controller and mpv metrics distinct and includes child-inclusive CPU, peak RSS, context switches, elapsed time, versions, and playback completion. Alternate three runs per runtime without changing the environment. Memory is separate from CPU evidence; this does not measure hardware energy.
