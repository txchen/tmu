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
The configuration file for YouTube download settings, low-power cadence, and dependency policy. It does not choose among Providers or configure the YouTube Cache location in the MVP.
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
The sequential work created by one submitted YouTube URL, processing its Tracks one at a time in source order. Successes survive item failures, unavailable playlist entries, or cancellation; batch cancellation stops remaining work in that batch and removes the interrupted item's partial files, while the final result distinguishes downloaded, already-cached, failed, and cancelled work.
_Avoid_: Playlist, Music Collection, transaction

**Download Pipeline**:
The session-bound FIFO sequence of submitted Download Batches, with at most one active Track download across all batches. It may run alongside playback without changing playback state; cancelling the active batch continues to the next pending batch, and pending batches may be removed before they start without affecting the cache. Its sequence, status, progress, and session summaries are shown in the YouTube Downloader rather than the Playback Tab. Quitting with work requires confirmation before cancelling all active and pending work. Summaries and failures are not persisted.
_Avoid_: Queue, parallel downloads, download playlist

**Low-Power TUI**:
The UI constraint that terminal rendering remains event-driven and bounded, with playback progress redrawn at a low default cadence of approximately five seconds rather than animated continuously; TMU Config may change the periodic progress cadence.
_Avoid_: efficient UI, battery friendly UI

**Playlist**:
A durably identified, user-named, ordered collection of Tracks that directly owns its playback order, Current Track, saved position, stopped-or-resumable state, and Repeat All setting. A Track may belong to multiple Playlists but appears at most once per Playlist by Track Identity; names are trimmed, non-empty, unique after case-folding, and at most 16 Unicode characters.
_Avoid_: Queue, collection, mix

**Active Playlist**:
The Playlist currently visible, identified in the top bar, and targeted by playback and Library actions. Switching away from Playing or Paused saves a resumable position, while explicitly Stopped remains at `0:00`; switching restores the destination Playlist without autoplay, selects its Current Track or first Track, and resets scroll to reveal it.
_Avoid_: selected playlist, current queue

**Playlist Manager**:
The global modal opened with `P` outside text entry for switching, creating, renaming, deleting, and persistently ordering Playlists. Opening always selects and reveals the Active Playlist; each row shows its Active marker, name, and Track count. Vim navigation and `Enter` switch, `c` creates at the end and immediately activates, `e` renames, `x` requests confirmed deletion, and `J`/`K` reorder. Create and rename enter text-edit mode where `Enter` submits, `Esc` returns, validation errors stay inline, and printable command characters become name text. A successful rename returns with that row selected; confirmed deletion stays open and selects the replacement row, or the previous row after deleting the last; `Enter` on the already Active Playlist only closes the manager without changing playback.
_Avoid_: Playlist Switcher, playlist tab, playlist pane

**Delete Playlist**:
The confirmed removal of a Playlist and its Track memberships, identified by name and Track count in the confirmation, without changing the YouTube Cache. Deleting the Active Playlist stops playback and activates the next Playlist in manager order, or the previous one when it occupied the last row; the sole remaining Playlist cannot be deleted.
_Avoid_: Clear Playlist, delete queue

**Default Playlist**:
The initial Playlist created by TMU, initially named `Default`, which receives any migrated legacy Queue snapshot. It may be renamed; TMU protects whichever Playlist is last from deletion rather than reserving this Playlist's identity or name.
_Avoid_: default queue, system queue

**Current Track**:
The one Track in the Active Playlist designated for playback. Switching Playlists stops playback and makes the destination Playlist's remembered Current Track current without autoplay.
_Avoid_: separate playing Track, selected Track as playback state

**Resume**:
The explicit action that starts the restored Current Track at its last saved playback position after relaunch. Relaunch never resumes automatically, and Play Now starts the Track from the beginning instead.
_Avoid_: autoplay on relaunch, Play Now from saved position

**Stop**:
The playback action that halts the Player, keeps the Current Track, and resets its resumable position to the beginning. Pause instead preserves position; removing the Current Track clears the designation. Reaching the natural end of the final playable Track with repeat off produces the same retained-Current, position-zero state.
_Avoid_: clearing Current Track, preserving the stopped position

**Playback Tab**:
The default TUI surface opened by TMU's only launch form, `tmu`, with a focusable Playlist Pane, an optional non-focusable Selected Track Preview, and a distinct Now Playing Bar at the bottom. At medium and wide widths the Playlist and preview form an approximately 2:1 left/right split; at narrow widths the preview stacks below the Playlist. Launch always starts on the Playback Tab and restores the Last Playlist Snapshot without autoplay. The Playback Tab remains visible when the Active Playlist is empty, keeps Playlist Pane focus, shows no Current Track, and belongs to the same top-level tab set as Library and YouTube Downloader.
_Avoid_: dashboard, browse home, always-visible search

**Playlist Pane**:
The focusable list in the Playback Tab, showing the Active Playlist's ordered Tracks together with their selection, current, and playback status. It is the Playback Tab's only focus target and occupies the larger portion of the layout when shown beside the Selected Track Preview.
_Avoid_: Queue Pane, library pane, browser pane

**Selected Track Preview**:
A compact, non-focusable metadata area for the selected Playlist Track. It appears to the right of the Playlist Pane at medium and wide widths and below it at narrow widths. It is absent when no Track is selected and is independent of the Current Track and playback state.
_Avoid_: Playing Track Pane, Current Track details, focusable inspector

**Now Playing Bar**:
The non-focusable area immediately above the contextual shortcut footer on every Top-Level Tab, representing the Current Track and its playback status independently from selection in the active tab. It is absent when there is no Current Track and distinguishes restored playback that can Resume at a saved position from an explicitly Stopped Track that will start from the beginning.
_Avoid_: Selected Track Preview, focusable playback pane, animated playback panel

**Library**:
The top-level tab for finding Cache Entries already present in the YouTube Cache. It is entirely local and uses Cache Search to produce one list containing healthy playable Tracks and visibly unhealthy incomplete Cache Entries. Its Play Now, Play Next, and Add to Playlist actions target only the Active Playlist; adding to another Playlist requires switching first.
_Avoid_: provider browser, local library, download status

**YouTube Downloader**:
The top-level tab for submitting YouTube or YouTube Music video and playlist URLs and observing the Download Pipeline. It owns download pipeline display, active download status, cancellation, pending-batch removal, and session summaries; accepted submissions clear the URL input after they create a Download Batch, while pre-batch validation failures or cancelled playlist confirmations keep it editable. Downloading never adds Tracks to a Playlist by itself.
_Avoid_: Library, Playlist status, playback list

**Top-Level Tabs**:
The primary TUI structure containing Playback, Library, and YouTube Downloader, plus the optional macOS-only Background Sounds Tab on candidate Macs. They are labeled `Player`, `Library`, `Downloads`, and, when present, `Background` in a compact top bar that also identifies the Active Playlist. `[` and `]` switch cyclically to the previous and next visible tab, including while ordinary tab text inputs are focused; literal brackets are therefore unavailable in those inputs, and there are no numeric tab shortcuts. A modal text editor such as Rename Track suspends tab switching and accepts brackets as content. Tab and Shift+Tab move focus only among panes within the active tab. Tabs are switched intentionally by the user and are not restored across restarts; the Playback Tab remains the default listening surface, Library is for cached music discovery, YouTube Downloader is for download submission and status, and Background is for macOS-owned Background Sound state. Global playback shortcuts continue to work across tabs except where a focused text input or modal intentionally captures keys.
_Avoid_: overlay-first UI, provider tabs, hidden download status

**Vim Navigation**:
TMU's canonical keyboard movement language: `j`/`k`, `h`/`l`, `gg`/`G`, and paging keys, with arrow, Home, and End keys available as conventional aliases.
_Avoid_: arrow-only navigation, mouse-first navigation

**Contextual Shortcut Help**:
TMU's keyboard-discovery layer: a small footer shows only the most relevant actions for the focused pane, while `?` outside text entry opens a modal listing every shortcut for the active tab's panes plus global shortcuts and their input-capture conditions. Within text entry `?` remains ordinary input; while the modal is open, only its scrolling controls, `Enter`/`q`/`?`/`Esc` dismissal, and the normal global `Ctrl-C` quit flow remain active, without triggering underlying tab actions.
_Avoid_: permanent shortcut wall, undocumented keymap

**Play Next**:
The TUI action that moves or inserts a Track into the next Active Playlist position without duplicates and never starts playback. The Current Track stays in place; an empty Playlist receives the Track at its head.
_Avoid_: enqueue, add to end, play now, autoplay

**Add to Playlist**:
The Library action that adds a cached Track to the end of the Active Playlist only when it is not already present, without starting playback, moving an existing entry, or changing the Current Track. It is distinct from downloading, which never adds Tracks to a Playlist by itself.
_Avoid_: Add to Queue, Play Now, Play Next

**Play Now**:
The TUI action that deduplicates a Track into the Active Playlist, makes it Current, and starts it from the beginning immediately. A different former Current Track remains immediately before it so Previous returns to that Track; without a Current Track, it goes at the Playlist head.
_Avoid_: autoplay, resume, play next

**Play Selected**:
The Playback Tab action that makes the selected existing Playlist Track Current and starts it from the beginning without changing Playlist order. Previous and Next Track then follow the selected Track's existing neighbors. Library uses Play Now instead because its Track may not yet be in the Active Playlist.
_Avoid_: Play Now, Resume, Play Next, Playlist reorder

**Clear Playlist**:
The destructive TUI action that, after explicit confirmation, stops playback, clears the Current Track, and removes every Track membership from the Active Playlist without changing the YouTube Cache. Cancelling the confirmation leaves both Playlist and playback unchanged.
_Avoid_: unconfirmed clear, automatic advance after clear

**Randomize Playlist**:
The one-shot Playlist action that visibly randomizes every Track in the Active Playlist, including the Current Track. The Current Track keeps playing without interruption and remains Current at its new visible index; playback then follows the resulting visible order and Play Next remains literally next. Randomize Playlist is not a playback mode: it has no enabled state, toggle, or status indicator.
_Avoid_: Shuffle mode, hidden random playback order

**Next Track**:
The playback action that starts the next playable Track in visible Active Playlist order, skipping unavailable Tracks without removing them. Repeat All wraps through that visible order; with Repeat All off and no later playable Track, Next Track retains the Current Track, stops playback, and resets its resumable position to the beginning, matching natural completion of the Playlist.
_Avoid_: clearing Current Track at Playlist end, silently removing unavailable Tracks

**Previous Track**:
The playback action that restarts the Current Track when playback is more than five seconds in; at five seconds or less it starts the preceding visible Playlist Track. At the Playlist head it restarts Current rather than clearing it.
_Avoid_: always changing Playlist rows, clearing Current at Playlist head

**Track Availability**:
The session-wide, Track Identity-based ability of a Track to resolve and play, shown with a reason on every matching Playlist membership. mpv playback failures mark every copy unavailable so automatic advancement skips it consistently; unavailable restored Tracks retain their Playlist order and Current Track designation and may recover after cache rescan.
_Avoid_: silently removed track, hidden playback error

**Last Playlist Snapshot**:
The atomic persistence record containing every Playlist in user-defined order, each Playlist's playback state, and the Active Playlist identity. Only when it is absent does TMU migrate the legacy Queue snapshot into the Default Playlist; invalid data is quarantined rather than reviving legacy state, while write failures leave in-memory operation working, warn visibly, and retry later.
_Avoid_: Last Queue Snapshot, app database, library index
