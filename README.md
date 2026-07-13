# TMU

TMU is a lean terminal music player focused on downloading YouTube media, caching it on disk, and playing Tracks from that YouTube Cache.

TMU opens on Playback and provides three top-level tabs:

- Playback shows the Active Playlist and its Current Track.
- Library searches healthy cached Tracks locally and provides Play Now, Play Next, Add to Playlist, opening on YouTube, Cache Deletion, and Cache Health cleanup.
- YouTube Downloader submits video or playlist URLs to a session-only Download Pipeline without adding Tracks to a TMU Playlist.

TMU supports multiple persistent, user-named Playlists. Press uppercase `P` outside text entry to open the Playlist Manager, where you can switch (`Enter`), create (`c`), rename (`e`), delete (`x`), and reorder (`J`/`K`) Playlists. The top bar always identifies the Active Playlist; Library and playback actions target only that Playlist. Lowercase `p` remains Previous Track.

YouTube Cache is the only current Provider. TMU keeps a narrow internal Provider boundary for listing/searching Tracks and resolving local playback, as documented in [`docs/adr/0001-keep-narrow-provider-abstraction.md`](docs/adr/0001-keep-narrow-provider-abstraction.md).

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

`mpv` and `yt-dlp` are separate command-line External Tools used for playback and downloading, respectively. They must be available on `PATH` or configured explicitly, and are not installed by npm. When either is missing, TMU keeps running and disables only the corresponding feature.

## Quick tutorial

1. Start TMU with `npx @txchen/tmu`. It opens on the Playback Tab, labeled `Player`. TMU requires a terminal at least 60 columns by 16 rows.
2. Press `]` twice to open Downloads. Paste a YouTube, YouTube Music, or `youtu.be` video URL and press `Enter`. Explicit playlist URLs are also supported and require confirmation before the batch starts.
3. Wait for the batch summary, then press `[` to open Library. Downloading caches Tracks but does not add them to a TMU Playlist automatically.
4. Select a Track with `j`/`k` or the arrow keys. Press `Enter` to Play Now, `a` to add it to the end of the Active Playlist without playing, or `N` to make it Play Next.
5. Press `[` to return to Player. Use `j`/`k` to select a Playlist Track, `Enter` to play it, and `Space` to pause or resume. Press uppercase `P` to open the Playlist Manager and create or switch listening contexts.

Useful global controls include `n`/`p` for next/previous, `h`/`l` to seek five seconds, `+`/`-` for volume, and `q` to quit. Press `?` outside a text input for the complete shortcut reference. Use `Esc` or `Tab` to leave a focused search or URL input first.

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
