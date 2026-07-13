---
status: accepted
---

# Use Playlists as Playback Contexts

TMU will replace its singleton Queue with multiple persistent, user-named Playlists, one of which is Active and directly owns playback order, Current Track, saved position, stopped-or-resumable state, and Repeat All. We rejected keeping saved Playlists separate from an ephemeral playback queue because direct playback makes switching listening contexts predictable and keeps Library actions targeted to the visible Active Playlist.

The Last Playlist Snapshot atomically stores the ordered Playlists, their playback state, and Active Playlist identity, with shared Track records normalized by Track Identity. Existing Queue state migrates once into the initial Default Playlist; switching Playlists stops playback without autoplay, and downloading remains independent of Playlist membership.
