# App Coordinator Failure And Auto-Advance Workflows

Status: ready-for-agent

## Parent

../PRD.md

## What to build

Harden the App Coordinator workflows that connect Queue, Providers, Player, dependency health, Track Availability, and auto-advance. Playback failures, Provider resolution failures, missing dependencies, and unavailable Tracks should all produce visible App State while preserving Queue contents and allowing playback to continue where appropriate.

This slice should verify TMU's main behavioral test seam: UI intent in, observable App State, Queue state, Provider calls, Player commands, and persisted records out.

## Acceptance criteria

- [ ] Provider resolution failures mark the affected Track unavailable with a visible reason.
- [ ] Player load or command failures mark playback state without corrupting Queue state.
- [ ] Missing mpv prevents load attempts and exposes dependency health through App State.
- [ ] Missing yt-dlp prevents YouTube URL Download actions without affecting other Provider workflows.
- [ ] Auto-advance skips unavailable or failed Tracks according to Queue policy while preserving visible Track Availability.
- [ ] Navidrome stream URLs are resolved at playback time and not persisted after failures.
- [ ] Offline YouTube Cache missing-media failures stay visible in the Queue.
- [ ] Coordinator tests cover UI intents through fake Providers, fake Player, fake dependency health, fake cache/download services, Queue state, and App State outcomes.

## Blocked by

- 18 - mpv Player Adapter And Playback Controls
- 19 - Local CLI File Playback End To End
- 25 - Navidrome Artist Album Playback Path
- 27 - Offline YouTube Cache Provider
