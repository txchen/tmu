import {
  clampIndex,
  identityKey,
  sameIdentity,
  uniqueTracksByIdentity,
  type Queue,
  type QueueEntry,
  type QueueState,
  type Track,
  type TrackAvailability,
  type TrackIdentity,
} from "./domain";

export type MemoryQueueOptions = {
  random?: () => number;
};

export class MemoryQueue implements Queue {
  private readonly items: QueueEntry[] = [];
  private activeIndex = -1;
  private repeatAllEnabled = false;
  private readonly random: () => number;

  constructor(options: MemoryQueueOptions = {}) {
    this.random = options.random ?? Math.random;
  }

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

  playNext(tracks: readonly Track[]): readonly QueueEntry[] {
    const current = this.items[this.activeIndex];
    const requested = uniqueTracksByIdentity(tracks).filter((track) =>
      !sameIdentity(track.identity, current?.track.identity),
    );
    const { block, remaining } = this.extractBlock(requested);
    const currentIndex = current
      ? remaining.findIndex((entry) => sameIdentity(entry.track.identity, current.track.identity))
      : -1;
    remaining.splice(currentIndex + 1, 0, ...block);
    this.items.splice(0, this.items.length, ...remaining);
    this.activeIndex = current
      ? this.items.findIndex((entry) => sameIdentity(entry.track.identity, current.track.identity))
      : -1;
    return block;
  }

  playNow(tracks: readonly Track[]): QueueEntry | undefined {
    const requested = uniqueTracksByIdentity(tracks);
    const first = requested[0];
    if (!first) return undefined;

    const formerCurrent = this.items[this.activeIndex];
    const differentFormerCurrent = formerCurrent
      && !sameIdentity(formerCurrent.track.identity, first.identity)
      ? formerCurrent
      : undefined;
    const blockTracks = differentFormerCurrent
      ? requested.filter((track) => !sameIdentity(track.identity, differentFormerCurrent.track.identity))
      : requested;
    const { block, remaining, removedKeys } = this.extractBlock(
      blockTracks,
      differentFormerCurrent ? [differentFormerCurrent] : [],
    );
    const oldAnchor = formerCurrent ? this.items.indexOf(formerCurrent) : 0;
    const insertionIndex = formerCurrent
      ? this.items.slice(0, oldAnchor).filter((entry) =>
        !removedKeys.has(identityKey(entry.track.identity)),
      ).length
      : 0;
    remaining.splice(
      insertionIndex,
      0,
      ...(differentFormerCurrent ? [differentFormerCurrent] : []),
      ...block,
    );
    this.items.splice(0, this.items.length, ...remaining);
    this.activeIndex = this.items.findIndex((entry) => sameIdentity(entry.track.identity, first.identity));
    return this.items[this.activeIndex];
  }

  remove(index: number): QueueEntry | undefined {
    if (index < 0 || index >= this.items.length) return undefined;

    const [removed] = this.items.splice(index, 1);

    if (this.activeIndex === index) {
      this.activeIndex = -1;
    } else if (this.activeIndex > index) {
      this.activeIndex -= 1;
    }

    return removed;
  }

  move(fromIndex: number, toIndex: number): QueueEntry | undefined {
    if (fromIndex < 0 || fromIndex >= this.items.length) return undefined;
    if (this.items.length === 0) return undefined;

    const active = this.items[this.activeIndex];
    const [entry] = this.items.splice(fromIndex, 1);
    const destination = clampIndex(toIndex, this.items.length + 1);
    this.items.splice(destination, 0, entry);

    if (active) {
      this.activeIndex = this.items.findIndex((candidate) =>
        sameIdentity(candidate.track.identity, active.track.identity),
      );
    }

    return entry;
  }

  clear(): void {
    this.items.splice(0, this.items.length);
    this.activeIndex = -1;
  }

  startAt(index: number): QueueEntry | undefined {
    const entry = this.items[index];
    if (!entry) return undefined;
    this.activeIndex = index;
    return entry;
  }

  next(): QueueEntry | undefined {
    if (this.items.length === 0) return undefined;

    const nextIndex = this.activeIndex < 0
      ? 0
      : this.activeIndex + 1;

    if (nextIndex < this.items.length) {
      this.activeIndex = nextIndex;
      return this.items[this.activeIndex];
    }

    if (!this.repeatAllEnabled) return undefined;

    this.activeIndex = 0;
    return this.items[this.activeIndex];
  }

  previous(): QueueEntry | undefined {
    if (this.items.length === 0) return undefined;

    if (this.activeIndex > 0) {
      this.activeIndex -= 1;
      return this.items[this.activeIndex];
    }

    return undefined;
  }

  randomize(): void {
    const current = this.items[this.activeIndex];
    for (let index = this.items.length - 1; index > 0; index -= 1) {
      const candidate = Math.floor(this.random() * (index + 1));
      const value = this.items[index];
      this.items[index] = this.items[candidate]!;
      this.items[candidate] = value!;
    }
    this.activeIndex = current ? this.items.indexOf(current) : -1;
  }

  setRepeatAll(enabled: boolean): void {
    this.repeatAllEnabled = enabled;
  }

  markAvailability(identity: TrackIdentity, availability: TrackAvailability): void {
    const entry = this.items.find((candidate) => sameIdentity(candidate.track.identity, identity));
    if (entry) entry.availability = availability;
  }

  updateTrack(track: Track): QueueEntry | undefined {
    const entry = this.items.find((candidate) => sameIdentity(candidate.track.identity, track.identity));
    if (!entry) return undefined;

    entry.track = track;
    return entry;
  }

  snapshot(): QueueState {
    return {
      entries: this.items.map((entry) => ({
        track: entry.track,
        availability: entry.availability,
      })),
      currentIndex: this.activeIndex,
      repeatAll: this.repeatAllEnabled,
    };
  }

  restore(snapshot: QueueState): void {
    this.items.splice(0, this.items.length, ...snapshot.entries.map((entry) => ({
      track: entry.track,
      availability: entry.availability,
    })));
    this.activeIndex = snapshot.currentIndex >= 0 && snapshot.currentIndex < this.items.length
      ? snapshot.currentIndex
      : -1;
    this.repeatAllEnabled = snapshot.repeatAll;
  }

  private extractBlock(
    tracks: readonly Track[],
    additionallyRemoved: readonly QueueEntry[] = [],
  ): { block: QueueEntry[]; remaining: QueueEntry[]; removedKeys: Set<string> } {
    const removedKeys = new Set(tracks.map((track) => identityKey(track.identity)));
    for (const entry of additionallyRemoved) removedKeys.add(identityKey(entry.track.identity));
    const existing = new Map(this.items.map((entry) => [identityKey(entry.track.identity), entry]));
    return {
      block: tracks.map((track) => existing.get(identityKey(track.identity)) ?? newQueueEntry(track)),
      remaining: this.items.filter((entry) => !removedKeys.has(identityKey(entry.track.identity))),
      removedKeys,
    };
  }
}

function newQueueEntry(track: Track): QueueEntry {
  return { track, availability: { status: "unknown" } };
}
