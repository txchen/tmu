---
status: accepted
---

# Serialize shared commands and reject stale destructive confirmations

The TMU Daemon will place Shared Commands from every peer TUI Client and daemon-owned background event into one serial commit sequence, producing a monotonically increasing State Revision after each committed change. Commands use stable domain identities rather than client-visible indexes; ordinary commands revalidate and apply to the latest state in sequence, so two Next Track commands advance twice, while destructive confirmations carry the target and confirmed revision and are rejected for renewed confirmation if an intervening change altered their target or impact. Long-running downloads execute outside the sequence but submit their short state transitions through it. This chooses deterministic shared behavior without a controlling client or coarse user-visible locks, while preventing approval based on stale destructive consequences.

Clients do not calculate or attest destructive impact themselves. They request a daemon-owned Confirmation Challenge containing an opaque token, stable target, State Revision, and display-ready current impact, then return only that token after approval. Tokens are bound to the requesting client, single-use, expiring, and invalidated by disconnect or relevant impact changes; rejection returns or requires a fresh challenge. The TUI and command-line shutdown path share this interface.

Challenges protect Shutdown Daemon, Delete Playlist, Clear Playlist, deletion of a healthy Cache Track, cleanup of an incomplete Cache Entry, cancellation of an active Download Batch, removal of a pending Download Batch, and acceptance of a playlist-sized YouTube download. Stop and other playback controls, single-Track Playlist removal, rename and reorder operations, challenge cancellation, and Quit Client remain direct commands or client-local actions.

A single-video submission accepted by the daemon, or a playlist submission whose challenge has been confirmed, creates a daemon-owned Download Batch that continues after its initiating client disconnects. Playlist metadata preparation also runs in the daemon, but if it reaches a required challenge after that client disconnects, or the client disconnects before confirming, preparation is cancelled and no Batch enters the pipeline. URL text not submitted remains solely client UI State.

A complete validated command frame becomes accepted when enqueued. It then executes despite a later client disconnect, with any undeliverable feedback discarded and shared results still published; an incomplete or unqueued frame never executes. Disconnect invalidates a challenge not yet returned, but cannot revoke a confirmed operation already validated and enqueued. TMU deliberately provides no implicit disconnect rollback transaction.

Commands preserve user intent across concurrent clients: shortcut operations carry relative changes such as volume adjustment, seeking, or identity-based movement, which the daemon computes against the latest state when executed; explicit controls may submit absolute values. Stable Playlist, Track, Cache Entry, and Batch identities cross the connection, but client-visible row indexes never do. Feedback reports the realized result and the resulting snapshot converges every client.
