# Keyboard-first TUI music player patterns for TMU

Research for **Study cliamp and other keyboard-first TUI music players**. Reviewed 2026-07-09. The cliamp source links are pinned to upstream commit `a5922d072e8aa48ceacccaef5572f4d3e63e1b07`; the comparison set is intentionally small and uses only project-owned documentation and source.

## Question

Which interaction and runtime patterns from cliamp and other keyboard-first terminal music players should TMU adopt for Queue Home, music discovery, transient pickers, Queue manipulation, playback control, shortcut discovery, terminal resizing, and low-render-cost operation?

## Executive decision

TMU should adopt cliamp's **interaction shape**, but not its **playlist/queue domain split**:

- Keep Queue Home present from startup, including when the Queue is empty. CLI paths may seed it and the Last Queue Snapshot may restore it, but neither should make a Provider Browsing Surface the home screen.
- Open Global Search, Provider navigation, shortcut help, and the Command Palette as transient Picker Overlays that preserve Queue and Playing Track context.
- Give every discovery result the same three named outcomes: **Play Now**, **Play Next**, and **Add to Queue** (if the last action is retained). Do not reuse cliamp's ambiguous `playlist` versus `play-next queue` terminology.
- Keep playback controls global, Queue editing local to Queue focus, and shortcut discovery progressive: a short contextual footer plus searchable complete help.
- Treat resize and low-power behavior as state-machine concerns: clamp selection/scroll on every geometry change, redraw on meaningful events, throttle progress-only updates, and do not introduce animation or idle polling by default.

The main thing to avoid is importing a library manager's information architecture. TMU's destination is already a [Queue-First MVP](../../CONTEXT.md): Provider browsing exists to produce canonical Tracks and Music Collections for one shared Queue, not to become a permanent library workspace.

## What cliamp demonstrates

### Startup: useful precedent, different default

cliamp resolves command-line paths, directories, URLs, and named playlists into its main playlist. Playback remains opt-in unless auto-play is configured. With no arguments, the default radio provider seeds a few stream rows; if nothing can be loaded, focus moves to the provider browser. This is playlist-first, but not consistently queue-home-first ([startup assembly](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/main.go#L190-L228), [initial focus](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/init.go#L188-L203), [CLI options](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/docs/cli.md#L5-L15)).

For TMU, the reusable idea is that startup inputs populate the primary upcoming-list surface without forcing playback. The provider-browser fallback is not reusable: an empty Queue is still meaningful and should show an empty-state invitation inside Queue Home.

### Queue model: visible priority, but an unsuitable two-layer domain

cliamp has a persistent playlist plus a separate, transient play-next queue. On the main list, `a` toggles a row's membership in that queue and `A` opens the queue manager. Rows expose `[Q1]`, `[Q2]`, and so on, while the header shows the count. Next-track selection consumes these priorities before returning to playlist order ([keybindings](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/docs/keybindings.md#L71-L80), [visible queue ranks](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/view.go#L475-L525), [next-track resolution](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/playlist/playlist.go#L518-L578)).

The good pattern is **making next-up order legible on the home surface**. TMU should show current, selected, unavailable, and next-up status directly in the Queue Pane. It should not create a second queue. TMU's **Play Next** is an ordered mutation of the one Queue; it never starts playback and it deduplicates by Track Identity.

The cliamp queue overlay stays deliberately shallow: Vim/arrow movement, Shift+Up/Down reorder, `d` remove, `c` clear, and `Esc`/`A` close. Playlist moves and removals repair the transient queue's index references ([queue overlay input](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/keys.go#L2393-L2445), [queue mutation invariants](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/playlist/playlist.go#L651-L734)). TMU should preserve that small editing vocabulary, but enforce its invariants using Track Identity rather than UI row indices.

### Finding music: many entry points, one action language

cliamp supports local filtering, provider-native search, provider jump keys, and provider browsers. The strongest pattern is that different result surfaces converge on a compact action set: activate/play, append, replace, or queue next. In provider search, `Enter` plays, `a` appends, and `q` queues next; provider track browsers similarly offer play-here, replace-all, append-all, and queue-one ([search and provider keys](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/docs/keybindings.md#L49-L69), [provider browser actions](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/docs/keybindings.md#L118-L179), [search-result handling](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/keys_spotify_search.go#L63-L108)).

TMU should normalize the behavior more aggressively than cliamp does. Every Track or Music Collection result should expose the same domain actions by name:

1. **Play Now**: make the Track current and start it; for a Music Collection, keep the remainder contiguous.
2. **Play Next**: insert or move without starting playback; keep collection order and remove duplicates.
3. **Add to Queue**: append without starting playback, only if product scope still needs an explicit tail action.

Provider-specific fetching and navigation can differ behind these actions. Their Queue meaning should not.

### Transient pickers: preserve listening context

cliamp's keymap, theme, visualizer, audio-device, playlist, file, provider, search, queue, info, URL, lyrics, and jump interfaces replace only the central playlist region. The surrounding now-playing and control context remains stable. Preview-oriented pickers can update on cursor movement and restore the previous value on `Esc` ([inline-overlay contract](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/inline_overlays.go#L14-L24), [picker rendering](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/inline_overlays.go#L119-L185), [overlay dispatch](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/overlays.go#L11-L49)).

This directly supports TMU's Picker Overlay vocabulary. TMU should keep Queue Home underneath the overlay, restore focus/selection/filter state on cancel, and commit only on an explicit action. Search results need not keep updating behind the overlay after dismissal; preserving Queue context matters more than preserving a provider's page as a permanent workspace.

### Playback controls and shortcut discovery

cliamp keeps common playback controls global: Space play/pause, `s` stop, next/previous keys, five-second and larger seeking, volume, speed, and time jump. Navigation accepts both arrows and Vim keys, including paging/top/end forms ([global keybindings](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/docs/keybindings.md#L5-L35)).

It also uses progressive discovery. The footer renders only a few context-relevant actions and an anchor to full help; `?`/Ctrl+K opens a scrollable, searchable complete keymap ([context footer](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/view.go#L771-L787), [keymap construction](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/keymap.go#L17-L74), [keymap search](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/keymap.go#L260-L330)).

TMU should adopt the progressive structure, not cliamp's large key namespace. The footer should name the active surface's few most likely actions. `?` should open Contextual Shortcut Help; `:` should open a searchable Command Palette containing all valid actions in the current context, with shortcuts shown as metadata. The palette is the escape hatch that lets the direct keymap stay small.

### Resizing and redraw cost

cliamp handles terminal-size messages explicitly: it recomputes available list height from fixed chrome, switches into a compact width, and clamps each open overlay's cursor and scroll range. The frame is rendered in the alternate screen ([resize update](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/update.go#L61-L97), [width and height calculation](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/view.go#L114-L145), [scroll clamping](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/scroll.go#L32-L70)).

Its update cadence is adaptive: animation-capable states may update quickly, ordinary playback more slowly, and idle state much more slowly, while key, IPC, and plugin events still wake the program. It also caches layout/player/picker data ([cadence constants](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/tick.go#L5-L20), [adaptive scheduling](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/tick.go#L109-L170), [model caches](https://github.com/bjarneo/cliamp/blob/a5922d072e8aa48ceacccaef5572f4d3e63e1b07/ui/model/model.go#L297-L314)). This is architecture evidence, not a measured CPU or battery result.

TMU should go further toward quiescence. No idle tick is needed. Render input and semantic state changes immediately; coalesce duplicate state; throttle playback position and provider/download progress; redraw only the affected row/region where the terminal backend makes that safe. Animated visualization is outside the Low-Power TUI default.

## Cross-checks from established projects

### ncmpc: help is part of the product, and columns should degrade gracefully

ncmpc's official documentation makes key discovery an explicit runtime feature: `1` opens help, `K` opens a key editor, and the help screen identifies the loaded keybinding file. Its experimental Queue table assigns each column a minimum cell width and a share of excess width, allowing a terminal layout to allocate space intentionally rather than rely on hard-coded string truncation ([ncmpc keys and tables](https://ncmpc.readthedocs.io/)).

For TMU, searchable help is more important than live key editing in the MVP. The table model is useful: define minimum widths and priority for Queue and Playing Track fields, hide low-priority metadata before damaging the action/status columns, and fall back to one focused pane on narrow terminals.

### musikcube: a warning against accidental library-manager scope

musikcube's project-owned overview describes a terminal player backed by `musikcore`, which includes file scanning, tag indexing, play-queue management, playlist CRUD, a plugin architecture, and libraries above 250,000 Tracks; its user guide is where the project directs users for keyboard shortcuts ([musikcube project overview](https://musikcube.com/)). This is a mature and coherent product shape, but it is not TMU's MVP shape.

The comparison reinforces a scope boundary: TMU Providers may browse and search, but TMU should not absorb scanning, indexing, playlist CRUD, or a central library database merely to make its TUI feel complete. Those capabilities would make Provider Browsing Surfaces and persistence own domain behavior that `CONTEXT.md` intentionally assigns to Providers, the Queue, and the Last Queue Snapshot.

## Mapping to the current TMU implementation

The current code already contains several foundations worth retaining:

- CLI arguments seed the shared Queue and focus it; no-argument startup can restore the Last Queue Snapshot (`src/coordinator.ts`, `start`).
- UI State is separated from App State (`src/domain.ts`, `UiState` and `AppState`).
- Queue mutations and Player workflows are expressed as App Coordinator intents rather than renderer-owned effects (`src/domain.ts`, `AppIntent`; `src/coordinator.ts`, `dispatch`).
- `RenderScheduler` snapshots state, skips identical renders, distinguishes playback/download/provider progress, and throttles progress-only changes (`src/tui.ts`, `RenderScheduler`).
- Direct playback and Queue manipulation keys already exist (`src/tui.ts`, `intentFromKey`).

The main gaps between current code and the intended design are structural:

- No-argument startup restores a Provider target and the initial UI target is Local, whereas Queue Home should remain the stable home even when empty.
- Rendering is currently a Targets rail, Provider Browsing Surface, Queue/Player strip, dependency health, and diagnostics. It is not yet the two-pane Queue Home with Picker Overlays described in `CONTEXT.md`.
- Prompts are enum cases embedded in the Provider surface rather than instances of a shared Picker Overlay model.
- Keybindings are a flat dispatcher. There is no context-aware action registry, contextual footer, complete shortcut help, or Command Palette.
- Selection movement handles arrows but does not yet implement the full Vim Navigation vocabulary or geometry-aware viewport clamping.
- Full-frame string rendering remains the normal path; the scheduler has a partial playback-progress write, but resize policy and generalized region invalidation are not yet modeled.

## Recommended interaction contract

1. **Queue Home is always the base surface.** Restore or seed the Queue without autoplay. Empty Queue Home offers Global Search, open-local, and YouTube URL actions.
2. **One overlay protocol.** Each Picker Overlay owns query text, rows, selected identity, scroll offset, pending request, and a return-focus token. `Esc` cancels and restores the token; action dispatch commits through the App Coordinator.
3. **One result action vocabulary.** Every Provider maps its native data to Track or Music Collection results, then uses the same Play Now, Play Next, and optional Add to Queue actions.
4. **One Queue.** Play Next reorders/inserts in the shared Queue. Do not create cliamp's second priority queue or call a persistent list a playlist.
5. **Stable global controls.** Space play/pause, next/previous, seek, and volume remain usable while a non-text-entry overlay is open. Text-entry mode must visibly suspend conflicting character shortcuts.
6. **Progressive shortcut discovery.** Footer actions derive from the same action registry used by `?` help and `:` Command Palette; do not maintain three parallel key descriptions.
7. **Responsive tiers.** Wide: Queue Pane plus Playing Track Pane. Narrow: focused pane only, with a key to switch. Always preserve selection by Track Identity, then clamp scroll after layout.
8. **Event-driven rendering.** Input, resize, Provider results, Queue mutation, playback state transitions, and errors invalidate regions immediately. Position/download/provider progress are bounded by TMU Config. Idle produces no redraw timer.

## Avoid

- A provider or library browser as the no-argument home screen.
- Separate persistent-playlist and play-next-queue concepts.
- Provider-specific meanings for `Enter`, Play Next, or collection insertion.
- An always-visible shortcut wall or a hidden flat keymap with no discoverability layer.
- Fixed column assumptions without narrow-terminal behavior and selection/scroll repair.
- Idle animation, visualizers, or polling justified only by precedent in richer players.
- Central library indexing, playlist CRUD, or plugin-host scope before the Queue-First MVP is complete.

## Sources

- cliamp upstream repository and documentation, pinned at [`a5922d0`](https://github.com/bjarneo/cliamp/tree/a5922d072e8aa48ceacccaef5572f4d3e63e1b07).
- [ncmpc official documentation](https://ncmpc.readthedocs.io/).
- [musikcube official project overview](https://musikcube.com/).
- TMU's local [domain context](../../CONTEXT.md) and current `src/domain.ts`, `src/coordinator.ts`, `src/tui.ts`, `src/renderer.ts`, and `src/state.ts`.

## Limitations

This was a source-and-documentation review, not an interactive usability study or performance benchmark. cliamp is moving quickly, so all of its citations are commit-pinned. ncmpc and musikcube are cross-checks rather than exhaustive feature audits; their role here is to validate shortcut-discovery, responsive-table, and scope-boundary conclusions.
