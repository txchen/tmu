# Navidrome Connection And Library Browser Entry

Status: resolved

## Parent

../PRD.md

## What to build

Add the Navidrome Provider connection path and initial Navidrome Library Browser entry. TMU should read Navidrome config, authenticate requests with Subsonic token and salt parameters, validate the server with ping, handle failed Subsonic payloads even when HTTP succeeds, preserve IDs as strings, and display a usable Provider entry state in the TUI.

This slice should not yet need full artist/album playback. It should make the connection, error, auth, and browsing entry behavior real and testable.

## Acceptance criteria

- [x] Navidrome config supports server URL, username, password material, client name, and reporting opt-out fields as needed by the MVP.
- [x] Navidrome requests use token and salt auth with JSON response format.
- [x] Navidrome connection validation uses ping.
- [x] Failed Subsonic response payloads are surfaced as API errors even when HTTP status succeeds.
- [x] Navidrome server IDs are preserved as strings.
- [x] The Navidrome source shows connected, missing config, auth failure, and API failure states in the TUI.
- [x] Secret fields are redacted from errors and display.
- [x] Tests use fake HTTP responses to cover auth parameters, ping success, ping failure, failed payload handling, ID preservation, and TUI source state.

## Blocked by

- 15 - Walking Skeleton For Queue-First TMU
- 16 - TMU Config And Dependency Health Surface
