import { describe, expect, test } from "bun:test";
import {
  MemoryQueue,
  type LastQueueSnapshot,
  type Track,
} from "../src/index";

function track(providerId: string, stableId: string, title: string): Track {
  return {
    identity: { providerId, stableId },
    title,
    providerLabel: providerId,
  };
}

describe("MemoryQueue", () => {
  test("dedupes canonical Tracks by durable Track Identity", () => {
    const queue = new MemoryQueue();
    const first = track("local", "/music/amber.flac", "Amber");
    const duplicateWithFreshMetadata = {
      ...first,
      title: "Amber remastered",
      album: "Later Metadata",
    };

    const entry = queue.enqueue(first);
    const duplicate = queue.enqueue(duplicateWithFreshMetadata);

    expect(duplicate).toBe(entry);
    expect(queue.snapshot().entries).toHaveLength(1);
    expect(queue.snapshot().entries[0]?.track).toEqual(first);
  });

  test("removes, moves, clears, and preserves the current Track selection", () => {
    const queue = new MemoryQueue();
    const amber = track("local", "/music/amber.flac", "Amber");
    const cinder = track("navidrome", "song-1", "Cinder");
    const drift = track("offline-youtube-cache", "youtube:drift", "Drift");
    queue.enqueue(amber);
    queue.enqueue(cinder);
    queue.enqueue(drift);

    expect(queue.startAt(1)?.track.title).toBe("Cinder");
    queue.move(1, 0);
    expect(queue.snapshot().entries.map((entry) => entry.track.title)).toEqual(["Cinder", "Amber", "Drift"]);
    expect(queue.snapshot().currentIndex).toBe(0);

    queue.remove(1);
    expect(queue.snapshot().entries.map((entry) => entry.track.title)).toEqual(["Cinder", "Drift"]);
    expect(queue.snapshot().currentIndex).toBe(0);

    queue.setShuffle(true);
    queue.setRepeatAll(true);
    queue.clear();
    expect(queue.snapshot().entries).toEqual([]);
    expect(queue.snapshot().currentIndex).toBe(-1);
    expect(queue.snapshot().shuffle).toBe(true);
    expect(queue.snapshot().repeatAll).toBe(true);
  });

  test("navigates next and previous with repeat-all wrapping", () => {
    const queue = new MemoryQueue();
    queue.enqueue(track("local", "a", "A"));
    queue.enqueue(track("local", "b", "B"));

    expect(queue.next()?.track.title).toBe("A");
    expect(queue.next()?.track.title).toBe("B");
    expect(queue.next()).toBeUndefined();
    expect(queue.snapshot().currentIndex).toBe(1);

    queue.setRepeatAll(true);
    expect(queue.next()?.track.title).toBe("A");
    expect(queue.previous()?.track.title).toBe("B");
    expect(queue.snapshot().repeatAll).toBe(true);
  });

  test("shuffle mode changes next-track navigation while retaining previous history", () => {
    const queue = new MemoryQueue({ random: () => 0.99 });
    queue.enqueue(track("local", "a", "A"));
    queue.enqueue(track("local", "b", "B"));
    queue.enqueue(track("local", "c", "C"));
    queue.startAt(0);

    queue.setShuffle(true);
    expect(queue.next()?.track.title).toBe("C");
    expect(queue.previous()?.track.title).toBe("A");
    expect(queue.snapshot().shuffle).toBe(true);
  });

  test("shuffle mode stops after every Track has played unless repeat-all is enabled", () => {
    const queue = new MemoryQueue({ random: () => 0 });
    queue.enqueue(track("local", "a", "A"));
    queue.enqueue(track("local", "b", "B"));
    queue.enqueue(track("local", "c", "C"));
    queue.startAt(0);
    queue.setShuffle(true);

    expect(queue.next()?.track.title).toBe("B");
    expect(queue.next()?.track.title).toBe("C");
    expect(queue.next()).toBeUndefined();

    queue.setRepeatAll(true);
    expect(queue.next()?.track.title).toBe("A");
  });

  test("keeps unavailable Tracks visible in snapshots", () => {
    const queue = new MemoryQueue();
    const missing = track("local", "/missing.flac", "Missing");
    queue.enqueue(missing);

    queue.markAvailability(missing.identity, { status: "unavailable", reason: "file no longer exists" });

    expect(queue.snapshot().entries).toEqual([
      {
        track: missing,
        availability: { status: "unavailable", reason: "file no longer exists" },
      },
    ]);
  });

  test("restores queue contents, current position, and modes from Last Queue Snapshot", () => {
    const snapshot: LastQueueSnapshot = {
      version: 1,
      entries: [
        {
          track: track("navidrome", "song-1", "Remote Song"),
          availability: { status: "unknown" },
        },
        {
          track: track("offline-youtube-cache", "youtube:abc", "Cached Song"),
          availability: { status: "available" },
        },
      ],
      currentIndex: 1,
      shuffle: true,
      repeatAll: true,
      volume: { percent: 73, ready: true },
    };

    const queue = new MemoryQueue();
    queue.restore(snapshot);

    expect(queue.snapshot()).toEqual({
      entries: snapshot.entries,
      currentIndex: 1,
      shuffle: true,
      repeatAll: true,
    });
    expect(queue.snapshot().entries[0]?.track).not.toHaveProperty("playbackLocator");
  });
});
