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
The typed-query state of the music-finding Picker Overlay, returning sections for Tracks, Artists, Albums, and Playlists across Local, Navidrome, and Offline YouTube Cache Providers. Each Provider's ranking remains intact within its result-type and Provider subgroup, Provider identity is result metadata or an optional filter, and no Provider must be chosen before searching. Clearing the query restores the prior Provider navigation location and selection.
_Avoid_: provider search, source-first search

**Track**:
The canonical playable music item that Providers add to TMU's shared queue, regardless of whether the item comes from a local file, Navidrome, or the Offline YouTube Cache.
_Avoid_: song, media item, provider item

**Music Collection**:
An ordered group of Tracks returned by Global Search, such as an Album or Playlist, that TMU can place into the Queue as one contiguous, deduplicated block.
_Avoid_: Queue, search folder, result group

**Local Directory**:
A non-playable navigation container in the Local Provider Browsing Surface. Opening one reveals its children; TMU does not infer that a directory is an Album or Playlist or recursively send it to Play Next or Play Now.
_Avoid_: local album, folder collection, queueable directory

**Artist**:
A searchable, non-playable navigation result that opens the Artist's Albums. An Artist is not a Music Collection and cannot be sent directly to Play Next or Play Now in the MVP.
_Avoid_: artist collection, queueable artist

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
The ordered list of Tracks TMU is preparing to play or is currently playing, shared across every Provider in the Queue-First MVP. Reordering follows Track Identity: Queue selection follows the moved Track, and the Current Track remains Current without interrupting playback.
_Avoid_: playlist, play queue per source

**Current Track**:
The one Track in the Queue designated for playback. Queue selection is independent UI State rather than another playback status; global Play, Pause, and Resume always target the Current Track even when another row is selected. Only when no Current Track exists may Play start the selected row. The Last Queue Snapshot remembers the Current Track across relaunch so the user can explicitly resume it without autoplay. Removing the Current Track stops playback, clears the designation, and never advances automatically.
_Avoid_: separate playing Track, selected Track as playback state

**Resume**:
The explicit action that starts the restored Current Track at its last saved playback position after relaunch. Relaunch never resumes automatically, and Play Now starts the Track from the beginning instead.
_Avoid_: autoplay on relaunch, Play Now from saved position

**Stop**:
The playback action that halts the Player, keeps the Current Track, and resets its resumable position to the beginning. Pause instead preserves position; removing the Current Track clears the designation. Reaching the natural end of the final playable Track with repeat off produces the same retained-Current, position-zero state.
_Avoid_: clearing Current Track, preserving the stopped position

**Queue Home**:
The default two-pane TUI surface opened by TMU's only launch form, `tmu`, with the Queue Pane on the left and the Playing Track Pane on the right; Picker Overlays appear above it only when explicitly opened by the user. Launch restores the Last Queue Snapshot without autoplay. Queue Home remains visible when the Queue is empty, keeps Queue Pane focus, shows no Current Track, and offers contextual actions for Global Search, opening Local music, and the YouTube URL Download Flow rather than opening a Provider automatically.
_Avoid_: dashboard, browse home, always-visible search

**Queue Pane**:
The left side of Queue Home, showing the ordered Queue entries together with their selection, current, and playback status.
_Avoid_: library pane, playlist view, browser pane

**Playing Track Pane**:
The non-focusable, informational right side of Queue Home, showing static metadata and playback status for the Current Track and providing the future home for lyrics that update at a bounded low frequency. Queue Pane retains focus in the MVP because playback controls are global and Playing Track Pane exposes no direct actions. It distinguishes restored playback that can Resume at a saved position from an explicitly Stopped Track that will start from the beginning.
_Avoid_: now-playing bar, Queue details, animated playback panel

**Picker Overlay**:
A shared Telescope-style popup model over Queue Home for finding music, the Command Palette, and shortcut help; each is keyboard-controlled and dismissed with `Esc` without losing Queue context. The music-finding form opens in Provider navigation when its query is empty and switches to Global Search when the user types. It remembers the last navigation location and selection within the current TMU session, but a relaunch starts it at a source-neutral Provider root.
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
The TUI action that moves or inserts a Track or Music Collection into the next Queue positions without duplicates and never starts playback. Deduplication uses Track Identity: existing non-Current Tracks are moved into one contiguous block after the Current Track in collection order, while the Current Track stays in place and is omitted from that block. An empty Queue receives the result at its head.
_Avoid_: enqueue, add to end, play now, autoplay

**Play Now**:
The TUI action that makes a Track current and starts it from the beginning immediately. The requested Track or Music Collection is deduplicated by Track Identity into one contiguous block; its first Track becomes Current and the rest follow in collection order. A different former Current Track remains immediately before the block so Previous returns to it; without a Current Track, the block goes at the Queue head.
_Avoid_: autoplay, resume, play next

**Clear Queue**:
The destructive TUI action that, after explicit confirmation, stops playback, clears the Current Track, and removes every Track from the Queue. Cancelling the confirmation leaves both Queue and playback unchanged.
_Avoid_: unconfirmed clear, automatic advance after clear

**Shuffle**:
The Queue action that visibly randomizes only Tracks after the Current Track, preserving listening history and the Current Track. Playback follows that visible order, Play Next remains literally next, disabling Shuffle keeps the current order, and a repeated cycle reshuffles the upcoming portion.
_Avoid_: hidden random playback order, reshuffling listening history

**Previous Track**:
The playback action that restarts the Current Track when playback is more than five seconds in; at five seconds or less it starts the preceding visible Queue Track. At the Queue head it restarts Current rather than clearing it.
_Avoid_: always changing Queue rows, clearing Current at Queue head

**Track Availability**:
The current ability of a queued Track to resolve and play, shown visibly with a reason when a local file, cached media file, provider auth, or playback attempt fails. Unavailable restored Tracks retain their Queue order and Current Track designation and may recover later; TMU never silently removes them. Next and automatic advancement skip unavailable Tracks, but direct Resume and Play Now fail on the requested Track without substitution.
_Avoid_: silently removed track, hidden playback error

**Last Queue Snapshot**:
The small persistence record TMU updates and restores automatically so Queue order and Track data, availability, Current Track and position, shuffle, repeat, and volume survive exit and relaunch. It excludes Queue selection, scroll, filters, Picker Overlays, and other UI State, and never becomes a general app database or media-library index. Restoration is all-or-nothing. Corrupt, unsupported, or partially invalid snapshot data is quarantined for recovery; TMU opens an empty Queue Home with a non-blocking warning and does not replace it until the user makes a meaningful state change. Write failures leave playback and in-memory state working, remain visibly actionable, retry later, and never trap exit.
_Avoid_: app database, library index

**Navidrome Library Browser**:
The MVP browsing surface for a configured Navidrome Provider, covering Artists, Albums, and Playlists well enough to enqueue Tracks from a remote music library. Navidrome is absent from the source-neutral Provider root until TMU Config identifies a server; once configured, disabled, offline, and authentication-failure states remain visible with their reason and recovery action.
_Avoid_: Navidrome playlist-only mode
