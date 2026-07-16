---
status: accepted
---

# Publish revisioned full shared-state snapshots

The TMU Daemon will send each connecting TUI Client a complete serializable Shared State Snapshot with its State Revision and publish another complete snapshot after committed shared changes; clients ignore duplicate or older revisions. Playback position, download progress, and similar progress-only changes retain bounded low-power publication cadence. Provider, Player, persistence implementations, and all client-owned UI State stay outside the snapshot. We prefer full snapshots over an incremental event protocol for the first daemon version because reconnect and convergence become stateless and directly testable; incremental transport remains an optimization only if measured snapshot size or publication cost later requires it.

Shared facts are broadcast through snapshots, but Command Feedback is returned only to the initiating client and rendered as ephemeral UI State. Daemon Notices such as recovery, system-wide capability changes, and intentional shutdown are broadcast to every connected client. Download state and daemon-lifetime summaries remain shared and visible in snapshots, while historical client notifications are never replayed to a new connection.

Because the daemon may run indefinitely, the snapshot retains the 500 most recently completed Download Batch summaries and evicts older summaries in completion order. Individual failure messages have a bounded serialized length. Active and pending batches do not count toward this completed-history cap, eviction never affects committed Cache Entries, and recovery still clears all summaries; bounded daemon logs retain older operational evidence without turning the snapshot into an unbounded audit record.

The daemon will not expose the existing unbounded global `appErrors` history. A currently effective capability failure lives beside that shared state, a command failure is directed to its initiating client, and lifecycle or severe system failures become broadcast Daemon Notices plus bounded log records. Status reports only the latest severe-error summary, while at most 20 recent important notices may be retained for diagnostics; new clients see current errors but do not replay obsolete toasts or a general historical error list.

Each connection has an independent bounded outbound buffer. A queued complete snapshot may be replaced by a newer revision, but Command Feedback, Confirmation Challenges, and shutdown or other control notices are never silently dropped. Sustained backpressure or overflow of non-droppable messages disconnects only the slow client; daemon state transitions, playback, downloads, and publication to other clients never await a client's socket reads or rendering.

TUI Clients never optimistically mutate their Shared State Snapshot. They may render a pending indicator and update terminal-local UI State immediately, but visible shared playback, Playlist, download, and Cache changes arrive only in a newer daemon revision; rejection therefore clears pending state and shows feedback without rolling back invented shared data. Relative commands may still be submitted repeatedly while prior commands are pending.
