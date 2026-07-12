import { describe, expect, test } from "vitest";
import {
  MemoryQueue,
  type QueueState,
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
    const first = track("youtube-cache", "/music/amber.flac", "Amber");
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

  test("Play Next moves one identity-deduplicated Track block after Current Track", () => {
    const queue = new MemoryQueue();
    const a = track("youtube-cache", "a", "A");
    const b = track("youtube-cache", "b", "B");
    const c = track("youtube-cache", "c", "C");
    const d = track("youtube-cache", "d", "D");
    for (const value of [a, b, c, d]) queue.enqueue(value);
    queue.startAt(1);
    queue.markAvailability(d.identity, { status: "unavailable", reason: "offline" });

    queue.playNext([d, b, c, { ...d, title: "Duplicate D" }]);

    expect(queue.snapshot()).toMatchObject({
      entries: [
        { track: a, availability: { status: "unknown" } },
        { track: b, availability: { status: "unknown" } },
        { track: d, availability: { status: "unavailable", reason: "offline" } },
        { track: c, availability: { status: "unknown" } },
      ],
      currentIndex: 1,
    });
  });

  test("Play Next puts a Track block at Queue head when no Current Track exists", () => {
    const queue = new MemoryQueue();
    const a = track("youtube-cache", "a", "A");
    const b = track("youtube-cache", "b", "B");
    const c = track("youtube-cache", "c", "C");
    for (const value of [a, b]) queue.enqueue(value);

    queue.playNext([b, c]);

    expect(queue.snapshot().entries.map((entry) => entry.track.title)).toEqual(["B", "C", "A"]);
    expect(queue.currentIndex).toBe(-1);
  });

  test("Play Now keeps a different former Current Track immediately before its Track block", () => {
    const queue = new MemoryQueue();
    const a = track("youtube-cache", "a", "A");
    const b = track("youtube-cache", "b", "B");
    const c = track("youtube-cache", "c", "C");
    const d = track("youtube-cache", "d", "D");
    for (const value of [a, b, c, d]) queue.enqueue(value);
    queue.startAt(1);

    const current = queue.playNow([d, c, { ...d, title: "Duplicate D" }]);

    expect(current?.track).toEqual(d);
    expect(queue.snapshot().entries.map((entry) => entry.track.title)).toEqual(["A", "B", "D", "C"]);
    expect(queue.currentIndex).toBe(2);
    expect(queue.previous()?.track).toEqual(b);
  });

  test("Play Now puts a Track at Queue head without a former Current Track", () => {
    const queue = new MemoryQueue();
    const a = track("youtube-cache", "a", "A");
    const b = track("youtube-cache", "b", "B");
    const c = track("youtube-cache", "c", "C");
    for (const value of [a, b]) queue.enqueue(value);

    queue.playNow([b, c]);

    expect(queue.snapshot().entries.map((entry) => entry.track.title)).toEqual(["B", "C", "A"]);
    expect(queue.currentIndex).toBe(0);
  });

  test("Play Selected changes Current by index without changing exact Queue order", () => {
    const queue = new MemoryQueue();
    for (const value of [track("youtube-cache", "a", "A"), track("youtube-cache", "b", "B"), track("youtube-cache", "c", "C")]) {
      queue.enqueue(value);
    }
    const orderBefore = queue.snapshot().entries.map((entry) => entry.track.identity.stableId);

    expect(queue.startAt(1)?.track.title).toBe("B");

    expect(queue.snapshot().entries.map((entry) => entry.track.identity.stableId)).toEqual(orderBefore);
    expect(queue.currentIndex).toBe(1);
  });

  test("removes, moves, clears, and preserves the current Track selection", () => {
    const queue = new MemoryQueue();
    const amber = track("youtube-cache", "/music/amber.flac", "Amber");
    const cinder = track("youtube-cache", "song-1", "Cinder");
    const drift = track("youtube-cache", "drift", "Drift");
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

  test("removing the Current Track clears its designation without advancing", () => {
    const queue = new MemoryQueue();
    queue.enqueue(track("youtube-cache", "a", "A"));
    queue.enqueue(track("youtube-cache", "b", "B"));
    queue.enqueue(track("youtube-cache", "c", "C"));
    queue.startAt(1);

    expect(queue.remove(1)?.track.title).toBe("B");
    expect(queue.snapshot().entries.map((entry) => entry.track.title)).toEqual(["A", "C"]);
    expect(queue.snapshot().currentIndex).toBe(-1);
  });

  test("navigates next and previous with repeat-all wrapping", () => {
    const queue = new MemoryQueue();
    queue.enqueue(track("youtube-cache", "a", "A"));
    queue.enqueue(track("youtube-cache", "b", "B"));

    expect(queue.next()?.track.title).toBe("A");
    expect(queue.next()?.track.title).toBe("B");
    expect(queue.next()).toBeUndefined();
    expect(queue.snapshot().currentIndex).toBe(1);

    queue.setRepeatAll(true);
    expect(queue.next()?.track.title).toBe("A");
    expect(queue.previous()).toBeUndefined();
    expect(queue.snapshot().repeatAll).toBe(true);
  });

  test("shuffle visibly randomizes only Tracks after Current Track and keeps that order when disabled", () => {
    const queue = new MemoryQueue({ random: () => 0 });
    queue.enqueue(track("youtube-cache", "a", "A"));
    queue.enqueue(track("youtube-cache", "b", "B"));
    queue.enqueue(track("youtube-cache", "c", "C"));
    queue.enqueue(track("youtube-cache", "d", "D"));
    queue.startAt(0);

    queue.setShuffle(true);
    expect(queue.snapshot().entries.map((entry) => entry.track.title)).toEqual(["A", "C", "D", "B"]);
    expect(queue.next()?.track.title).toBe("C");
    queue.setShuffle(false);
    expect(queue.snapshot().entries.map((entry) => entry.track.title)).toEqual(["A", "C", "D", "B"]);
    expect(queue.next()?.track.title).toBe("D");
    expect(queue.snapshot().shuffle).toBe(false);
  });

  test("shuffle mode stops after every Track has played unless repeat-all is enabled", () => {
    const queue = new MemoryQueue({ random: () => 0 });
    queue.enqueue(track("youtube-cache", "a", "A"));
    queue.enqueue(track("youtube-cache", "b", "B"));
    queue.enqueue(track("youtube-cache", "c", "C"));
    queue.startAt(0);
    queue.setShuffle(true);

    expect(queue.snapshot().entries.map((entry) => entry.track.title)).toEqual(["A", "C", "B"]);
    expect(queue.next()?.track.title).toBe("C");
    expect(queue.next()?.track.title).toBe("B");
    expect(queue.next()).toBeUndefined();

    queue.setRepeatAll(true);
    expect(queue.next()?.track.title).toBe("A");
    expect(queue.snapshot().entries.map((entry) => entry.track.title)).toEqual(["A", "B", "C"]);
  });

  test("keeps unavailable Tracks visible in snapshots", () => {
    const queue = new MemoryQueue();
    const missing = track("youtube-cache", "/missing.flac", "Missing");
    queue.enqueue(missing);

    queue.markAvailability(missing.identity, { status: "unavailable", reason: "file no longer exists" });

    expect(queue.snapshot().entries).toEqual([
      {
        track: missing,
        availability: { status: "unavailable", reason: "file no longer exists" },
      },
    ]);
  });

  test("restores queue contents and modes from runtime queue state", () => {
    const snapshot: QueueState = {
      entries: [
        {
          track: track("youtube-cache", "song-1", "Cached Song One"),
          availability: { status: "unknown" },
        },
        {
          track: track("youtube-cache", "abc", "Cached Song Two"),
          availability: { status: "available" },
        },
      ],
      currentIndex: 1,
      shuffle: true,
      repeatAll: true,
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
