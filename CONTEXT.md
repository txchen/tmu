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

**Track**:
The canonical playable music item that Providers add to TMU's shared queue, regardless of whether the item comes from a local file, Navidrome, or the Offline YouTube Cache.
_Avoid_: song, media item, provider item

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
The UI constraint that terminal rendering must be event-driven and bounded, with no always-on visualizers or high-frequency EQ displays in the MVP.
_Avoid_: efficient UI, battery friendly UI

**Queue-First MVP**:
An MVP shape where every Provider feeds a single playback queue, and browsing/search exists only to add playable items to that queue.
_Avoid_: library-browser-first MVP, media manager MVP

**Queue**:
The ordered list of Tracks TMU is preparing to play or is currently playing, shared across every Provider in the Queue-First MVP.
_Avoid_: playlist, play queue per source

**Track Availability**:
The current ability of a queued Track to resolve and play, shown visibly when a local file, cached media file, provider auth, or playback attempt fails.
_Avoid_: silently removed track, hidden playback error

**Last Queue Snapshot**:
The small persisted restore record for TMU's previous Queue and nearby playback preferences, without becoming a general app database or media-library index.
_Avoid_: app database, library index

**Navidrome Library Browser**:
The MVP browsing surface for a Navidrome Provider, covering artist and album navigation well enough to enqueue tracks from a remote music library.
_Avoid_: Navidrome playlist-only mode
