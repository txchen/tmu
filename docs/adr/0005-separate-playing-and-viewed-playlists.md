---
status: accepted
---

# Separate the Playing Playlist from each client's Viewed Playlist

TMU will retain one daemon-owned Playing Playlist as the shared playback context while giving every TUI Client an independent Viewed Playlist for browsing and for explicitly targeted Playlist and Library commands. Changing a Viewed Playlist never stops playback, changes another client's view, or changes the Playing Playlist; starting a Track from a Viewed Playlist promotes it to Playing Playlist. A newly connected client starts on the Playback Tab viewing the Playing Playlist, but its UI State is discarded on disconnect rather than restored as a durable client session. This supersedes ADR-0003's single Active Playlist because that combined shared playback ownership with terminal-local navigation, causing one client's browsing to unexpectedly redirect every other client and stop shared playback; deliberately ephemeral client state also avoids session identity and stale-session cleanup.

Deleting the Playing Playlist is allowed only after confirmation that shared playback will stop. The next Playlist in persistent order, or the previous one when the deleted Playlist was last, becomes Playing without autoplay, and every client viewing the deleted Playlist moves to that same replacement; the final Playlist remains protected from deletion.

Creating a Playlist returns its stable identity as Command Feedback and switches only the initiating client's Viewed Playlist; it does not affect the Playing Playlist or any other view. If that feedback cannot be delivered after the accepted command completes, the new shared Playlist still exists and appears in snapshots.

Global transport controls—play/pause, Stop, Next, Previous, seek, and volume—always target the shared Player and Playing Playlist regardless of what a client views. List operations—add, Play Next, clear, randomize, remove, and reorder—explicitly target that client's Viewed Playlist, while Play Selected and Play Now promote their target Viewed Playlist to Playing. The Now Playing Bar identifies the Playing Playlist so a client viewing elsewhere can see which context its global controls affect.
