---
status: accepted
---

# Switch to the daemon architecture in 0.4.0

TMU 0.4.0 will switch the product to the per-user daemon architecture in one release, without a user-facing legacy single-process mode or runtime feature flag. Implementation may proceed through internal seams and an in-process adapter, but the released CLI has one shared-state owner; retaining both modes would let them compete for mpv, the YouTube Cache, and persistence and recreate the race this change exists to remove. Existing snapshot `activePlaylistId` becomes the Playing Playlist during migration, and release guidance requires users to close all pre-0.4.0 TMU processes before first launch.

Before the first successful format migration, 0.4.0 preserves the original snapshot once under an explicit pre-0.4.0 backup name and considers migration complete only after the new snapshot is atomically committed. TMU does not automatically delete the backup or promise automatic downgrade, but release guidance explains manual restoration; unchanged YouTube Cache media is neither copied nor migrated.
