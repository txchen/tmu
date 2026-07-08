import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  NavidromeApiError,
  createDefaultTmuConfig,
  createNavidromeProvider,
  navidromeServerId,
  type NavidromeConfig,
  type NavidromeFetcher,
  type Track,
} from "../src/index";

function navidromeConfig(overrides: Partial<NavidromeConfig> = {}): NavidromeConfig {
  return createDefaultTmuConfig({
    providers: {
      navidrome: {
        enabled: true,
        serverUrl: "https://music.example.test",
        username: "alex",
        password: "secret-password",
        clientName: "tmu-test",
        ...overrides,
      },
    },
  }).providers.navidrome;
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function okPayload(extra: Record<string, unknown> = {}) {
  return {
    "subsonic-response": {
      status: "ok",
      version: "1.16.1",
      ...extra,
    },
  };
}

describe("Navidrome Provider", () => {
  test("sends Subsonic token and salt auth parameters with JSON format", async () => {
    const seenUrls: URL[] = [];
    const fetcher: NavidromeFetcher = async (url) => {
      seenUrls.push(new URL(url));
      return jsonResponse(okPayload());
    };
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher,
      saltFactory: () => "abc123",
    });

    await provider.validateConnection();

    const url = seenUrls[0];
    expect(url?.pathname).toBe("/rest/ping.view");
    expect(url?.searchParams.get("u")).toBe("alex");
    expect(url?.searchParams.get("s")).toBe("abc123");
    expect(url?.searchParams.get("t")).toBe(md5("secret-passwordabc123"));
    expect(url?.searchParams.get("v")).toBe("1.16.1");
    expect(url?.searchParams.get("c")).toBe("tmu-test");
    expect(url?.searchParams.get("f")).toBe("json");
  });

  test("validates the connection with ping success", async () => {
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async () => jsonResponse(okPayload()),
      saltFactory: () => "salt",
    });

    const state = await provider.validateConnection();

    expect(state).toEqual({
      status: "connected",
      serverUrl: "https://music.example.test",
      message: "ping succeeded",
    });
  });

  test("surfaces ping HTTP failures as API failure state", async () => {
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async () => jsonResponse({ error: "nope" }, { status: 503, statusText: "Service Unavailable" }),
      saltFactory: () => "salt",
    });

    const state = await provider.validateConnection();

    expect(state.status).toBe("api-failure");
    expect(state.message).toContain("HTTP 503 Service Unavailable from ping");
  });

  test("surfaces Subsonic auth failed payloads even when HTTP succeeds", async () => {
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async () => jsonResponse({
        "subsonic-response": {
          status: "failed",
          error: {
            code: 40,
            message: "Wrong username or password",
          },
        },
      }),
      saltFactory: () => "salt",
    });

    const state = await provider.validateConnection();

    expect(state.status).toBe("auth-failure");
    expect(state.message).toBe("Wrong username or password (code 40)");
  });

  test("rejects failed Subsonic payloads from successful HTTP responses as API errors", async () => {
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async () => jsonResponse({
        "subsonic-response": {
          status: "failed",
          error: {
            code: 70,
            message: "The requested data was not found",
          },
        },
      }),
      saltFactory: () => "salt",
    });

    await expect(provider.listArtists()).rejects.toMatchObject({
      name: "NavidromeApiError",
      kind: "api",
      code: 70,
      message: "The requested data was not found (code 70)",
    } satisfies Partial<NavidromeApiError>);
  });

  test("preserves Navidrome server IDs as strings while parsing library entries", async () => {
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async () => jsonResponse(okPayload({
        artists: {
          index: [
            {
              name: "A",
              artist: [
                { id: 101, name: "Alpha", albumCount: "2", coverArt: 202 },
                { id: "003", name: "Zero Padded", albumCount: 1, coverArt: "cover-003" },
              ],
            },
          ],
        },
      })),
      saltFactory: () => "salt",
    });

    const artists = await provider.listArtists();

    expect(artists).toEqual([
      { id: "101", name: "Alpha", albumCount: 2, coverArtId: "202" },
      { id: "003", name: "Zero Padded", albumCount: 1, coverArtId: "cover-003" },
    ]);
    expect(navidromeServerId(1234567890)).toBe("1234567890");
  });

  test("redacts secret fields from surfaced request failures", async () => {
    const provider = createNavidromeProvider({
      config: navidromeConfig({
        token: "secret-token",
        salt: "secret-salt",
      }),
      fetcher: async () => {
        throw new Error("leaked secret-password secret-token secret-salt");
      },
      saltFactory: () => "salt",
    });

    const state = await provider.validateConnection();

    expect(state.status).toBe("api-failure");
    expect(state.message).toContain("[redacted]");
    expect(state.message).not.toContain("secret-password");
    expect(state.message).not.toContain("secret-token");
    expect(state.message).not.toContain("secret-salt");
  });

  test("redacts generated auth token and salt from surfaced request failures", async () => {
    const generatedSalt = "generated-salt";
    const generatedToken = md5(`secret-password${generatedSalt}`);
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async (url) => {
        throw new Error(`failed URL ${url.toString()}`);
      },
      saltFactory: () => generatedSalt,
    });

    const state = await provider.validateConnection();

    expect(state.status).toBe("api-failure");
    expect(state.message).toContain("[redacted]");
    expect(state.message).not.toContain("secret-password");
    expect(state.message).not.toContain(generatedSalt);
    expect(state.message).not.toContain(generatedToken);
  });

  test("loads artists once per session and refreshes them only when explicit", async () => {
    const seenEndpoints: string[] = [];
    let artistCall = 0;
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async (url) => {
        seenEndpoints.push(endpointName(url));
        if (url.pathname.endsWith("/getArtists.view")) {
          artistCall += 1;
          return jsonResponse(okPayload({
            artists: {
              index: [{
                name: "A",
                artist: [{ id: `artist-${artistCall}`, name: `Artist ${artistCall}` }],
              }],
            },
          }));
        }
        return jsonResponse(okPayload());
      },
      saltFactory: () => "salt",
    });

    await provider.validateConnection();
    expect(await provider.listArtists()).toEqual([{ id: "artist-1", name: "Artist 1" }]);
    expect(await provider.listArtists()).toEqual([{ id: "artist-1", name: "Artist 1" }]);

    await provider.refreshArtists();

    expect(await provider.listArtists()).toEqual([{ id: "artist-2", name: "Artist 2" }]);
    expect(seenEndpoints).toEqual(["ping", "getArtists", "getArtists"]);
  });

  test("browses artist to paged album rows to paged Track rows while preserving IDs and coverArt", async () => {
    const seenRequests: Array<{ endpoint: string; params: Record<string, string> }> = [];
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async (url) => {
        seenRequests.push({
          endpoint: endpointName(url),
          params: Object.fromEntries(url.searchParams.entries()),
        });
        if (url.pathname.endsWith("/getArtists.view")) {
          return jsonResponse(okPayload({
            artists: {
              index: [{
                name: "A",
                artist: [{ id: 42, name: "Alpha", albumCount: "2", coverArt: "artist-cover" }],
              }],
            },
          }));
        }
        if (url.pathname.endsWith("/getArtist.view")) {
          expect(url.searchParams.get("id")).toBe("42");
          return jsonResponse(okPayload({
            artist: {
              id: 42,
              name: "Alpha",
              album: [
                { id: 9001, name: "First Album", artist: "Alpha", songCount: "2", coverArt: "album-cover-1" },
                { id: "9002", name: "Second Album", artist: "Alpha", songCount: 1, coverArt: 902 },
              ],
            },
          }));
        }
        if (url.pathname.endsWith("/getAlbum.view")) {
          expect(url.searchParams.get("id")).toBe("9001");
          return jsonResponse(okPayload({
            album: {
              id: 9001,
              name: "First Album",
              artist: "Alpha",
                  coverArt: "album-cover-should-not-replace-track-cover",
              song: [
                {
                  id: 7001,
                  title: "Opening",
                  artist: "Alpha",
                  album: "First Album",
                  duration: "125",
                  coverArt: "track-cover-1",
                },
                {
                  id: "7002",
                  title: "No Track Cover",
                  artist: "Alpha",
                  album: "First Album",
                  duration: 130,
                },
              ],
            },
          }));
        }
        return jsonResponse(okPayload());
      },
      saltFactory: () => "salt",
      pageSize: 1,
    });

    await provider.validateConnection();
    await provider.listArtists();

    expect(provider.getLibraryBrowserEntries()).toEqual([
      { kind: "artists-root", label: "Artists", depth: 0 },
      { kind: "artist", id: "42", label: "Alpha", albumCount: 2, coverArtId: "artist-cover", depth: 1 },
      { kind: "playlists-root", label: "Playlists", depth: 0 },
      { kind: "search-root", label: "Search", depth: 0 },
    ]);

    await provider.openLibraryBrowserEntry(provider.getLibraryBrowserEntries()[1]!);
    expect(provider.getLibraryBrowserEntries()).toEqual([
      { kind: "artists-root", label: "Artists", depth: 0 },
      { kind: "artist", id: "42", label: "Alpha", albumCount: 2, coverArtId: "artist-cover", depth: 1 },
      {
        kind: "album",
        id: "9001",
        artistId: "42",
        label: "First Album",
        artist: "Alpha",
        trackCount: 2,
        coverArtId: "album-cover-1",
        depth: 2,
      },
      { kind: "load-more-albums", artistId: "42", label: "Load more albums", depth: 2 },
      { kind: "playlists-root", label: "Playlists", depth: 0 },
      { kind: "search-root", label: "Search", depth: 0 },
    ]);

    await provider.openLibraryBrowserEntry(provider.getLibraryBrowserEntries()[3]!);
    expect(provider.getLibraryBrowserEntries().map((entry) => entry.kind)).toEqual([
      "artists-root",
      "artist",
      "album",
      "album",
      "playlists-root",
      "search-root",
    ]);

    await provider.openLibraryBrowserEntry(provider.getLibraryBrowserEntries()[2]!);
    expect(provider.getLibraryBrowserEntries().map((entry) => entry.kind)).toEqual([
      "artists-root",
      "artist",
      "album",
      "track",
      "load-more-tracks",
      "album",
      "playlists-root",
      "search-root",
    ]);

    await provider.openLibraryBrowserEntry(provider.getLibraryBrowserEntries()[4]!);
    const entries = provider.getLibraryBrowserEntries();
    const trackEntries = entries.filter((entry) => entry.kind === "track");
    expect(trackEntries).toHaveLength(2);
    expect(trackEntries[0]).toMatchObject({
      kind: "track",
      id: "7001",
      albumId: "9001",
      artistId: "42",
      label: "Opening",
      depth: 3,
    });
    const opening = provider.trackForLibraryBrowserEntry(trackEntries[0]!);
    const noTrackCover = provider.trackForLibraryBrowserEntry(trackEntries[1]!);

    expect(opening).toEqual({
      identity: {
        providerId: "navidrome",
        stableId: "Navidrome:https://music.example.test:track:7001",
      },
      title: "Opening",
      providerLabel: "Navidrome",
      artist: "Alpha",
      album: "First Album",
      durationSeconds: 125,
      coverArtId: "track-cover-1",
    } satisfies Track);
    expect(noTrackCover?.coverArtId).toBeUndefined();
    expect(noTrackCover?.identity.stableId).toBe("Navidrome:https://music.example.test:track:7002");
    expect(opening).not.toHaveProperty("playbackLocator");
    expect(opening?.identity.stableId).not.toContain("stream.view");
    expect(opening?.identity.stableId).not.toContain("secret-password");
    expect(seenRequests.map((request) => request.endpoint)).toEqual([
      "ping",
      "getArtists",
      "getArtist",
      "getAlbum",
    ]);
  });

  test("browses read-only playlists without unsupported username filtering and exposes playlist Tracks", async () => {
    const seenRequests: Array<{ endpoint: string; params: Record<string, string> }> = [];
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async (url) => {
        seenRequests.push({
          endpoint: endpointName(url),
          params: Object.fromEntries(url.searchParams.entries()),
        });
        if (url.pathname.endsWith("/getPlaylists.view")) {
          return jsonResponse(okPayload({
            playlists: {
              playlist: [
                { id: 10, name: "Favorites", songCount: "2", duration: "300", coverArt: "playlist-cover" },
              ],
            },
          }));
        }
        if (url.pathname.endsWith("/getPlaylist.view")) {
          expect(url.searchParams.get("id")).toBe("10");
          return jsonResponse(okPayload({
            playlist: {
              id: 10,
              name: "Favorites",
              entry: [
                {
                  id: "track-10",
                  title: "Favorite Track",
                  artist: "Alex",
                  album: "Chosen",
                  duration: "180",
                  coverArt: "track-cover",
                },
              ],
            },
          }));
        }
        return jsonResponse(okPayload());
      },
      saltFactory: () => "salt",
    });

    await provider.validateConnection();
    const playlistsRoot = provider.getLibraryBrowserEntries().find((entry) => entry.kind === "playlists-root");
    expect(playlistsRoot).toEqual({ kind: "playlists-root", label: "Playlists", depth: 0 });

    await provider.openLibraryBrowserEntry(playlistsRoot!);
    const playlistEntry = provider.getLibraryBrowserEntries().find((entry) => entry.kind === "playlist");
    expect(playlistEntry).toEqual({
      kind: "playlist",
      id: "10",
      label: "Favorites",
      trackCount: 2,
      durationSeconds: 300,
      coverArtId: "playlist-cover",
      depth: 1,
    });
    expect(seenRequests.find((request) => request.endpoint === "getPlaylists")?.params).not.toHaveProperty("username");

    await provider.openLibraryBrowserEntry(playlistEntry!);
    const trackEntry = provider.getLibraryBrowserEntries().find((entry) => entry.kind === "playlist-track");
    const track = trackEntry ? provider.trackForLibraryBrowserEntry(trackEntry) : undefined;

    expect(trackEntry).toMatchObject({
      kind: "playlist-track",
      id: "track-10",
      playlistId: "10",
      label: "Favorite Track",
      depth: 2,
    });
    expect(track).toEqual({
      identity: {
        providerId: "navidrome",
        stableId: "Navidrome:https://music.example.test:track:track-10",
      },
      title: "Favorite Track",
      providerLabel: "Navidrome",
      artist: "Alex",
      album: "Chosen",
      durationSeconds: 180,
      coverArtId: "track-cover",
    } satisfies Track);
    expect(seenRequests.map((request) => request.endpoint)).toEqual([
      "ping",
      "getPlaylists",
      "getPlaylist",
    ]);
  });

  test("searches Tracks with lazy result pagination around the configured page size", async () => {
    const seenRequests: Array<{ endpoint: string; params: Record<string, string> }> = [];
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async (url) => {
        seenRequests.push({
          endpoint: endpointName(url),
          params: Object.fromEntries(url.searchParams.entries()),
        });
        if (url.pathname.endsWith("/search3.view")) {
          const offset = url.searchParams.get("songOffset");
          return jsonResponse(okPayload({
            searchResult3: {
              song: offset === "0"
                ? [
                  { id: "s-1", title: "Moon One", artist: "Luna" },
                  { id: "s-2", title: "Moon Two", artist: "Luna" },
                ]
                : [
                  { id: "s-3", title: "Moon Three", artist: "Luna" },
                ],
            },
          }));
        }
        return jsonResponse(okPayload());
      },
      saltFactory: () => "salt",
      pageSize: 2,
    });

    await provider.validateConnection();
    expect(await provider.searchTracks("moon")).toHaveLength(2);
    let entries = provider.getLibraryBrowserEntries();
    expect(entries.filter((entry) => entry.kind === "search-result")).toHaveLength(2);
    expect(entries.at(-1)).toEqual({ kind: "load-more-search-results", label: "Load more search results", depth: 1 });

    await provider.openLibraryBrowserEntry(entries.at(-1)!);
    entries = provider.getLibraryBrowserEntries();

    expect(entries.filter((entry) => entry.kind === "search-result")).toHaveLength(3);
    expect(entries.some((entry) => entry.kind === "load-more-search-results")).toBe(false);
    expect(provider.trackForLibraryBrowserEntry(entries.find((entry) => entry.kind === "search-result")!)).toMatchObject({
      identity: { providerId: "navidrome", stableId: "Navidrome:https://music.example.test:track:s-1" },
      title: "Moon One",
    });
    expect(seenRequests).toEqual([
      expect.objectContaining({ endpoint: "ping" }),
      expect.objectContaining({
        endpoint: "search3",
        params: expect.objectContaining({
          query: "moon",
          songCount: "2",
          songOffset: "0",
        }),
      }),
      expect.objectContaining({
        endpoint: "search3",
        params: expect.objectContaining({
          query: "moon",
          songCount: "2",
          songOffset: "2",
        }),
      }),
    ]);
  });

  test("generates authenticated stream URLs only while resolving playback locators", async () => {
    const seenUrls: URL[] = [];
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async (url) => {
        seenUrls.push(new URL(url));
        return jsonResponse(okPayload());
      },
      saltFactory: () => "stream-salt",
    });
    const trackIdentity = {
      providerId: "navidrome",
      stableId: "Navidrome:https://music.example.test:track:track-123",
    };

    const locator = await provider.resolvePlaybackLocator(trackIdentity);

    expect(locator.kind).toBe("url");
    if (locator.kind !== "url") throw new Error("expected Navidrome stream URL locator");
    const streamUrl = new URL(locator.url);
    expect(streamUrl.pathname).toBe("/rest/stream.view");
    expect(streamUrl.searchParams.get("id")).toBe("track-123");
    expect(streamUrl.searchParams.get("u")).toBe("alex");
    expect(streamUrl.searchParams.get("s")).toBe("stream-salt");
    expect(streamUrl.searchParams.get("t")).toBe(md5("secret-passwordstream-salt"));
    expect(trackIdentity.stableId).not.toContain("stream.view");
    expect(trackIdentity.stableId).not.toContain(streamUrl.searchParams.get("t") ?? "");
    expect(seenUrls).toEqual([]);
  });

  test("reports now-playing and completed-play scrobbles through best-effort scrobble calls", async () => {
    const seenRequests: Array<{ endpoint: string; params: Record<string, string> }> = [];
    const provider = createNavidromeProvider({
      config: navidromeConfig(),
      fetcher: async (url) => {
        seenRequests.push({
          endpoint: endpointName(url),
          params: Object.fromEntries(url.searchParams.entries()),
        });
        return jsonResponse(okPayload());
      },
      saltFactory: () => "salt",
    });
    const identity = {
      providerId: "navidrome",
      stableId: "Navidrome:https://music.example.test:track:track-123",
    };

    await provider.reportNowPlaying(identity);
    await provider.reportCompletedPlay(identity);

    expect(seenRequests.map((request) => request.endpoint)).toEqual(["scrobble", "scrobble"]);
    expect(seenRequests[0]?.params).toMatchObject({ id: "track-123", submission: "false" });
    expect(seenRequests[1]?.params).toMatchObject({ id: "track-123", submission: "true" });
    expect(seenRequests[1]?.params.time).toMatch(/^\d+$/);
  });
});

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function endpointName(url: URL): string {
  return url.pathname.split("/").at(-1)?.replace(/\.view$/, "") ?? "";
}
