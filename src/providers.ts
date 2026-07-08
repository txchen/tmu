import { resolve } from "node:path";
import type { PlaybackLocator, Provider, NavigationTargetId, Track, TrackIdentity } from "./domain";

function skeletonTrack(providerId: NavigationTargetId, stableId: string, title: string, providerLabel: string): Track {
  return {
    identity: { providerId, stableId },
    title,
    providerLabel,
  };
}

class SkeletonProvider implements Provider {
  constructor(
    readonly id: string,
    readonly label: string,
    readonly hint: string,
    private readonly tracks: readonly Track[],
  ) {}

  listVisibleTracks(): readonly Track[] {
    return this.tracks;
  }

  async resolvePlaybackLocator(identity: TrackIdentity): Promise<PlaybackLocator> {
    return { kind: "file", path: `skeleton://${identity.providerId}/${identity.stableId}` };
  }
}

export function createSkeletonProviders(): Record<string, Provider> {
  return {
    local: new SkeletonProvider("local", "Local", "files and folders", [
      skeletonTrack("local", "/music/amber.flac", "Amber Path", "Local"),
      skeletonTrack("local", "/music/cinder.mp3", "Cinder Room", "Local"),
    ]),
    navidrome: new SkeletonProvider("navidrome", "Navidrome", "artists, albums, playlists", [
      skeletonTrack("navidrome", "song-101", "Northbound", "Navidrome"),
      skeletonTrack("navidrome", "song-102", "Station Light", "Navidrome"),
    ]),
    "offline-youtube-cache": new SkeletonProvider(
      "offline-youtube-cache",
      "Offline YouTube Cache",
      "downloaded YouTube audio",
      [
        skeletonTrack("offline-youtube-cache", "youtube:late-upload", "Late Upload", "Offline YouTube Cache"),
        skeletonTrack("offline-youtube-cache", "youtube:offline-copy", "Offline Copy", "Offline YouTube Cache"),
      ],
    ),
    "youtube-url-download": new SkeletonProvider(
      "youtube-url-download",
      "YouTube URL Download",
      "download then enqueue",
      [],
    ),
  };
}

export function createLocalTrackFromCliArg(path: string): Track {
  const normalizedPath = path.trim();
  const pieces = normalizedPath.split(/[\\/]/).filter(Boolean);
  const title = pieces.at(-1) || normalizedPath || "local file";
  const canonicalPath = resolve(normalizedPath);

  return {
    identity: {
      providerId: "local",
      stableId: canonicalPath,
    },
    title,
    providerLabel: "Local",
  };
}
