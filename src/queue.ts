import {
  identityKey,
  sameIdentity,
  type Queue,
  type QueueEntry,
  type QueueState,
  type Track,
  type TrackAvailability,
  type TrackIdentity,
} from "./domain";

export class MemoryQueue implements Queue {
  private readonly items: QueueEntry[] = [];
  private activeIndex = -1;

  get entries(): readonly QueueEntry[] {
    return this.items;
  }

  get currentIndex(): number {
    return this.activeIndex;
  }

  enqueue(track: Track): QueueEntry {
    const existing = this.items.find((entry) => identityKey(entry.track.identity) === identityKey(track.identity));
    if (existing) return existing;

    const entry: QueueEntry = {
      track,
      availability: { status: "unknown" },
    };
    this.items.push(entry);
    return entry;
  }

  startAt(index: number): QueueEntry | undefined {
    const entry = this.items[index];
    if (!entry) return undefined;
    this.activeIndex = index;
    return entry;
  }

  markAvailability(identity: TrackIdentity, availability: TrackAvailability): void {
    const entry = this.items.find((candidate) => sameIdentity(candidate.track.identity, identity));
    if (entry) entry.availability = availability;
  }

  snapshot(): QueueState {
    return {
      entries: this.items.map((entry) => ({
        track: entry.track,
        availability: entry.availability,
      })),
      currentIndex: this.activeIndex,
    };
  }
}
