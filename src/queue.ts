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
  private readonly shuffledHistory: string[] = [];
  private readonly shuffledSeen = new Set<string>();

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
    this.removeIdentityFromShuffleState(removed.track.identity);

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
    this.shuffledHistory.splice(0, this.shuffledHistory.length);
    this.shuffledSeen.clear();
  }

  startAt(index: number): QueueEntry | undefined {
    const entry = this.items[index];
    if (!entry) return undefined;
    this.activeIndex = index;
    if (this.shuffleEnabled) {
      this.shuffledSeen.clear();
      this.shuffledSeen.add(identityKey(entry.track.identity));
      this.shuffledHistory.splice(0, this.shuffledHistory.length);
    }
    return entry;
  }

  next(): QueueEntry | undefined {
    if (this.items.length === 0) return undefined;

    if (this.shuffleEnabled) {
      return this.nextShuffled();
    }

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

    if (this.shuffleEnabled && this.shuffledHistory.length > 0) {
      const previousKey = this.shuffledHistory.pop();
      const previousIndex = this.items.findIndex((entry) => identityKey(entry.track.identity) === previousKey);
      if (previousIndex === -1) return undefined;
      this.activeIndex = previousIndex;
      return this.items[this.activeIndex];
    }

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
    this.shuffleEnabled = enabled;
    if (!enabled) this.shuffledHistory.splice(0, this.shuffledHistory.length);
    if (!enabled) this.shuffledSeen.clear();
    if (enabled && this.activeIndex >= 0) {
      this.shuffledSeen.add(identityKey(this.items[this.activeIndex]!.track.identity));
    }
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
    this.shuffledHistory.splice(0, this.shuffledHistory.length);
    this.shuffledSeen.clear();
    if (this.shuffleEnabled && this.activeIndex >= 0) {
      this.shuffledSeen.add(identityKey(this.items[this.activeIndex]!.track.identity));
    }
  }

  private nextShuffled(): QueueEntry | undefined {
    if (this.items.length === 1) {
      if (this.activeIndex < 0) {
        this.activeIndex = 0;
        return this.items[this.activeIndex];
      }
      if (!this.repeatAllEnabled && this.activeIndex === 0) return undefined;
      return this.items[this.activeIndex];
    }

    const candidates = this.shuffledCandidateIndexes();
    if (candidates.length === 0) {
      if (!this.repeatAllEnabled) return undefined;
      this.shuffledSeen.clear();
      if (this.activeIndex >= 0) this.shuffledSeen.add(identityKey(this.items[this.activeIndex]!.track.identity));
      const repeatedCandidates = this.shuffledCandidateIndexes();
      if (repeatedCandidates.length === 0) return this.items[this.activeIndex];
      return this.startShuffledCandidate(repeatedCandidates);
    }

    return this.startShuffledCandidate(candidates);
  }

  private startShuffledCandidate(candidates: number[]): QueueEntry | undefined {
    if (this.activeIndex >= 0) {
      this.shuffledHistory.push(identityKey(this.items[this.activeIndex]!.track.identity));
    }
    const candidateIndex = candidates[Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length))];
    if (candidateIndex === undefined) return undefined;
    this.activeIndex = candidateIndex;
    this.shuffledSeen.add(identityKey(this.items[this.activeIndex]!.track.identity));
    return this.items[this.activeIndex];
  }

  private shuffledCandidateIndexes(): number[] {
    return this.items
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry, index }) =>
        index !== this.activeIndex && !this.shuffledSeen.has(identityKey(entry.track.identity)),
      )
      .map(({ index }) => index);
  }

  private removeIdentityFromShuffleState(identity: TrackIdentity): void {
    const removedKey = identityKey(identity);
    this.shuffledSeen.delete(removedKey);
    for (let index = this.shuffledHistory.length - 1; index >= 0; index -= 1) {
      const value = this.shuffledHistory[index];
      if (value === removedKey) {
        this.shuffledHistory.splice(index, 1);
      }
    }
  }
}
