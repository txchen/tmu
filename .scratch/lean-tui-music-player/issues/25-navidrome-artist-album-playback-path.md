# Navidrome Artist Album Playback Path

Status: resolved

## Parent

../PRD.md

## What to build

Implement the main Navidrome artist and album browse-to-play path. Users should browse artists and albums through the Navidrome Library Browser, enqueue remote Tracks into the shared Queue, and play them by resolving Track Identity into authenticated raw stream Playback Locators at playback time.

This slice establishes Navidrome as a real Provider without adding playlist browsing, search, or scrobble yet.

## Acceptance criteria

- [x] Navidrome Library Browser loads artists once per session and supports explicit refresh.
- [x] Users can browse from artist to album to Track.
- [x] Album and Track loading supports lazy paging where needed.
- [x] Navidrome Tracks enqueue into the shared Queue as canonical Tracks.
- [x] Navidrome Track Identity uses Provider name, server URL, and song ID.
- [x] Auth-bearing stream URLs are generated only at playback time and are not persisted as Track Identity.
- [x] Stream Playback Locators are passed to the shared mpv Player through the App Coordinator.
- [x] coverArt IDs from responses are preserved without substituting unrelated IDs.
- [x] Tests cover artist/album browsing, ID string behavior, Track shape, enqueue, stream URL generation, playback handoff, and coverArt preservation using fake HTTP responses.

## Blocked by

- 17 - Queue State, Modes, And Last Queue Snapshot
- 18 - mpv Player Adapter And Playback Controls
- 24 - Navidrome Connection And Library Browser Entry
