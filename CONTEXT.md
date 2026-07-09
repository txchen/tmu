# TMU

TMU is a lean terminal music player effort focused on efficient everyday playback across local and remote music sources.

## Language

**TMU**:
The working name for the new lean TUI music player being planned in this repository.
_Avoid_: cliamp clone, lightweight cliamp

**Navidrome**:
A self-hosted music server that TMU should integrate with through the Subsonic/OpenSubsonic client API surface.
_Avoid_: navidrone

**Provider**:
A source of playable music and metadata, such as a local music library, Navidrome server, YouTube Music account, or offline YouTube download cache.
_Avoid_: backend, source

**Provider Browsing Surface**:
The source-specific UI and query behavior used to find Tracks within one Provider, such as local file opening, Navidrome artist/album browsing, or Offline YouTube Cache listing.
_Avoid_: shared library, central library module

**Global Search**:
The on-demand TUI flow for finding Tracks and music collections across Local, Navidrome, and Offline YouTube Cache Providers, with Provider identity shown as result metadata or used as an optional filter rather than chosen before searching.
_Avoid_: provider search, source-first search

**Track**:
The canonical playable music item that Providers add to TMU's shared queue, regardless of whether the item comes from a local file, Navidrome, or the Offline YouTube Cache.
_Avoid_: song, media item, provider item

**Music Collection**:
An ordered group of Tracks returned by Global Search, such as an Album or Playlist, that TMU can place into the Queue as one contiguous, deduplicated block.
_Avoid_: Queue, search folder, result group

**Track Identity**:
The durable identity of a Track within its Provider, used for queue deduplication, queue restore, and provider-specific refresh without storing a runtime playback address as identity.
_Avoid_: stream URL identity, display title identity

**Playback Locator**:
The runtime address TMU hands to the Player to start playback, such as a local file path or freshly generated authenticated stream URL.
_Avoid_: track ID, provider ID

**Player**:
The TMU boundary that controls playback through mpv and reports current playback state, without owning Provider, Queue, or metadata behavior.
_Avoid_: audio engine, provider player

**App Coordinator**:
The TMU boundary that turns UI intents into Provider, Queue, and Player workflows, such as resolving a queued Track and advancing playback.
_Avoid_: UI controller, playback manager

**App State**:
The source of truth for Provider data, Queue contents, current playback state, download state, availability, and app-level errors.
_Avoid_: UI state, view model

**UI State**:
The TUI-owned state for navigation and view-local interaction, such as focused pane, selected row, active prompt, filter text, and scroll position.
_Avoid_: app state, playback state

**TMU Config**:
The MVP configuration file for TMU settings and credential material, including paths, provider settings, low-power cadence, dependency policy, and Navidrome auth fields.
_Avoid_: separate credentials store, secret database

**Offline YouTube Cache**:
The local library of audio files and metadata created by downloading YouTube or YouTube Music items before playback inside TMU. In the MVP, YouTube playback goes through this cache instead of live streaming from YouTube.
_Avoid_: download folder, saved YouTube

**YouTube URL Download Flow**:
The MVP workflow that accepts a direct YouTube or YouTube Music URL, downloads it with yt-dlp into the Offline YouTube Cache, and then enqueues the cached Track.
_Avoid_: YouTube streaming, YouTube provider playback

**Low-Power TUI**:
The UI constraint that terminal rendering remains event-driven and bounded, with no autonomous playback redraws or animated progress bar by default; TMU Config may opt into a periodic progress cadence.
_Avoid_: efficient UI, battery friendly UI

**Queue-First MVP**:
An MVP shape where every Provider feeds a single playback queue, and browsing/search exists only to add playable items to that queue.
_Avoid_: library-browser-first MVP, media manager MVP

**Queue**:
The ordered list of Tracks TMU is preparing to play or is currently playing, shared across every Provider in the Queue-First MVP.
_Avoid_: playlist, play queue per source

**Queue Home**:
The default two-pane TUI surface, with the Queue Pane on the left and the Playing Track Pane on the right; Picker Overlays appear above it only when explicitly opened by the user.
_Avoid_: dashboard, browse home, always-visible search

**Queue Pane**:
The left side of Queue Home, showing the ordered Queue entries together with their selection, current, and playback status.
_Avoid_: library pane, playlist view, browser pane

**Playing Track Pane**:
The right side of Queue Home, showing static metadata and playback status for the playing Track and providing the future home for lyrics that update at a bounded low frequency.
_Avoid_: now-playing bar, Queue details, animated playback panel

**Picker Overlay**:
A shared Telescope-style popup model over Queue Home for Global Search, Provider navigation, the Command Palette, and shortcut help; each is keyboard-controlled and dismissed with `Esc` without losing Queue context.
_Avoid_: split pane, full-workspace replacement, permanent browser

**Vim Navigation**:
TMU's canonical keyboard movement language: `j`/`k`, `h`/`l`, `gg`/`G`, and paging keys, with arrow, Home, and End keys available as conventional aliases.
_Avoid_: arrow-only navigation, mouse-first navigation

**Contextual Shortcut Help**:
TMU's keyboard-discovery layer: a small footer shows the most relevant actions for the active surface, while `?` opens its complete shortcut reference.
_Avoid_: permanent shortcut wall, undocumented keymap

**Command Palette**:
The searchable `:` surface that exposes every action available in the current context by name together with its shortcut.
_Avoid_: command line, settings menu, shortcut help

**Play Next**:
The TUI action that moves or inserts a Track or Music Collection into the next Queue positions without duplicates and never starts playback; collections preserve their Track order, and an empty Queue receives the result at its head.
_Avoid_: enqueue, add to end, play now, autoplay

**Play Now**:
The TUI action that makes a Track current and starts playback immediately; for a Music Collection, its first Track becomes current and its remaining Tracks follow contiguously in collection order without duplicates.
_Avoid_: autoplay, resume, play next

**Track Availability**:
The current ability of a queued Track to resolve and play, shown visibly when a local file, cached media file, provider auth, or playback attempt fails.
_Avoid_: silently removed track, hidden playback error

**Last Queue Snapshot**:
The small persistence record TMU updates and restores automatically so the previous Queue and nearby playback preferences survive exit and relaunch, without becoming a general app database or media-library index.
_Avoid_: app database, library index

**Navidrome Library Browser**:
The MVP browsing surface for a Navidrome Provider, covering artist and album navigation well enough to enqueue tracks from a remote music library.
_Avoid_: Navidrome playlist-only mode
