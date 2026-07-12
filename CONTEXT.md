# TMU

TMU is a lean terminal music player focused on downloading YouTube media, caching it on disk, and playing it from that cache.

## Language

**TMU**:
The working name for the new lean TUI music player being planned in this repository.
_Avoid_: cliamp clone, lightweight cliamp

**Provider**:
A narrow boundary that lists and searches Tracks and resolves them for playback. The YouTube Cache is the only current Provider, while the abstraction remains as an extension point for possible future sources.
_Avoid_: backend, source

**Cache Search**:
The typed-query state of the Library tab, matching healthy cached Tracks and incomplete Cache Entries by their user-facing Track Title or available incomplete-entry title, channel or uploader, YouTube video ID, or cache-file stem, without Provider headings, filters, hidden Source Titles, or network calls. With no query, the YouTube Cache is ordered by newest Cache Entry first.
_Avoid_: Global Search, Provider Search, YouTube search

**Track**:
The canonical playable music item that Providers add to TMU's shared queue. Current Tracks come from the YouTube Cache.
_Avoid_: song, media item, provider item

**Track Title**:
The user-facing name of a Track throughout TMU. A user-defined title overrides the downloaded Source Title without changing Track Identity; when no override exists, the Source Title is the Track Title.
_Avoid_: display label, renamed filename

**Source Title**:
The original title obtained from YouTube when a Track is downloaded, retained as internal cache metadata even after the Track Title is changed and not separately exposed in the TUI.
_Avoid_: old name, original filename

**Track Identity**:
The durable `(providerId, stableId)` identity used for queue deduplication, restore, and Provider refresh. YouTube Cache Tracks use Provider ID `youtube-cache` and the YouTube video ID, never a title or URL.
_Avoid_: stream URL identity, display title identity

**Playback Locator**:
The runtime disk path TMU hands to the Player to start a cached Track.
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
The TUI-owned, session-only state for navigation and view-local interaction, such as active tab, focused pane, selected row, active prompt, filter text, and scroll position. Library and YouTube Downloader keep this state while switching tabs, but it is not persisted across restarts.
_Avoid_: app state, playback state

**TMU Config**:
The configuration file for YouTube download settings, low-power cadence, and dependency policy. It does not choose among Providers or configure the YouTube Cache location in the MVP.
_Avoid_: separate credentials store, secret database

**External Tools**:
The command-line programs TMU orchestrates rather than reimplementing: `yt-dlp` for YouTube extraction/download and `mpv` for playback. TMU does not require `ffmpeg` globally; any extra tool need is reported only when the invoked `yt-dlp` operation requires it.
_Avoid_: built-in downloader, built-in transcoder, media processing engine

**YouTube Cache**:
The fixed-location, TMU-managed library of audio files and metadata created by the YouTube URL Download Flow, and the canonical implementation/UI name replacing Offline YouTube Cache. YouTube and YouTube Music URLs resolve to the same cache identity when they share a video ID. A healthy existing Track is not redownloaded, refreshed, or changed to a different container; an incomplete entry is repairable, arbitrary user-copied audio is not imported, and cached Tracks are never removed automatically for age or size.
_Avoid_: Offline YouTube Cache, local music folder, download folder, saved YouTube, reveal file

**Cache Entry**:
The atomic on-disk representation of one cached Track: one non-empty media file produced by successful `yt-dlp` download, named `<video-id>.<ext>` in its selected native container, and one authoritative TMU JSON sidecar named `<video-id>.json` containing YouTube video ID, title, uploader or channel, known duration, cached time, media filename/container, and optional thumbnail URL. Missing or invalid media or JSON makes the entry incomplete; repair may adopt a different `<video-id>.<new-ext>` when the old entry was already incomplete. Embedded media tags are optional and never authoritative, a full source URL is derivable rather than stored as source authority, and deeper playability is discovered by mpv during playback.
_Avoid_: media file, database row, embedded tags, raw yt-dlp info JSON

**Cache Health**:
The health status shown directly on incomplete TMU-shaped Cache Entries in the Library list. An incomplete entry is visibly distinguished from a healthy Track, explains its reason in the selected-entry inspector, cannot use playback or Queue actions, and keys confirmed cleanup on its video ID or cache-file stem rather than display metadata. Cache Search includes it using whatever metadata is available, falling back to its stem. Recoverable entries may be repaired by resubmitting their URL in YouTube Downloader, while unrelated files are ignored and never deleted automatically.
_Avoid_: Track Availability, local-file import, automatic cleanup

**Cache Deletion**:
The explicitly confirmed, permanent removal of a Track's media and metadata from the YouTube Cache, recoverable only by downloading again. Any matching Queue entry remains visibly unavailable; deleting the playing Current Track first stops playback, retains it as Current, and resets its position.
_Avoid_: remove from Queue, automatic cleanup, filesystem delete

**Rename Track**:
The Library action that assigns a non-empty Track Title to a healthy cached Track without changing its Track Identity, Source Title, media filename, Playback Locator, or playback state. The title change is persistent and immediately applies to every visible copy of the Track; incomplete Cache Entries cannot be renamed.
_Avoid_: rename file, edit Source Title, temporary label

**YouTube URL Download Flow**:
The only workflow for adding media to the YouTube Cache. Each submission accepts one `youtube.com`, `music.youtube.com`, or `youtu.be` URL, including Shorts URLs that resolve to a normal YouTube video ID, and rejects bare IDs or obvious non-YouTube URLs before extraction. A normal video/watch URL creates a single-video Download Batch even if it also contains a playlist parameter, while an explicit playlist URL first requires all-or-cancel confirmation of its title and best-known source item count. Downloaded Tracks are stored independently without retaining playlist information or changing playback.
_Avoid_: YouTube search, YouTube browsing, YouTube streaming, YouTube provider playback

**Download Batch**:
The sequential work created by one submitted YouTube URL, processing its Tracks one at a time in source order. Successes survive item failures, unavailable playlist entries, or cancellation; batch cancellation stops remaining work in that batch and removes the interrupted item's partial files, while the final result distinguishes downloaded, already-cached, failed, and cancelled work.
_Avoid_: Playlist, Music Collection, transaction

**Download Pipeline**:
The session-bound FIFO sequence of submitted Download Batches, with at most one active Track download across all batches. It may run alongside playback without changing playback state; cancelling the active batch continues to the next pending batch, and pending batches may be removed before they start without affecting the cache. Its queue, status, progress, and session summaries are shown in the YouTube Downloader rather than the Playback Tab. Quitting with work requires confirmation before cancelling all active and pending work. Summaries and failures are not persisted.
_Avoid_: Queue, parallel downloads, download playlist

**Low-Power TUI**:
The UI constraint that terminal rendering remains event-driven and bounded, with playback progress redrawn at a low default cadence of approximately five seconds rather than animated continuously; TMU Config may change the periodic progress cadence.
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

**Playback Tab**:
The default TUI surface opened by TMU's only launch form, `tmu`, with a focusable Queue Pane, an optional non-focusable Selected Track Preview, and a distinct Now Playing Bar at the bottom. At medium and wide widths the Queue and preview form an approximately 2:1 left/right split; at narrow widths the preview stacks below the Queue. Launch always starts on the Playback Tab and restores the Last Queue Snapshot without autoplay. The Playback Tab remains visible when the Queue is empty, keeps Queue Pane focus, shows no Current Track, and belongs to the same top-level tab set as Library and YouTube Downloader.
_Avoid_: dashboard, browse home, always-visible search

**Queue Pane**:
The focusable list in the Playback Tab, showing the ordered Queue entries together with their selection, current, and playback status. It is the Playback Tab's only focus target and occupies the larger portion of the layout when shown beside the Selected Track Preview.
_Avoid_: library pane, playlist view, browser pane

**Selected Track Preview**:
A compact, non-focusable metadata area for the selected Queue Track. It appears to the right of the Queue Pane at medium and wide widths and below it at narrow widths. It is absent when no Track is selected and is independent of the Current Track and playback state.
_Avoid_: Playing Track Pane, Current Track details, focusable inspector

**Now Playing Bar**:
The non-focusable area immediately above the contextual shortcut footer on every Top-Level Tab, representing the Current Track and its playback status independently from selection in the active tab. It is absent when there is no Current Track and distinguishes restored playback that can Resume at a saved position from an explicitly Stopped Track that will start from the beginning.
_Avoid_: Selected Track Preview, focusable playback pane, animated playback panel

**Library**:
The top-level tab for finding Cache Entries already present in the YouTube Cache. It is entirely local and uses Cache Search to produce one list containing healthy playable Tracks and visibly unhealthy incomplete Cache Entries. `Enter` on a healthy Track means Play Now, separate actions handle Play Next, Add to Queue, and confirmed Cache Deletion, while incomplete entries disable playback and Queue actions and allow confirmed cleanup. It does not show download queue or download progress.
_Avoid_: provider browser, local library, download status

**YouTube Downloader**:
The top-level tab for submitting YouTube or YouTube Music video and playlist URLs and observing the Download Pipeline. It owns download queue display, active download status, cancellation, pending-batch removal, and session summaries; accepted submissions clear the URL input after they create a Download Batch, while pre-batch validation failures or cancelled playlist confirmations keep it editable. Downloading never adds Tracks to the Queue by itself.
_Avoid_: Library, Queue Home status, playback queue

**Top-Level Tabs**:
The primary TUI structure containing Playback, Library, and YouTube Downloader, labeled `Player`, `Library`, and `Downloads` in the compact top bar. `[` and `]` switch cyclically to the previous and next tab, including while ordinary tab text inputs are focused; literal brackets are therefore unavailable in those inputs, and there are no numeric tab shortcuts. A modal text editor such as Rename Track suspends tab switching and accepts brackets as content. Tab and Shift+Tab move focus only among panes within the active tab. Tabs are switched intentionally by the user and are not restored across restarts; the Playback Tab remains the default listening surface, Library is for cached music discovery, and YouTube Downloader is for download submission and status. Global playback shortcuts continue to work across tabs except where a focused text input or modal intentionally captures keys.
_Avoid_: overlay-first UI, provider tabs, hidden download status

**Vim Navigation**:
TMU's canonical keyboard movement language: `j`/`k`, `h`/`l`, `gg`/`G`, and paging keys, with arrow, Home, and End keys available as conventional aliases.
_Avoid_: arrow-only navigation, mouse-first navigation

**Contextual Shortcut Help**:
TMU's keyboard-discovery layer: a small footer shows only the most relevant actions for the focused pane, while `?` outside text entry opens a modal listing every shortcut for the active tab's panes plus global shortcuts and their input-capture conditions. Within text entry `?` remains ordinary input; while the modal is open, only its scrolling controls, `Enter`/`q`/`?`/`Esc` dismissal, and the normal global `Ctrl-C` quit flow remain active, without triggering underlying tab actions.
_Avoid_: permanent shortcut wall, undocumented keymap

**Play Next**:
The TUI action that moves or inserts a Track into the next Queue position without duplicates and never starts playback. The Current Track stays in place; an empty Queue receives the Track at its head.
_Avoid_: enqueue, add to end, play now, autoplay

**Add to Queue**:
The Library action that adds a cached Track to the end of the Queue only when it is not already queued, without starting playback, moving existing Queue entries, or changing the Current Track. It is distinct from downloading, which never queues Tracks by itself.
_Avoid_: download to queue, Play Now, Play Next

**Play Now**:
The TUI action that deduplicates a Track into the Queue, makes it Current, and starts it from the beginning immediately. A different former Current Track remains immediately before it so Previous returns to that Track; without a Current Track, it goes at the Queue head.
_Avoid_: autoplay, resume, play next

**Play Selected**:
The Playback Tab action that makes the selected existing Queue Track Current and starts it from the beginning without changing Queue order. Previous and Next Track then follow the selected Track's existing neighbors. Library uses Play Now instead because its Track may not yet be in the Queue.
_Avoid_: Play Now, Resume, Play Next, queue reorder

**Clear Queue**:
The destructive TUI action that, after explicit confirmation, stops playback, clears the Current Track, and removes every Track from the Queue. Cancelling the confirmation leaves both Queue and playback unchanged.
_Avoid_: unconfirmed clear, automatic advance after clear

**Randomize Queue**:
The one-shot Queue action that visibly randomizes every Track, including the Current Track. The Current Track keeps playing without interruption and remains Current at its new visible index; playback then follows the resulting visible order and Play Next remains literally next. Randomize Queue is not a playback mode: it has no enabled state, toggle, or status indicator, and invoking it again simply randomizes the entire Queue again.
_Avoid_: Shuffle mode, hidden random playback order

**Next Track**:
The playback action that starts the next playable Track in visible Queue order, skipping unavailable Tracks without removing them. Repeat All wraps through that visible order; with Repeat All off and no later playable Track, Next Track retains the Current Track, stops playback, and resets its resumable position to the beginning, matching natural completion of the Queue.
_Avoid_: clearing Current Track at Queue end, silently removing unavailable Tracks

**Previous Track**:
The playback action that restarts the Current Track when playback is more than five seconds in; at five seconds or less it starts the preceding visible Queue Track. At the Queue head it restarts Current rather than clearing it.
_Avoid_: always changing Queue rows, clearing Current at Queue head

**Track Availability**:
The runtime-derived ability of a queued Track to resolve and play, shown visibly with a reason when its Cache Entry or a playback attempt fails. mpv playback failures mark the Track unavailable for the session so automatic advancement skips it instead of repeatedly retrying. Unavailable restored Tracks retain their Queue order and Current Track designation and may recover later after cache rescan; TMU never silently removes them. Direct Resume and Play Now fail on the requested Track without substitution unless a future explicit retry action is added.
_Avoid_: silently removed track, hidden playback error

**Last Queue Snapshot**:
The small persistence record TMU updates and restores automatically so Queue order, Track data, Current Track and position, repeat, and volume survive exit and relaunch. It excludes Track Availability, Queue selection, scroll, filters, active tab, and other UI State, and never becomes a general app database or media-library index. Restoration is all-or-nothing. Corrupt, unsupported, or partially invalid snapshot data is quarantined for recovery; TMU opens the Playback Tab with an empty Queue and a non-blocking warning, and does not replace it until the user makes a meaningful state change. Write failures leave playback and in-memory state working, remain visibly actionable, retry later, and never trap exit.
_Avoid_: app database, library index
