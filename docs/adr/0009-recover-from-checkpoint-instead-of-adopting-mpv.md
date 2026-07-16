---
status: accepted
---

# Recover from a checkpoint instead of adopting orphan mpv

After an unexpected TMU Daemon exit, connected TUI Clients distinguish connection loss from intentional Shutdown Daemon and remain open on a non-operational connection-lost screen until their users quit; they neither exit automatically nor restart or reconnect to a daemon. A later explicit `tmu` launch creates a fresh daemon, which uses runtime metadata to verify and terminate an orphan mpv belonging to its predecessor, cleans stale socket state, and restores the latest durable Playlist and playback-position checkpoint without autoplay. TMU will not adopt the old mpv connection or infer shared state from it because mpv cannot reconstruct the daemon's Playlist, download, pending-command, and persistence state; interrupted playback is preferable to presenting an apparently seamless but divergent recovery. Cleanup must verify process identity rather than trusting a recycled PID.

The Download Pipeline continues when all TUI Clients disconnect but is not a persistent job system: recovery terminates verified orphan download processes, removes TMU-recognized temporary files, and discards active and pending batches, confirmations, progress, and summaries. Complete Cache Entries atomically committed before the crash remain discoverable after cache rescan, but interrupted downloads are neither resumed nor automatically resubmitted; reconnected clients receive a one-time recovery notice.

Playlist and playback semantic changes—including pause, stop, seek, changing the Playing Playlist, and starting a Track—checkpoint immediately, continuous playback checkpoints approximately every 30 seconds, and graceful daemon shutdown performs a final save. Quit Client causes no shared write. Atomic serialized persistence bounds crash recovery's pure playback-position rollback to roughly 30 seconds without turning position polling into continuous disk writes.
