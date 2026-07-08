# Walking Skeleton For Queue-First TMU

Status: resolved

## Parent

../PRD.md

## What to build

Create the first runnable TMU application skeleton in Bun/TypeScript. It should establish the Queue-First MVP shape end to end: a foreground TUI starts, shows Local, Navidrome, Offline YouTube Cache, YouTube URL Download, and Queue as source targets, renders a persistent queue/player region, accepts basic navigation intents, and routes those intents through an App Coordinator into observable App State and UI State.

This slice is intentionally thin. It does not need real playback, real Providers, downloads, persistence, or dependency checks yet. It should make the main boundaries real enough that later slices can plug in Provider behavior, Queue behavior, Player behavior, persistence, and dependency health without replacing the skeleton.

Prototype context: the source switcher and navigation shell prototype demonstrates the intended shell behavior, and the low-power TUI prototype demonstrates the intended event-driven render cadence.

## Acceptance criteria

- [ ] TMU can be run as a Bun/TypeScript foreground terminal app.
- [ ] The TUI exposes Local, Navidrome, Offline YouTube Cache, YouTube URL Download, and Queue as sibling source targets.
- [ ] The TUI renders a Provider Browsing Surface area and a persistent queue/player region.
- [ ] UI input dispatches intents to an App Coordinator rather than mutating playback or Provider state directly.
- [ ] App State and UI State are represented separately.
- [ ] The Queue contains canonical Track entries with durable Track Identity separated from Playback Locator.
- [ ] Provider, Queue, Player, App Coordinator, App State, and UI State boundaries exist in a form later slices can extend.
- [ ] Tests cover startup, source navigation, visible shell state, and intent dispatch through the App Coordinator using fake boundaries.

## Blocked by

None - can start immediately
