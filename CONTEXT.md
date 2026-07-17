# TMU

TMU is a lean terminal music player focused on downloading YouTube media, caching it on disk, and playing it from that cache.

## Language

**TMU**:
The working name for the new lean TUI music player being planned in this repository.
_Avoid_: cliamp clone, lightweight cliamp

**TMU Daemon**:
The long-lived, per-user TMU process that owns shared playback, downloads, Playlists, persistence, and other application state independently of any connected terminal. It stays running without TUI Clients and stops only when explicitly shut down or when its host system terminates it.
_Avoid_: server, background client, idle worker

**Daemon Recovery**:
The creation of a fresh TMU Daemon by a new explicit `tmu` launch after its predecessor ended unexpectedly, cleaning up verified orphan playback and download resources and restoring the latest durable checkpoint without autoplay. A disconnected TUI Client neither starts recovery nor reconnects; it remains on a connection-lost error screen until the user exits it.
_Avoid_: daemon resume, mpv adoption, seamless failover

**TUI Client**:
A terminal-local TMU interface connected to the TMU Daemon, owning only that terminal's navigation and other UI State. A newly connected client opens on the Playback Tab with the Playing Playlist as its Viewed Playlist; its UI State is discarded on disconnect rather than restored as a durable client session.
_Avoid_: TMU instance, daemon session, terminal daemon

**Quit Client**:
The `q`, `Ctrl-C`, terminal hangup, or connection-close action that closes only the current TUI Client and leaves the TMU Daemon and all shared playback and downloads running. Text entry, modals, and active downloads never intercept `Ctrl-C` with a daemon-level confirmation.
_Avoid_: quit TMU, stop playback, shutdown

**Shutdown Daemon**:
The explicit operation available through `Ctrl-Q` in every TUI Client and through `tmu daemon stop`, showing the current playback, download, and connected-client impact before confirmation, then gracefully stopping the TMU Daemon and all daemon-owned work and disconnecting every client. The command-line form requires an interactive confirmation unless `--force` explicitly skips only that confirmation; clients are peers and no client owns the daemon.
_Avoid_: quit, close tab, idle shutdown

**Shared Command**:
A TUI Client request to change daemon-owned state, identified by stable domain identities and accepted once its complete frame is validated and enqueued in the single ordered sequence. Shortcut commands express relative intent against the latest state, explicit controls may set absolute values, and terminal-local row indexes never cross the Daemon Connection.
_Avoid_: UI action, remote method call, client mutation

**State Revision**:
The daemon's monotonically increasing identity for a committed shared state. A destructive confirmation names the revision whose impact the user approved so the daemon can require renewed confirmation after a relevant intervening change.
_Avoid_: timestamp, client version, file version

**Confirmation Challenge**:
A daemon-issued, client-bound and single-use description of a protected Shared Command's target and current impact at a State Revision. Shutdown Daemon, Playlist and Cache destruction, Download Batch cancellation or removal, and acceptance of a playlist-sized download require a challenge; ordinary playback, editing, single-Track Playlist removal, and Quit Client do not.
_Avoid_: confirmation flag, client prompt state, approval boolean

**Shared State Snapshot**:
The immutable, serializable view of daemon-owned App State published with a State Revision to every TUI Client on connection and after committed changes, subject to low-power progress cadence. It contains no Provider, Player, persistence implementation, or client-owned UI State.
_Avoid_: UI State, event log, daemon object graph

**Command Feedback**:
The success, validation failure, or stale-confirmation result returned only to the TUI Client that submitted a Shared Command. Its presentation is temporary client-owned UI State rather than shared App State.
_Avoid_: shared notification, App Error, state change

**Daemon Notice**:
A daemon-lifecycle or other system-wide message delivered to every connected TUI Client, such as recovery or intentional shutdown by another client. It is distinct from a shared state fact and from client-specific Command Feedback.
_Avoid_: command result, toast history, App Error

**Operational Error**:
A daemon failure represented either beside the shared capability that remains degraded, as Command Feedback, or as a Daemon Notice and bounded log record. TMU does not keep an unbounded global App Error history or replay obsolete error notifications to new clients.
_Avoid_: App Error array, permanent toast, exception history

**Daemon Connection**:
The version-negotiated, same-user local connection between one TUI Client and the TMU Daemon. An unexpected disconnect leaves the client on a non-operational connection-lost screen until the user quits; only a later explicit `tmu` launch may create a replacement daemon.
_Avoid_: remote session, web connection, public socket

**Provider**:
A narrow boundary that lists and searches Tracks and resolves them for playback. The YouTube Cache is the only current Provider, while the abstraction remains as an extension point for possible future sources.
_Avoid_: backend, source

**Cache Search**:
The typed-query state of the Library tab, matching healthy cached Tracks and incomplete Cache Entries by their user-facing Track Title or available incomplete-entry title, channel or uploader, YouTube video ID, or cache-file stem, without Provider headings, filters, hidden Source Titles, or network calls. With no query, the YouTube Cache is ordered by newest Cache Entry first.
_Avoid_: Global Search, Provider Search, YouTube search

**Track**:
The canonical playable music item that Providers add to Playlists. Current Tracks come from the YouTube Cache.
_Avoid_: song, media item, provider item

**Track Title**:
The user-facing name of a Track throughout TMU. A user-defined title overrides the downloaded Source Title without changing Track Identity; when no override exists, the Source Title is the Track Title.
_Avoid_: display label, renamed filename

**Source Title**:
The original title obtained from YouTube when a Track is downloaded, retained as internal cache metadata even after the Track Title is changed and not separately exposed in the TUI.
_Avoid_: old name, original filename

**Track Identity**:
The durable `(providerId, stableId)` identity used for Playlist deduplication, restore, and Provider refresh. YouTube Cache Tracks use Provider ID `youtube-cache` and the YouTube video ID, never a title or URL.
_Avoid_: stream URL identity, display title identity

**Playback Locator**:
The runtime disk path TMU hands to the Player to start a cached Track.
_Avoid_: track ID, provider ID

**Player**:
The TMU boundary that controls playback through mpv and reports current playback state, without owning Provider, Playlist, or metadata behavior.
_Avoid_: audio engine, provider player

**App Coordinator**:
The TMU boundary that turns UI intents into Provider, Playlist, and Player workflows, such as resolving a Playlist Track and advancing playback.
_Avoid_: UI controller, playback manager

**App State**:
The source of truth for Provider data, Playlists, current playback state, download state, availability, and app-level errors.
_Avoid_: UI state, view model

**UI State**:
The TUI-owned, session-only state for navigation and view-local interaction, such as active tab, focused pane, selected row, active prompt, filter text, and scroll position. Library and YouTube Downloader keep this state while switching tabs, but it is not persisted across restarts.
_Avoid_: app state, playback state

**TMU Config**:
The daemon-owned configuration loaded once when the TMU Daemon starts for YouTube download settings, low-power cadence, and dependency policy. TUI Clients never load independent copies, and file changes take effect only after an explicit daemon restart rather than through hot reload.
_Avoid_: separate credentials store, secret database

**External Tools**:
The command-line programs TMU orchestrates rather than reimplementing: `yt-dlp` for YouTube extraction/download and `mpv` for playback. TMU does not require `ffmpeg` globally; any extra tool need is reported only when the invoked `yt-dlp` operation requires it.
_Avoid_: built-in downloader, built-in transcoder, media processing engine

**Background Sound**:
The macOS-managed ambient audio stream that may play alongside TMU music while remaining independent from Tracks, Playlists, and the Player. TMU may provide a control surface for its enabled state, sound type, and volume without persisting that state itself.
_Avoid_: Track, background Track, TMU playback

**Background Sounds Tab**:
The optional macOS-only Top-Level Tab that controls Background Sound enabled state, immediately usable sound type, and independent volume. A candidate Mac may show the tab before control availability is confirmed; failures remain contained in the tab and never affect music playback.
_Avoid_: Background Sounds Player, ambient Playlist, macOS settings mirror

**YouTube Cache**:
The fixed-location, TMU-managed library of audio files and metadata created by the YouTube URL Download Flow, and the canonical implementation/UI name replacing Offline YouTube Cache. YouTube and YouTube Music URLs resolve to the same cache identity when they share a video ID. A healthy existing Track is not redownloaded, refreshed, or changed to a different container; an incomplete entry is repairable, arbitrary user-copied audio is not imported, and cached Tracks are never removed automatically for age or size.
_Avoid_: Offline YouTube Cache, local music folder, download folder, saved YouTube, reveal file

**Cache Entry**:
The atomic on-disk representation of one cached Track: one non-empty media file produced by successful `yt-dlp` download, named `<video-id>.<ext>` in its selected native container, and one authoritative TMU JSON sidecar named `<video-id>.json` containing YouTube video ID, title, uploader or channel, known duration, cached time, media filename/container, and optional thumbnail URL. Missing or invalid media or JSON makes the entry incomplete; repair may adopt a different `<video-id>.<new-ext>` when the old entry was already incomplete. Embedded media tags are optional and never authoritative, a full source URL is derivable rather than stored as source authority, and deeper playability is discovered by mpv during playback.
_Avoid_: media file, database row, embedded tags, raw yt-dlp info JSON

**Cache Health**:
The health status shown directly on incomplete TMU-shaped Cache Entries in the Library list. An incomplete entry is visibly distinguished from a healthy Track, explains its reason in the selected-entry inspector, cannot use playback or Playlist actions, and keys confirmed cleanup on its video ID or cache-file stem rather than display metadata. Cache Search includes it using whatever metadata is available, falling back to its stem. Recoverable entries may be repaired by resubmitting their URL in YouTube Downloader, while unrelated files are ignored and never deleted automatically.
_Avoid_: Track Availability, local-file import, automatic cleanup

**Cache Deletion**:
The explicitly confirmed, permanent removal of a Track's media and metadata from the YouTube Cache, recoverable only by downloading again. Any matching Playlist entry remains visibly unavailable; deleting the playing Current Track first stops playback, retains it as Current, and resets its position.
_Avoid_: remove from Playlist, automatic cleanup, filesystem delete

**Rename Track**:
The Library action that assigns a non-empty Track Title to a healthy cached Track without changing its Track Identity, Source Title, media filename, Playback Locator, or playback state. The title change is persistent and immediately applies to every visible copy of the Track; incomplete Cache Entries cannot be renamed.
_Avoid_: rename file, edit Source Title, temporary label

**YouTube URL Download Flow**:
The only workflow for adding media to the YouTube Cache. Each submission accepts one `youtube.com`, `music.youtube.com`, or `youtu.be` URL, including Shorts URLs that resolve to a normal YouTube video ID, and rejects bare IDs or obvious non-YouTube URLs before extraction. A normal video/watch URL creates a single-video Download Batch even if it also contains a playlist parameter, while an explicit playlist URL first requires all-or-cancel confirmation of its title and best-known source item count. Downloaded Tracks are stored independently without retaining playlist information or changing playback.
_Avoid_: YouTube search, YouTube browsing, YouTube streaming, YouTube provider playback

**Download Batch**:
The daemon-owned sequential work created after accepting one submitted YouTube URL, processing its Tracks one at a time in source order independently of the submitting TUI Client's later lifetime. A playlist submission becomes a Download Batch only after its client-bound Confirmation Challenge is accepted; disconnect before that point cancels the submission.
_Avoid_: Playlist, Music Collection, transaction

**Download Pipeline**:
The daemon-lifetime FIFO sequence of submitted Download Batches, with at most one active Track download across all batches. It continues without connected TUI Clients, retains at most the 500 most recent bounded summaries, and is not restored after Daemon Recovery; complete Cache Entries already committed remain available.
_Avoid_: Queue, parallel downloads, download playlist

**Low-Power TUI**:
The UI constraint that terminal rendering remains event-driven and bounded, with playback progress redrawn at a low default cadence of approximately five seconds rather than animated continuously; TMU Config may change the periodic progress cadence.
_Avoid_: efficient UI, battery friendly UI

**Playlist**:
A durably identified, user-named, ordered collection of Tracks that directly owns its playback order, Current Track, saved position, stopped-or-resumable state, and Repeat All setting. A Track may belong to multiple Playlists but appears at most once per Playlist by Track Identity; names are trimmed, non-empty, unique after case-folding, and at most 16 Unicode characters.
_Avoid_: Queue, collection, mix

**Playing Playlist**:
The one daemon-owned Playlist whose Current Track, playback order, saved position, and Repeat All setting govern the shared Player. Starting a Track from another Playlist makes that Playlist the Playing Playlist; merely viewing another Playlist never changes playback.
_Avoid_: Active Playlist, Viewed Playlist, current queue

**Viewed Playlist**:
The Playlist a particular TUI Client is browsing and targeting with Playlist and Library actions. Each client starts by viewing the Playing Playlist, then owns changes to its Viewed Playlist only for the lifetime of that client; changing it never changes the Playing Playlist or another client's view.
_Avoid_: Active Playlist, Playing Playlist, selected playlist

**Playlist Manager**:
The TUI Client modal opened with `P` outside text entry for changing its Viewed Playlist and for creating, renaming, deleting, and persistently ordering shared Playlists. Creating switches only the creator's Viewed Playlist to the new Playlist and never changes the Playing Playlist or another client's view.
_Avoid_: Playlist Switcher, playlist tab, playlist pane

**Delete Playlist**:
The confirmed removal of a Playlist and its Track memberships without changing the YouTube Cache. Deleting the Playing Playlist stops shared playback and makes the next Playlist in manager order, or the previous one when deleting the last row, the new Playing Playlist without autoplay; every client viewing the deleted Playlist moves to the same replacement, and the sole remaining Playlist cannot be deleted.
_Avoid_: Clear Playlist, delete queue

**Default Playlist**:
The initial Playlist created by TMU, initially named `Default`, which receives any migrated legacy Queue snapshot. It may be renamed; TMU protects whichever Playlist is last from deletion rather than reserving this Playlist's identity or name.
_Avoid_: default queue, system queue

**Current Track**:
The one Track in the Playing Playlist designated for shared playback. Merely changing a TUI Client's Viewed Playlist does not change the Current Track.
_Avoid_: separate playing Track, selected Track as playback state

**Resume**:
The explicit action that starts the restored Current Track at its last saved playback position after relaunch. Relaunch never resumes automatically, and Play Now starts the Track from the beginning instead.
_Avoid_: autoplay on relaunch, Play Now from saved position

**Stop**:
The playback action that halts the Player, keeps the Current Track, and resets its resumable position to the beginning. Pause instead preserves position; removing the Current Track clears the designation. Reaching the natural end of the final playable Track with repeat off produces the same retained-Current, position-zero state.
_Avoid_: clearing Current Track, preserving the stopped position

**Playback Tab**:
The default TUI surface opened by TMU's only launch form, `tmu`, with a focusable Playlist Pane for that client's Viewed Playlist, an optional non-focusable Selected Track Preview, and a distinct Now Playing Bar for shared playback. At medium and wide widths the Playlist and preview form an approximately 2:1 left/right split; at narrow widths the preview stacks below the Playlist.
_Avoid_: dashboard, browse home, always-visible search

**Playlist Pane**:
The focusable list in the Playback Tab, showing the TUI Client's Viewed Playlist and its terminal-local selection. It marks shared playback only when the Viewed Playlist is also the Playing Playlist.
_Avoid_: Queue Pane, library pane, browser pane

**Selected Track Preview**:
A compact, non-focusable metadata area for the selected Playlist Track. It appears to the right of the Playlist Pane at medium and wide widths and below it at narrow widths. It is absent when no Track is selected and is independent of the Current Track and playback state.
_Avoid_: Playing Track Pane, Current Track details, focusable inspector

**Now Playing Bar**:
The non-focusable area immediately above the contextual shortcut footer on every Top-Level Tab, identifying the Playing Playlist and representing its Current Track and shared playback status independently from the client's Viewed Playlist and selection.
_Avoid_: Selected Track Preview, focusable playback pane, animated playback panel

**Library**:
The top-level tab for finding Cache Entries already present in the YouTube Cache. It is entirely local and uses Cache Search to produce one list containing healthy playable Tracks and visibly unhealthy incomplete Cache Entries. Its Play Now, Play Next, and Add to Playlist actions explicitly target that TUI Client's Viewed Playlist.
_Avoid_: provider browser, local library, download status

**YouTube Downloader**:
The top-level tab for submitting YouTube or YouTube Music video and playlist URLs and observing the Download Pipeline. It owns download pipeline display, active download status, cancellation, pending-batch removal, and session summaries; accepted submissions clear the URL input after they create a Download Batch, while pre-batch validation failures or cancelled playlist confirmations keep it editable. Downloading never adds Tracks to a Playlist by itself.
_Avoid_: Library, Playlist status, playback list

**Top-Level Tabs**:
The primary TUI structure containing Playback, Library, and YouTube Downloader, plus the optional macOS-only Background Sounds Tab on candidate Macs. A compact top bar identifies the TUI Client's Viewed Playlist, while the Now Playing Bar independently identifies the Playing Playlist; `[` and `]` switch cyclically among visible tabs.
_Avoid_: overlay-first UI, provider tabs, hidden download status

**Vim Navigation**:
TMU's canonical keyboard movement language: `j`/`k`, `h`/`l`, `gg`/`G`, and paging keys, with arrow, Home, and End keys available as conventional aliases.
_Avoid_: arrow-only navigation, mouse-first navigation

**Contextual Shortcut Help**:
TMU's keyboard-discovery layer: a small footer shows only the most relevant actions for the focused pane, while `?` outside text entry opens a modal listing every shortcut for the active tab's panes plus global shortcuts and their input-capture conditions. The compact footer labels `Ctrl-Q` as `Shutdown`; full Help uses the canonical `Shutdown Daemon` operation name. Within text entry `?` remains ordinary input; while the modal is open, only its scrolling controls, `Enter`/`q`/`?`/`Esc` dismissal, and the normal global `Ctrl-C` quit flow remain active, without triggering underlying tab actions.
_Avoid_: permanent shortcut wall, undocumented keymap

**Play Next**:
The TUI action that moves or inserts a Track into the next position of the explicitly targeted Viewed Playlist without duplicates and never starts playback. The target Playlist's remembered Current Track stays in place; an empty Playlist receives the Track at its head.
_Avoid_: enqueue, add to end, play now, autoplay

**Add to Playlist**:
The Library action that adds a cached Track to the end of the explicitly targeted Viewed Playlist only when it is not already present, without starting playback, moving an existing entry, or changing the Current Track. It is distinct from downloading, which never adds Tracks to a Playlist by itself.
_Avoid_: Add to Queue, Play Now, Play Next

**Play Now**:
The TUI action that deduplicates a Track into the explicitly targeted Viewed Playlist, makes that Playlist the Playing Playlist, makes the Track Current, and starts it from the beginning immediately.
_Avoid_: autoplay, resume, play next

**Play Selected**:
The Playback Tab action that makes the Viewed Playlist the Playing Playlist, makes its selected existing Playlist Track Current, and starts it from the beginning without changing Playlist order. Previous and Next Track then follow that Playlist's neighbors.
_Avoid_: Play Now, Resume, Play Next, Playlist reorder

**Clear Playlist**:
The protected TUI action that removes every Track membership from the explicitly targeted Viewed Playlist without changing the YouTube Cache. Its Confirmation Challenge states whether the target is also the Playing Playlist, in which case confirmation stops shared playback and clears the Current Track.
_Avoid_: unconfirmed clear, automatic advance after clear

**Randomize Playlist**:
The one-shot action that visibly randomizes every Track in the explicitly targeted Viewed Playlist. If it is also the Playing Playlist, the Current Track keeps playing without interruption at its new visible index and subsequent playback follows the new order; Randomize Playlist is not a playback mode.
_Avoid_: Shuffle mode, hidden random playback order

**Next Track**:
The playback action that starts the next playable Track in Playing Playlist order, skipping unavailable Tracks without removing them. Repeat All wraps through that order; with Repeat All off and no later playable Track, Next Track retains the Current Track, stops playback, and resets its resumable position to the beginning, matching natural completion of the Playlist.
_Avoid_: clearing Current Track at Playlist end, silently removing unavailable Tracks

**Previous Track**:
The playback action that restarts the Current Track when playback is more than five seconds in; at five seconds or less it starts the preceding visible Playlist Track. At the Playlist head it restarts Current rather than clearing it.
_Avoid_: always changing Playlist rows, clearing Current at Playlist head

**Track Availability**:
The session-wide, Track Identity-based ability of a Track to resolve and play, shown with a reason on every matching Playlist membership. mpv playback failures mark every copy unavailable so automatic advancement skips it consistently; unavailable restored Tracks retain their Playlist order and Current Track designation and may recover after cache rescan.
_Avoid_: silently removed track, hidden playback error

**Last Playlist Snapshot**:
The atomic daemon-owned persistence record containing every Playlist in user-defined order, each Playlist's playback state, and the Playing Playlist identity. Semantic playback changes save immediately and continuous playback checkpoints about every 30 seconds; it never contains a TUI Client's Viewed Playlist or other UI State.
_Avoid_: Last Queue Snapshot, app database, library index
