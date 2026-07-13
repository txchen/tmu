import { describe, expect, test } from "vitest";
import {
  MemoryPlaylistContent,
  type PlaylistContentState,
  type Track,
} from "../src/index";

function track(providerId: string, stableId: string, title: string): Track {
  return {
    identity: { providerId, stableId },
    title,
    providerLabel: providerId,
  };
}

describe("MemoryPlaylistContent", () => {
  test("dedupes canonical Tracks by durable Track Identity", () => {
    const playlist = new MemoryPlaylistContent();
    const first = track("youtube-cache", "/music/amber.flac", "Amber");
    const duplicateWithFreshMetadata = {
      ...first,
      title: "Amber remastered",
      album: "Later Metadata",
    };

    const entry = playlist.add(first);
    const duplicate = playlist.add(duplicateWithFreshMetadata);

    expect(duplicate).toBe(entry);
    expect(playlist.snapshot().entries).toHaveLength(1);
    expect(playlist.snapshot().entries[0]?.track).toEqual(first);
  });

  test("Play Next moves one identity-deduplicated Track block after Current Track", () => {
    const playlist = new MemoryPlaylistContent();
    const a = track("youtube-cache", "a", "A");
    const b = track("youtube-cache", "b", "B");
    const c = track("youtube-cache", "c", "C");
    const d = track("youtube-cache", "d", "D");
    for (const value of [a, b, c, d]) playlist.add(value);
    playlist.startAt(1);
    playlist.markAvailability(d.identity, { status: "unavailable", reason: "offline" });

    playlist.playNext([d, b, c, { ...d, title: "Duplicate D" }]);

    expect(playlist.snapshot()).toMatchObject({
      entries: [
        { track: a, availability: { status: "unknown" } },
        { track: b, availability: { status: "unknown" } },
        { track: d, availability: { status: "unavailable", reason: "offline" } },
        { track: c, availability: { status: "unknown" } },
      ],
      currentIndex: 1,
    });
  });

  test("Play Next puts a Track block at Playlist head when no Current Track exists", () => {
    const playlist = new MemoryPlaylistContent();
    const a = track("youtube-cache", "a", "A");
    const b = track("youtube-cache", "b", "B");
    const c = track("youtube-cache", "c", "C");
    for (const value of [a, b]) playlist.add(value);

    playlist.playNext([b, c]);

    expect(playlist.snapshot().entries.map((entry) => entry.track.title)).toEqual(["B", "C", "A"]);
    expect(playlist.currentIndex).toBe(-1);
  });

  test("Play Now keeps a different former Current Track immediately before its Track block", () => {
    const playlist = new MemoryPlaylistContent();
    const a = track("youtube-cache", "a", "A");
    const b = track("youtube-cache", "b", "B");
    const c = track("youtube-cache", "c", "C");
    const d = track("youtube-cache", "d", "D");
    for (const value of [a, b, c, d]) playlist.add(value);
    playlist.startAt(1);

    const current = playlist.playNow([d, c, { ...d, title: "Duplicate D" }]);

    expect(current?.track).toEqual(d);
    expect(playlist.snapshot().entries.map((entry) => entry.track.title)).toEqual(["A", "B", "D", "C"]);
    expect(playlist.currentIndex).toBe(2);
    expect(playlist.previous()?.track).toEqual(b);
  });

  test("Play Now puts a Track at Playlist head without a former Current Track", () => {
    const playlist = new MemoryPlaylistContent();
    const a = track("youtube-cache", "a", "A");
    const b = track("youtube-cache", "b", "B");
    const c = track("youtube-cache", "c", "C");
    for (const value of [a, b]) playlist.add(value);

    playlist.playNow([b, c]);

    expect(playlist.snapshot().entries.map((entry) => entry.track.title)).toEqual(["B", "C", "A"]);
    expect(playlist.currentIndex).toBe(0);
  });

  test("Play Selected changes Current by index without changing exact Playlist order", () => {
    const playlist = new MemoryPlaylistContent();
    for (const value of [track("youtube-cache", "a", "A"), track("youtube-cache", "b", "B"), track("youtube-cache", "c", "C")]) {
      playlist.add(value);
    }
    const orderBefore = playlist.snapshot().entries.map((entry) => entry.track.identity.stableId);

    expect(playlist.startAt(1)?.track.title).toBe("B");

    expect(playlist.snapshot().entries.map((entry) => entry.track.identity.stableId)).toEqual(orderBefore);
    expect(playlist.currentIndex).toBe(1);
  });

  test("removes, moves, clears, and preserves the current Track selection", () => {
    const playlist = new MemoryPlaylistContent();
    const amber = track("youtube-cache", "/music/amber.flac", "Amber");
    const cinder = track("youtube-cache", "song-1", "Cinder");
    const drift = track("youtube-cache", "drift", "Drift");
    playlist.add(amber);
    playlist.add(cinder);
    playlist.add(drift);

    expect(playlist.startAt(1)?.track.title).toBe("Cinder");
    playlist.move(1, 0);
    expect(playlist.snapshot().entries.map((entry) => entry.track.title)).toEqual(["Cinder", "Amber", "Drift"]);
    expect(playlist.snapshot().currentIndex).toBe(0);

    playlist.remove(1);
    expect(playlist.snapshot().entries.map((entry) => entry.track.title)).toEqual(["Cinder", "Drift"]);
    expect(playlist.snapshot().currentIndex).toBe(0);

    playlist.setRepeatAll(true);
    playlist.clear();
    expect(playlist.snapshot().entries).toEqual([]);
    expect(playlist.snapshot().currentIndex).toBe(-1);
    expect(playlist.snapshot().repeatAll).toBe(true);
  });

  test("removing the Current Track clears its designation without advancing", () => {
    const playlist = new MemoryPlaylistContent();
    playlist.add(track("youtube-cache", "a", "A"));
    playlist.add(track("youtube-cache", "b", "B"));
    playlist.add(track("youtube-cache", "c", "C"));
    playlist.startAt(1);

    expect(playlist.remove(1)?.track.title).toBe("B");
    expect(playlist.snapshot().entries.map((entry) => entry.track.title)).toEqual(["A", "C"]);
    expect(playlist.snapshot().currentIndex).toBe(-1);
  });

  test("navigates next and previous with repeat-all wrapping", () => {
    const playlist = new MemoryPlaylistContent();
    playlist.add(track("youtube-cache", "a", "A"));
    playlist.add(track("youtube-cache", "b", "B"));

    expect(playlist.next()?.track.title).toBe("A");
    expect(playlist.next()?.track.title).toBe("B");
    expect(playlist.next()).toBeUndefined();
    expect(playlist.snapshot().currentIndex).toBe(1);

    playlist.setRepeatAll(true);
    expect(playlist.next()?.track.title).toBe("A");
    expect(playlist.previous()).toBeUndefined();
    expect(playlist.snapshot().repeatAll).toBe(true);
  });

  test("Randomize Playlist reorders every Track and moves Current Track with its identity", () => {
    const playlist = new MemoryPlaylistContent({ random: () => 0 });
    playlist.add(track("youtube-cache", "a", "A"));
    playlist.add(track("youtube-cache", "b", "B"));
    playlist.add(track("youtube-cache", "c", "C"));
    playlist.add(track("youtube-cache", "d", "D"));
    playlist.startAt(0);

    playlist.randomize();
    expect(playlist.snapshot().entries.map((entry) => entry.track.title)).toEqual(["B", "C", "D", "A"]);
    expect(playlist.currentIndex).toBe(3);
    playlist.randomize();
    expect(playlist.snapshot().entries.map((entry) => entry.track.title)).toEqual(["C", "D", "A", "B"]);
    expect(playlist.currentIndex).toBe(2);
  });

  test("keeps unavailable Tracks visible in snapshots", () => {
    const playlist = new MemoryPlaylistContent();
    const missing = track("youtube-cache", "/missing.flac", "Missing");
    playlist.add(missing);

    playlist.markAvailability(missing.identity, { status: "unavailable", reason: "file no longer exists" });

    expect(playlist.snapshot().entries).toEqual([
      {
        track: missing,
        availability: { status: "unavailable", reason: "file no longer exists" },
      },
    ]);
  });

  test("restores playlist contents and modes from runtime playlist state", () => {
    const snapshot: PlaylistContentState = {
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
      repeatAll: true,
    };

    const playlist = new MemoryPlaylistContent();
    playlist.restore(snapshot);

    expect(playlist.snapshot()).toEqual({
      entries: snapshot.entries,
      currentIndex: 1,
      repeatAll: true,
    });
    expect(playlist.snapshot().entries[0]?.track).not.toHaveProperty("playbackLocator");
  });
});
