# TMU TUI Experience

TMU is a keyboard-first YouTube Cache player with three top-level tabs: Playback, Library, and YouTube Downloader. It always opens on Playback and restores the Last Queue Snapshot without autoplay.

## Layout and visual language

The top bar is a full-width bordered strip presenting Playback, Library, and YouTube Downloader as tabs labeled `Player`, `Library`, and `Downloads`. Inactive labels are dim; the active label uses cyan plus bold/inverse styling; subtle `[` and `]` navigation hints sit at the right edge. Tabs have no numeric prefixes or numeric shortcuts. `[` and `]` switch cyclically to the previous and next tab, even while an ordinary tab text input has focus; literal brackets are therefore unavailable in those inputs. Modal text editors suspend tab switching and accept brackets as content. Tab and Shift+Tab are reserved for moving focus among panes within the active tab. Mouse interaction is deferred until vue-tui provides mouse support.

TMU preserves the terminal's default background so it works with light and dark themes. It uses standard ANSI semantic accents: cyan for the active tab and focused-pane border, green for playing/success/healthy state, yellow for paused/pending/warnings, red for failures/unavailable state/destructive confirmation, and dim text for secondary metadata and inactive shortcuts. Bold, borders, labels, and inverse styling ensure that meaning never depends on color alone. Focus is communicated through styling rather than the word "focused."

TMU honors `NO_COLOR`. Color-free rendering retains every border, symbol, badge, label, bold/inverse focus cue, and status distinction; it is also the preferred stable mode for structural rendering tests.

A focused pane has a cyan border and bold cyan title; an unfocused pane has a neutral dim border. The selected row in a focused list uses inverse styling and a `›` marker, while an unfocused list retains only a dim `›`. A focused input has a cyan border and visible cursor. TMU never renders a textual `focused` marker.

Scrollable list pane titles show total count and selected position, such as `Queue · 12 tracks · 4/12` or `Library · 86 results · 9/86`; TMU does not draw terminal scrollbars.

Panes use Unicode rounded single-line borders with one-cell gaps. Now Playing and the shortcut footer use lightweight horizontal separators instead of full boxes to conserve vertical space.

Below `60×16`, TMU shows its terminal-too-small surface and suspends all controls except Ctrl+C; playback and downloads continue, and resize restores the preserved UI state. From 60–89 columns, inspectors stack. From 90–119, Player uses its left/right split while Library remains stacked. At 120 columns and above, both Player and Library use their side-by-side inspector layouts.

Transient operation feedback appears in a single-line semantic status banner above Now Playing. Success messages disappear after a short delay; warnings and errors persist until Esc dismisses them or a relevant subsequent action replaces them.

## Playback

Playback shows the shared Queue in a focusable pane and the selected Queue Track in a separate, non-focusable preview. At medium and wide widths they use an approximately 2:1 left/right split; at narrow widths the preview stacks below the Queue. The preview is absent when no Track is selected and never substitutes for Current Track playback state.

Queue rows show a playback/status symbol, title, and duration. The leading symbol identifies playing, paused, stopped, unavailable, and non-current Tracks without a trailing Current Track badge; an unavailable Current Track uses `⚠`, distinct from the `!` on other unavailable Tracks. Channel and other metadata stay in the preview.

In the Queue, Enter invokes Play Selected: it makes the selected existing Queue Track Current and starts it from the beginning without changing Queue order. Space toggles play/pause for Current; `N` moves the selected Track to Play Next; `J`/`K` moves it down/up with selection following; `x` removes it without confirmation because cached media is unaffected; `C` opens Clear Queue confirmation; and `Z` invokes one-shot Randomize Queue. Removing Current stops playback and clears the Current designation.

A non-focusable Now Playing Bar appears immediately above the shortcut footer on every tab while a Current Track exists. It shows playback status, Track title, a progress bar with elapsed/duration, volume, and a compact `↻ ALL` badge only while Repeat All is enabled. It does not show artist/uploader or Randomize Queue state. Progress redraws at a low default cadence of approximately five seconds and on relevant user/player events rather than animating continuously. Global playback shortcuts remain available from every tab except while a text input captures keys. Queue entries stay visible when unavailable and show the current runtime reason.

An empty Player Queue says “Queue is empty — open Library to add Tracks.”

Randomize Queue is a one-shot operation that visibly reorders every Queue entry, including the Current Track. The Current Track keeps playing without interruption and remains Current at its new visible index; playback continues through the resulting visible order. It is not a playback mode and has no persistent toggle or indicator.

## Library

Library searches healthy YouTube Cache Tracks and incomplete Cache Entries in one list using the user-facing Track Title, available incomplete-entry title, uploader, YouTube video ID, or cache-file stem. A hidden Source Title does not match Cache Search. Healthy Tracks expose Play Now, Play Next, Add to Queue, Rename Track, and confirmed permanent Cache Deletion. Incomplete entries have a red warning indicator, explain their health reason in the inspector, disable playback, Queue, and rename actions, and expose confirmed cleanup keyed by video ID or stem.

Healthy and incomplete entries share the normal newest-first ordering, using the best available cache or file timestamp. Health status does not change an entry's rank, including in filtered results.

In Results, Enter invokes Play Now, `a` adds a healthy Track to the Queue, `N` moves/adds it to Play Next, `O` opens a healthy Track in YouTube's embedded player with autoplay disabled, `e` opens Rename Track for a healthy Track, `d` opens confirmed permanent deletion for a healthy Track or confirmed cleanup for an incomplete entry, and `/` focuses Search. Search filters live while typing; Enter or Esc transfers focus to Results without clearing the query, with Enter selecting the first match but never starting playback from the Search field. Playback, Queue, open, and rename actions are visibly disabled and omitted or dimmed in contextual help when the selected row is incomplete.

Rename Track is a centered modal text editor showing the current Track Title and a prefilled New name field. It trims leading and trailing whitespace, rejects an empty result, allows duplicate and Unicode titles, and supports insertion and paste at the cursor, Left/Right, Home/End, Backspace, and Delete. Enter persists the title and closes the modal, Esc cancels, and Ctrl+C retains the quit flow; other underlying shortcuts, including tab switching and playback, are suspended, so brackets are ordinary title characters. A write failure preserves the input and shows an error in the modal. Success immediately updates Library, Queue, Selected Track Preview, Now Playing, and the Last Queue Snapshot without interrupting playback; it retains the Cache Search query and shows a brief success notification. The Source Title remains internal metadata, while Track Identity, media filename, and Playback Locator are unchanged.

An empty cache says “No cached Tracks — open Downloads,” while a filter with no matches says “No results for …”.

The Search field and results list are focusable and Tab/Shift+Tab moves between them. Results receives initial focus when Library is first opened; `/` also focuses Search. The selected Track inspector is non-focusable: it appears to the right on wide terminals and stacks below the list at medium and narrow widths. Library preserves its query, selection, and focus when switching tabs.

Library rows show health symbol, title, duration, and size; Channel is omitted from the row. At narrow widths size, then duration, truncate before title or health. Full metadata remains available in the inspector.

Selected Track inspectors label YouTube uploader metadata accurately as `Channel`, never `Artist`. They show title, Channel when available, duration, cached date, media format, human-readable file size, video ID, and any health or availability reason. File size is derived from the cached media file rather than duplicated in its sidecar. The Now Playing Bar continues to show title only.

## YouTube Downloader

YouTube Downloader accepts one YouTube URL per submission. Explicit playlists require all-or-cancel confirmation. Accepted Download Batches enter a session-only FIFO Download Pipeline with one active Track download globally. The tab shows active work, progress, pending batches, cancellation/removal actions, and categorical session summaries. Downloading never changes the playback Queue.

The URL Input sits above a full-width Download Pipeline list. Both are focusable and Tab/Shift+Tab moves between them; URL Input receives initial focus when Downloader is first opened. Active, pending, and completed session batches render their status, progress, counts, and concise failure indicators inline. Additional failure text may expand beneath the selected row, but there is no separate batch inspector.

An active Pipeline row shows status, batch title or URL, item position, and a compact progress bar with percent. A pending row shows status, title or URL, and known item count. A completed row shows status and downloaded/cached/failed/cancelled counts. Long URLs truncate before status or progress.

Enter in URL Input submits it. In Pipeline, `x` opens confirmation to cancel the selected active batch or remove the selected pending batch; it does nothing on a completed summary. There is no separate `c` cancel-active shortcut.

An empty Pipeline says “Paste a YouTube URL above to begin.” Empty states remain concise and do not use a decorative splash screen.

## Navigation and help

Queue, Library Results, and Download Pipeline share non-wrapping list navigation: `j`/`k` and arrows move one row, `Ctrl+d`/`Ctrl+u` and PageDown/PageUp move one page, and `gg`/`G` jump to first/last. Movement clamps at list boundaries. A compact footer shows at most five `key action` pairs prioritized for the focused pane and always ending with `? Help`; tab navigation stays in the top bar, lower-priority actions move to the modal, and narrow screens drop the lowest-priority pairs. `?` toggles a concise, non-scrollable modal with the complete active-tab shortcut reference and global playback and tab-switching shortcuts; Esc also dismisses it, and other actions are suspended while it is open. There is no Command Palette.

Outside text inputs, global playback controls are Space Play/Pause, `n`/`p` Next/Previous, `s` Stop, `h`/`l` seek −5/+5 seconds, `-`/`+` volume, and `r` Repeat All; `q` quits. While an ordinary tab input is focused, printable keys—including those shortcuts and `?`—edit the input. Enter performs the input's action, Tab/Shift+Tab changes pane, and Esc moves focus to the tab's list without clearing text. `[`/`]` remain global tab navigation in ordinary tab inputs; a modal editor instead captures them as content. Ctrl+C remains global Quit, including the quit-with-downloads confirmation.

All destructive or interrupting confirmations use one centered, bordered modal system rather than inline status text. This includes cache deletion/cleanup, Clear Queue, download cancellation, playlist acceptance, and quitting with active or pending downloads. Cancel is selected by default. Left/Right or Tab changes the selected choice, Enter activates it, `y` confirms directly, and `n` or Esc cancels directly.

The canonical domain rules and vocabulary live in [`../CONTEXT.md`](../CONTEXT.md).
