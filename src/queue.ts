import {
  clampIndex,
  identityKey,
  sameIdentity,
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
  private shuffleEnabled = false;
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

  remove(index: number): QueueEntry | undefined {
    if (index < 0 || index >= this.items.length) return undefined;

    const [removed] = this.items.splice(index, 1);

    if (this.items.length === 0) {
      this.activeIndex = -1;
    } else if (this.activeIndex === index) {
      this.activeIndex = Math.min(index, this.items.length - 1);
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

    if (this.shuffleEnabled && this.activeIndex >= 0) {
      const current = this.items.splice(this.activeIndex, 1)[0];
      if (!current) return undefined;
      this.items.unshift(current);
      this.activeIndex = 0;
      this.shuffleAfterCurrent();
      if (this.items.length === 1) return current;
      this.activeIndex = 1;
      return this.items[this.activeIndex];
    }

    this.activeIndex = 0;
    return this.items[this.activeIndex];
  }

  previous(): QueueEntry | undefined {
    if (this.items.length === 0) return undefined;

    if (this.activeIndex > 0) {
      this.activeIndex -= 1;
      return this.items[this.activeIndex];
    }

    if (this.activeIndex === 0 && this.repeatAllEnabled) {
      this.activeIndex = this.items.length - 1;
      return this.items[this.activeIndex];
    }

    return undefined;
  }

  setShuffle(enabled: boolean): void {
    if (enabled === this.shuffleEnabled) return;
    this.shuffleEnabled = enabled;
    if (enabled) this.shuffleAfterCurrent();
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
      shuffle: this.shuffleEnabled,
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
    this.shuffleEnabled = snapshot.shuffle;
    this.repeatAllEnabled = snapshot.repeatAll;
  }

  private shuffleAfterCurrent(): void {
    const start = Math.max(0, this.activeIndex + 1);
    for (let index = this.items.length - 1; index > start; index -= 1) {
      const candidate = start + Math.floor(this.random() * (index - start + 1));
      const value = this.items[index];
      this.items[index] = this.items[candidate]!;
      this.items[candidate] = value!;
    }
  }
}
