# TMU Keyboard-First TUI Experience Specification

This specification is the implementation handoff produced by [Wayfinder: Design an intuitive keyboard-first TMU TUI](https://github.com/txchen/tmu/issues/34). It consolidates the map's accepted interaction, visual, architecture, migration, and test decisions. The linked resolution tickets remain the rationale and detailed decision record.

## Scope

TMU provides one keyboard-first, Queue-First MVP experience for finding Tracks from Local, Navidrome, and Offline YouTube Cache Providers, shaping a shared Queue, and controlling playback. Queue Home is stable; transient work happens in Picker Overlays; default rendering remains event-driven and low-power.

This change redesigns the TUI and may introduce narrow contracts at the App Coordinator boundary. It does not replace the Player, Provider, Queue, or App State models wholesale, add live YouTube streaming, create a media-library manager, add a theme system, or expand the supported platform set.

## Product invariants

- `tmu` is the only launch form. Track and path CLI arguments are removed.
- Launch always opens Queue Home, restores the Last Queue Snapshot when valid, and never autoplays.
- Every Provider feeds one Queue. Track Identity, never title or Playback Locator, drives deduplication, restoration, selection repair, and Current Track continuity.
- Queue selection is UI State. Current Track is the sole playback designation.
- Queue Home remains beneath all Picker Overlays. Dismissing an overlay restores the underlying context.
- Color, animation, and elapsed-time redraws are never required to understand or operate TMU.

## State ownership and intents

App State owns Provider data, Queue contents, Current Track and playback state, downloads, availability, and app-level errors. UI State owns the overlay stack, focus-return tokens, identity-based selection, scrolling, query and filter input, responsive tier, pending confirmations, and pending Vim chords.

Vue components receive readonly App State and UI State snapshots through a composition root. A pure UI reducer handles view-local changes. Semantic App Intents carry the selected Track, Music Collection, or Provider operation explicitly to the App Coordinator; the coordinator never reads or mutates UI selection.

## Queue Home

### Layout

Queue Home has one permanent header, all remaining content, and one permanent footer. It uses no app-title banner, boxed panels, decorative borders, artwork reservation, lyrics reservation, animated progress bar, or focusable Playing Track Pane.

| Terminal size | Queue Home layout |
| --- | --- |
| Wide, at least 120 columns | Queue Pane and Playing Track Pane side by side at approximately 60/40 |
| Medium, 80–119 columns | Queue Pane and condensed Playing Track Pane side by side at approximately 2/3 and 1/3 |
| Narrow, 60–79 columns | One-line Current Track summary below the header, then Queue, optional exceptional-state line, and footer |
| Below 60 columns or 16 rows | Stable terminal-too-small screen; underlying App State and UI State are preserved |

The header reads `Queue · <count> Tracks`. Shuffle, Repeat All, and volume align right when space permits and move into the narrow Current Track summary otherwise.

Queue rows occupy one terminal row and never wrap. Wide rows show state markers, title, Artist, Provider, and duration; medium rows omit Provider; narrow rows show state markers, title, and duration. Flexible text truncates with an ellipsis.

State markers occupy fixed display cells: `›` selection, `●` Current Track, and `!` unavailable. If the Unicode symbols do not measure as one cell, TMU falls back as a set to `>`, `*`, and `!`. Selection also uses inverse styling, Current Track uses emphasis, and unavailable uses warning styling. Playing, Paused, Stopped, and Restored are text in the Playing Track area rather than Queue-row icons.

The Playing Track area prioritizes playback state and title; Artist, Album, Provider, and duration; resume, stopped, or unavailable guidance; then Shuffle, Repeat All, and volume.

### Launch and empty state

- Valid Last Queue Snapshot restoration recreates Queue order, availability, Current Track, saved position, Shuffle, Repeat All, and volume.
- Restoration never starts the Player. Selection resets to Current Track, otherwise the first Queue row.
- Empty Queue Home retains Queue Pane focus, has no selection or Current Track, and offers Global Search, Local music, and YouTube URL Download actions.
- Relaunch does not restore cursor position, scrolling, filters, Picker Overlays, or other UI State. Provider navigation starts at its source-neutral root.
- A restored Current Track says `Resume from m:ss`; an explicitly stopped Current Track says `Stopped · starts from beginning`.

### Playback and Queue actions

- Play, Pause, Resume, Stop, Next Track, Previous Track, seeking, volume, Shuffle, and Repeat All target Current Track or the Queue contract, independent of Queue selection.
- With no Current Track, Play starts the selected Queue row from the beginning. With no selection, it does nothing.
- Stop retains Current Track and resets its resumable position to zero. Pause retains position.
- Next Track starts the next playable Track in visible order and skips unavailable Tracks without removing them. Repeat All wraps. With Repeat All off and no later playable Track, Next Track retains Current Track, stops playback, and resets position to zero, matching natural Queue completion.
- Previous Track restarts Current Track when position is greater than five seconds. At five seconds or less it starts the preceding visible Queue Track. At the Queue head it restarts Current Track.
- Removing Current Track stops the Player, clears Current Track, and never advances automatically. Selection moves to the next surviving row or to the previous row when the removed row was last.
- Reordering follows Track Identity. Selection follows the moved Track; Current Track remains current; playback is uninterrupted.
- Clear Queue opens a confirmation with Cancel selected. Confirming stops playback, clears Current Track, and removes all Tracks; cancelling changes nothing.

### Play Next and Play Now transformations

Play Next never starts playback. It deduplicates the requested Track or Music Collection by Track Identity, removes existing non-Current occurrences, and inserts one contiguous block in collection order immediately after Current Track. Current Track stays in place and is omitted when included in the request. With no Current Track, the block goes at the Queue head.

Play Now starts the requested Track or the first Track of a Music Collection from the beginning. It deduplicates the request into one contiguous block. A different former Current Track remains immediately before the new block so Previous Track returns to it. With no Current Track, the block goes at the Queue head.

Shuffle visibly randomizes only Tracks after Current Track. Playback follows visible order. Disabling Shuffle retains the current order; starting another shuffled repeat cycle reshuffles the upcoming portion.

### Availability

Unavailable Tracks retain Queue order and Current Track designation and show a reason. Next Track and automatic advancement skip them. If no playable candidate exists, playback stops and the prior Current Track remains Current.

Direct Resume or Play Now failure remains on the requested Current Track, reports the failure, and does not substitute another Track. Wide and medium rows replace lower-priority metadata with a truncated reason. Narrow rows say `Unavailable`; selecting or acting on one exposes its full reason and recovery action above the footer.

## Music-finding Picker Overlay

One dual-mode Picker Overlay provides Provider navigation when its query is empty and Global Search after query submission.

### Opening, focus, and dismissal

- `o` opens the source-neutral Provider root with results focused.
- `/` opens the same overlay with its search field focused.
- Within search input, Enter submits and returns focus to results; Esc returns focus to results without clearing the query.
- Esc from results dismisses the overlay and restores Queue Home context.
- Clearing the query restores the prior Provider navigation location and selection.
- The overlay remembers navigation location and selection during the current process only.

### Global Search contract

- Results have four types: Tracks, Artists, Albums, and Playlists.
- Results group first by type and then by Provider. Each Provider's ranking is preserved; TMU does not synthesize cross-Provider relevance.
- Every type/Provider subgroup is capped at 50 results. There is no Load More control.
- Provider identity appears on result rows.
- Optional Provider and result-type filters default to All, last only while the overlay remains open, and constrain the next submitted query.
- Artists are navigation results, not Music Collections and not queueable.
- Providers load independently. Successful results remain usable while other Providers load or fail. Loading, empty, authentication, offline, and other failures are scoped per Provider with Retry. Overall no-results appears only when every participating Provider has finished.
- A replacement query supersedes outstanding work for the previous query.

### Provider contracts

Providers explicitly declare searchable result types and browsable hierarchies. Unsupported capabilities are omitted.

- Local exposes searchable Tracks and Local Directory navigation. A Local Directory is not inferred to be a Music Collection and is not recursively queueable.
- Navidrome exposes Artists, Albums, Playlists, and Tracks. Artists open Albums; Albums and Playlists open ordered Tracks. Navidrome loads complete Artist, Album, and Playlist lists for navigation but search requests only matching Tracks. It is absent until TMU Config identifies a server; configured disabled, offline, and authentication-failure states remain visible with recovery actions.
- Offline YouTube Cache exposes searchable and browsable Tracks without synthesizing Artists or Music Collections.

Artists sort by name; Albums by title then Artist; Playlists by name; Album Tracks by disc then track number; Playlist Tracks retain stored Playlist order.

Albums and Playlists are lightweight results. Opening or queueing one resolves its complete Track list lazily. Resolution and the resulting Queue transformation are atomic; failure or cancellation leaves the Queue unchanged and the overlay open.

## Keyboard interaction

One context-aware action registry owns names, bindings, enabled predicates, disabled reasons, and App Intents. Direct input, the footer, Contextual Shortcut Help, and the Command Palette derive from this registry. The MVP keymap is fixed.

### Navigation

| Action | Canonical binding | Alias |
| --- | --- | --- |
| Move down/up | `j` / `k` | Down / Up |
| First/last row | `gg` / `G` | Home / End |
| Half-page down/up | Ctrl-d / Ctrl-u | — |
| Full-page down/up | — | Page Down / Page Up |
| Open/go back | `l` / `h` | Right / Left; Backspace also goes back from results |

The first `g` enters a visible pending state. A second `g` within 750 ms completes the chord; another key cancels it and is handled normally. Esc cancels it. Movement clamps at boundaries and keeps the selected identity visible.

### Global playback outside text entry

| Action | Binding |
| --- | --- |
| Play/Pause/Resume | Space |
| Stop | `s` |
| Next/Previous Track | `n` / `p` |
| Seek backward/forward five seconds | `[` / `]` |
| Volume down/up five points | `-` / `+` |
| Shuffle | `z` |
| Repeat All | Command Palette only |

### Contextual actions

- Queue rows: Enter Play Next; Shift+Enter Play Now; `J`/`K` move; `x` or Delete remove; `c` Clear Queue.
- Track, Album, or Playlist results: Enter Play Next; Shift+Enter Play Now.
- Provider, Artist, or Local Directory: Enter, `l`, or Right opens it.
- Album or Playlist: `l` or Right opens it for inspection.
- Results: `f` opens filters; `r` retries the selected failed Provider section.
- Queue Home: `u` opens YouTube URL Download.
- Legacy terminals that cannot distinguish Shift+Enter use the Command Palette for Play Now.

Unsupported actions are absent from the footer and do nothing if dispatched.

### Text entry and overlay precedence

Only the top Picker Overlay receives input. While a search, URL, filter, help, or Command Palette field has focus, printable keys edit the field and suspend playback commands, navigation chords, and direct commands. Backspace deletes one character, Ctrl-w deletes the previous word, Ctrl-u clears the field, and Enter submits or invokes the selected result.

`?` opens searchable Contextual Shortcut Help, current-context actions first and global actions second. `/` focuses its filter. `:` opens the Command Palette with its query focused; it searches names and aliases, includes shortcut metadata, and shows context-relevant disabled actions with reasons. A selected palette action closes the palette before invocation.

`q` quits gracefully from Queue Home, dismisses the top non-text overlay, and types `q` in a text field. Ctrl-c requests graceful quit everywhere.

Clear Queue confirmation starts on Cancel; `h`/`l`, Left/Right, or Tab changes choice; Enter activates; `y` confirms; `n`, Esc, or `q` cancels.

YouTube URL Download continues as App State after its progress overlay closes. `u` reopens active status and `x` asks to cancel. Quitting during a download requires confirmation and explains cleanup; otherwise quit is immediate.

## Overlay geometry and resize

- On wide terminals, music finding is centered at about 80% of the terminal and capped at `112×32`; help and palette cap at `88×28`; confirmations cap at `56×9`; YouTube entry/progress caps at `88×12`.
- Medium overlays use a two-column, one-row inset.
- Narrow overlays fill the usable screen and may cover Queue Home completely.
- Overlay geometry remains stable for short result lists. Required regions are title, query or location, scrollable content, and footer.
- The underlying layer dims; only the top layer is interactive; overlay transitions are not animated.
- Resize preserves Current Track, Track-identity selection, Queue order, overlay stack, query, focus, Provider location, and pending confirmation. It recomputes the responsive tier immediately and minimally repairs scroll.
- The terminal-too-small screen freezes underlying UI State and restores the same context when size recovers.

## Footer, accessibility, and color

The footer permanently occupies one row and never wraps. Wide and medium layouts show four to six enabled high-value actions. Narrow shows the primary action plus `? Help` and `: Commands`; both discovery routes remain visible at every supported size.

TMU preserves the terminal's default background and foreground. Bold, inverse, and standard ANSI accent/warning/error colors add redundant hierarchy. `NO_COLOR` is respected. Markers and text keep every state legible in monochrome; truecolor is not required.

## Persistence and recovery

The Last Queue Snapshot contains ordered Track identities and display metadata, last-known availability, Current Track by Track Identity, playback position, Shuffle, Repeat All, and volume. It excludes Playback Locators, authenticated URLs, credentials, selection, scroll, filters, overlays, and other UI State.

TMU saves after semantic Queue, Current Track, and persisted-setting changes; on pause, stop, and graceful quit; and during playback no more often than once every 30 seconds. Writes use atomic replacement.

Restoration is all-or-nothing. An unsupported version, invalid required field, invalid Queue entry, or missing Current Track reference quarantines the file with a `.corrupt-<timestamp>` suffix, opens empty Queue Home, and shows one non-blocking warning. TMU writes a replacement only after a meaningful state change.

Write failure leaves playback and memory state operational, shows a persistent actionable path and error, and retries on the next save trigger. Quit reports unsaved state but is never trapped.

## Low-Power TUI budget

UI publication occurs on input, resize, playback-state transitions, semantic Queue/Provider/download changes, and errors. Elapsed playback-position changes do not publish unless TMU Config enables a cadence. Provider and download progress use configured bounded throttles and coalesce duplicate values.

TMU adds no animated spinner, waveform, marquee, blinking indicator, transition, idle timer, autonomous redraw loop, or default playback tick. Vue-tui owns component commits and terminal lifecycle after TMU's semantic publication gate.

## Architecture and distribution

- Adopt exact pinned compatible Vue and vue-tui versions, explicitly accepting vue-tui's beta API and current testing/source-runtime risks.
- Distribute TMU as an npm package requiring installed Bun. Support `bunx tmu` and global installation followed by `tmu`; remove standalone compiled-binary delivery.
- Build Queue Home and Picker Overlays as vue-tui components. Do not add Pinia, a private render tree, a terminal adapter abstraction, or a custom layout engine.
- Keep Queue, Providers, Player, App Coordinator, App State, UI State, action registry, selectors, and intents framework-neutral.
- One root input router applies top-overlay and text-entry precedence, advances key sequences, and dispatches registry actions.
- Vue-tui owns Yoga layout, focus primitives, raw input, resize observation, terminal commits, cursor/screen mechanics, and component teardown.
- A thin bootstrap owns startup, App Coordinator teardown, Last Queue Snapshot persistence, download-aware quit confirmation, signals, and fatal errors. Add custom lifecycle behavior only for a gap proved by an integration test.

## One-way migration

1. Extract a pure UI reducer/store and semantic App Intent boundary from the existing coordinator without changing Queue or Provider behavior.
2. Add a development-only vue-tui tracer using the real App Coordinator. Prove restored Queue Home without autoplay, one stacked Picker Overlay, registry dispatch, resize, semantic publication cadence, graceful quit, and terminal restoration.
3. After those checks pass, make vue-tui the only `tmu` entry point. Delete the legacy ANSI renderer, `TerminalTui`, full-frame `RenderScheduler`, compiled-binary path, and CLI Track/path startup mode rather than retaining compatibility layers or dual production modes.
4. Implement remaining surfaces against the same reducer, intents, registry, state, and selectors.

The interaction prototype is evidence, not production code. Delete it or absorb only useful test data after the production surfaces replace it.

## Verification and acceptance criteria

### Pure contract tests with `bun:test`

- Queue transformations cover Track and Music Collection deduplication, Current Track preservation, Previous return, selection repair, removal, clear confirmation outcome, visible Shuffle, Repeat All, unavailable skipping, and explicit Next Track at Queue end.
- Snapshot tests cover valid restoration, no autoplay, explicit Resume, 30-second checkpoint limits, atomic save triggers, quarantine, write failure, and retry.
- UI reducer tests cover identity selection, overlay stack and focus tokens, text-entry precedence, filters, pending confirmations, resize tiers, scroll repair, and the 750 ms `gg` state machine without a recurring timer.
- Registry tests prove direct input, footer, help, and palette share bindings, enabled predicates, and disabled reasons.
- Selector/publication tests prove equivalent state does not redraw, default playback position does not publish, configured playback cadence is bounded, and Provider/download progress coalesces.
- App Coordinator tests prove App Intents carry explicit domain targets and do not depend on UI selection.

### Component tests

Use `@vue-tui/testing` only when its version is compatible with the pinned runtime. Cover each Queue Home tier, Queue marker fallbacks, empty/restored/stopped/unavailable states, overlay geometry, discovery footers, monochrome output, Provider partial failure, and terminal-too-small recovery. Do not build a replacement component-test framework.

### Real-runtime PTY smoke tests

Until compatible component testing exists, and afterward for lifecycle coverage, prove:

- `tmu` opens restored Queue Home without autoplay and Space explicitly resumes.
- Queue selection remains independent of Current Track through movement and resize.
- Provider navigation, submitted Global Search, partial Provider failure, Play Next, Play Now, collection resolution, and overlay dismissal preserve the specified context.
- Queue reorder, removal, Clear Queue confirmation, Next Track at Queue end, unavailable skipping, Shuffle, Repeat All, and quit behave as specified.
- Wide, medium, narrow, terminal-too-small, and recovery layouts retain identity and overlay state.
- An idle default session and ordinary playback-position updates produce no autonomous redraws.
- Configured cadence and Provider/download progress remain within their bounds.
- Graceful quit, signals, fatal errors, and active-download confirmation restore the terminal and cursor.
- `NO_COLOR` and ASCII marker fallback remain fully operable.

Implementation is accepted only when the pure contract suite passes, required PTY smoke coverage passes on the supported runtime, no legacy production renderer or CLI-seeded path remains, and the production package works through both `bunx tmu` and global npm installation with Bun.

## Decision sources

- [Specify Queue Home and automatic Queue restoration](https://github.com/txchen/tmu/issues/35)
- [Specify Global Search and Provider navigation](https://github.com/txchen/tmu/issues/37)
- [Specify the keyboard command and discovery model](https://github.com/txchen/tmu/issues/40)
- [Validate Queue Home and Picker Overlays with an interactive prototype](https://github.com/txchen/tmu/issues/39)
- [Choose the TUI architecture and migration seam](https://github.com/txchen/tmu/issues/38)
- [Specify final TUI visual layout and responsive terminal constraints](https://github.com/txchen/tmu/issues/43)
- [Study cliamp and other keyboard-first TUI music players](https://github.com/txchen/tmu/issues/42)
- [Evaluate vue-tui for TMU's low-power interaction model](https://github.com/txchen/tmu/issues/41)
