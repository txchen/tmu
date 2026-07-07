# Define Navidrome OpenSubsonic Scope

Type: research
Status: resolved
Blocked by: 01

## Question

What subset of the Navidrome/Subsonic/OpenSubsonic API should TMU implement for the MVP, and what authentication/reporting behavior is required?

Evaluate login/auth format, ping, playlists, album/artist browsing, streaming URLs, cover art, search, scrobble/now-playing reporting, pagination, and compatibility risks with non-Navidrome Subsonic servers.

## Answer

Research note: [05-define-navidrome-opensubsonic-scope.md](../research/05-define-navidrome-opensubsonic-scope.md)

TMU's MVP Navidrome provider should be a read-only, queue-first Subsonic/OpenSubsonic client targeted at Navidrome semantics, using the ID3 browsing API rather than folder browsing.

Required MVP surface:

- Authenticate every request with Subsonic token+salt auth: `u`, `t=md5(password + salt)`, `s`, `v=1.16.1`, `c`, and `f=json`.
- Validate setup with `ping`; treat top-level `subsonic-response.status = "failed"` as an API error even when HTTP status is 200.
- Support read-only playlist browsing with `getPlaylists` and `getPlaylist`, omitting the unsupported Navidrome `username` filter.
- Support full Navidrome artist/album browsing with `getArtists`, `getArtist`, `getAlbumList2`, and `getAlbum`.
- Support song search-to-queue with `search3`, using simple user text and song-only pagination for MVP.
- Generate authenticated `stream?id=<songId>&format=raw` URLs at playback time and pass them to the shared mpv controller.
- Preserve `coverArt` IDs from API responses and use `getCoverArt` only if the UI later needs images; do not substitute song, album, or artist IDs as cover-art IDs.
- Report playback with best-effort `scrobble`: `submission=false` when Navidrome playback starts, and `submission=true&time=<unixMillis>` after TMU's local completed-play threshold. Provide a config opt-out and never let reporting failures block playback.

Implementation constraints:

- Keep all Navidrome IDs as strings.
- Store stable queue identity as provider name plus server URL plus song ID; do not persist auth-bearing stream URLs as durable identity.
- Page `getAlbumList2` and `search3` lazily, around 100 rows per page; load `getArtists` once per session and refresh explicitly.
- Use in-memory caches only for MVP. Do not mirror the Navidrome library into a local database.
- Keep compatibility promises narrow: this should work against Navidrome and standard Subsonic/OpenSubsonic servers for the selected endpoints, but TMU should not chase server-specific folder browsing, Lucene search, OpenSubsonic API-key auth, or extension negotiation in the MVP.

Postponed beyond MVP: playlist writes, ratings/stars, shares, bookmarks, server-side play queues, media-library scan controls, internet radio, user management, folder browsing, video, lyrics, OpenSubsonic-only extensions, API-key auth, offline mirroring of the Navidrome library, and broad non-Navidrome compatibility work.
