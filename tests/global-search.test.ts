import { describe, expect, test } from "bun:test";
import {
  globalSearchRows,
  type GlobalSearchState,
  type Provider,
  type ProviderSearchRequest,
  type ProviderSearchResult,
} from "../src/index";
import { AppCoordinator } from "../src/coordinator";
import { NoopPlayer } from "../src/player";
import { MemoryQueue } from "../src/queue";
import { createInitialAppState, createInitialUiState } from "../src/state";
import { actionForBinding, createActionRegistry } from "../src/action-registry";
import { RootInputRouter } from "../src/input-router";
import { UiStateStore } from "../src/ui-state";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalProvider } from "../src/providers";
import { createOfflineYouTubeCacheProvider, writeOfflineYouTubeCacheMetadata } from "../src/offline-youtube-cache";
import { createNavidromeProvider } from "../src/navidrome";
import { createDefaultTmuConfig } from "../src/config";

function endpointName(url: URL): string {
  return url.pathname.split("/").at(-1)?.replace(/\.view$/, "") ?? "";
}

function provider(
  id: string,
  search: (request: ProviderSearchRequest) => Promise<readonly ProviderSearchResult[]>,
  types: ProviderSearchRequest["resultTypes"] = ["track"],
): Provider {
  return {
    id,
    label: id === "local" ? "Local" : id,
    hint: "test",
    capabilities: { searchableResultTypes: types, browsableHierarchy: ["track"], operations: [] },
    getNavigationRoot: () => ({ visible: true, order: 1, detail: "test" }),
    listVisibleTracks: () => [],
    search,
    resolvePlaybackLocator: async () => ({ kind: "file", path: "/tmp/test" }),
  };
}

function result(providerId: string, type: ProviderSearchResult["type"], id: string): ProviderSearchResult {
  return { providerId, providerLabel: providerId === "local" ? "Local" : providerId, type, id, label: id };
}

describe("Global Search", () => {
  test("Local and Offline YouTube Cache search known Tracks without inventing result types", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmu-global-search-"));
    const localPath = join(root, "Amber Mix.flac");
    const cache = { cacheDir: join(root, "cache"), mediaDirName: "media", metadataFileName: "metadata.json" };
    try {
      await writeFile(localPath, "audio");
      const local = createLocalProvider();
      await local.createTrackFromPath(localPath);
      await writeOfflineYouTubeCacheMetadata(cache, {
        version: 1, extractor: "youtube", id: "cached", title: "Amber Cache", mediaFileName: "audio.webm",
      });
      const offline = createOfflineYouTubeCacheProvider(cache);
      const request: ProviderSearchRequest = { query: "amber", resultTypes: ["track", "artist"], limit: 50 };

      expect((await local.search!(request)).map((item) => [item.type, item.label, item.providerId])).toEqual([
        ["track", "Amber Mix.flac", "local"],
      ]);
      expect((await offline.search!(request)).map((item) => [item.type, item.label, item.providerId])).toEqual([
        ["track", "Amber Cache", "offline-youtube-cache"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("configured Navidrome returns lightweight Artists, Albums, Playlists, and playable Tracks", async () => {
    const config = createDefaultTmuConfig({ providers: { navidrome: {
      enabled: true, serverUrl: "https://music.example.test", username: "alex", password: "secret",
    } } }).providers.navidrome;
    const requests: string[] = [];
    const navidrome = createNavidromeProvider({ config, saltFactory: () => "salt", fetcher: async (url) => {
      requests.push(endpointName(url));
      return new Response(JSON.stringify(endpointName(url) === "getPlaylists" ? {
        "subsonic-response": { status: "ok", playlists: { playlist: [
          { id: "playlist-1", name: "Mix Tape", songCount: 12 },
        ] } },
      } : {
        "subsonic-response": { status: "ok", searchResult3: {
          artist: [{ id: "artist-1", name: "The Mixers", albumCount: 3 }],
          album: [{ id: "album-1", name: "Mixed", artist: "The Mixers", songCount: 9 }],
          song: [{ id: "track-1", title: "First" }, { id: "track-2", title: "Second" }],
        } },
      }));
    } });

    const results = await navidrome.search!({
      query: "mix", resultTypes: ["track", "artist", "album", "playlist"], limit: 50,
    });
    expect(results.map((item) => [item.type, item.label])).toEqual([
      ["track", "First"], ["track", "Second"],
      ["artist", "The Mixers"],
      ["album", "Mixed"],
      ["playlist", "Mix Tape"],
    ]);
    expect(results.find((item) => item.type === "track")?.target).toBeDefined();
    expect(results.find((item) => item.type === "artist")?.target).toBeUndefined();
    expect(results.find((item) => item.type === "album")?.target).toEqual({
      kind: "music-collection", id: "navidrome:album:album-1", label: "Mixed",
      resolve: { providerId: "navidrome", operation: "album-tracks", collectionId: "album-1" },
    });
    expect(results.find((item) => item.type === "playlist")?.target).toEqual({
      kind: "music-collection", id: "navidrome:playlist:playlist-1", label: "Mix Tape",
      resolve: { providerId: "navidrome", operation: "playlist-tracks", collectionId: "playlist-1" },
    });
    expect(requests).toEqual(["search3", "getPlaylists"]);
  });

  test("groups type then Provider, preserves rankings and caps every subgroup at 50", () => {
    const state: GlobalSearchState = {
      requestId: 1,
      query: "mix",
      providerFilter: "all",
      resultTypeFilter: "all",
      providers: {
        local: { status: "success", results: Array.from({ length: 52 }, (_, index) => result("local", "track", `local-${index}`)) },
        navidrome: { status: "success", results: [result("navidrome", "artist", "artist-1"), result("navidrome", "track", "remote-1")] },
      },
    };

    const rows = globalSearchRows(state);
    expect(rows.slice(0, 4).map((row) => row.kind === "result" ? row.result.id : row.label)).toEqual([
      "Tracks", "Local", "local-0", "local-1",
    ]);
    expect(rows.filter((row) => row.kind === "result" && row.result.providerId === "local")).toHaveLength(50);
    expect(rows.findIndex((row) => row.kind === "type-heading" && row.label === "Artists"))
      .toBeGreaterThan(rows.findIndex((row) => row.kind === "result" && row.result.id === "remote-1"));
  });

  test("keeps successful Providers usable while failures remain scoped and retryable", async () => {
    let remoteAttempts = 0;
    const providers = {
      local: provider("local", async () => [result("local", "track", "usable")]),
      navidrome: provider("navidrome", async () => {
        remoteAttempts += 1;
        if (remoteAttempts === 1) throw Object.assign(new Error("sign in again"), { kind: "auth" });
        return [result("navidrome", "track", "recovered")];
      }),
    };
    const coordinator = new AppCoordinator({
      appState: createInitialAppState(providers), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player: new NoopPlayer(),
    });

    await coordinator.dispatch({ type: "globalSearch", operation: "submit", query: "mix", providerFilter: "all", resultTypeFilter: "all" });
    expect(coordinator.appState.globalSearch.providers.local).toMatchObject({ status: "success" });
    expect(coordinator.appState.globalSearch.providers.navidrome).toMatchObject({ status: "auth", message: "sign in again" });
    expect(globalSearchRows(coordinator.appState.globalSearch).some((row) => row.kind === "result" && row.result.id === "usable")).toBe(true);

    await coordinator.dispatch({ type: "globalSearch", operation: "retry", providerId: "navidrome" });
    expect(coordinator.appState.globalSearch.providers.navidrome).toMatchObject({ status: "success" });
  });

  test("publishes partial success while another Provider is still loading", async () => {
    let finishRemote: ((results: readonly ProviderSearchResult[]) => void) | undefined;
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({
        local: provider("local", async () => [result("local", "track", "ready")]),
        navidrome: provider("navidrome", () => new Promise((resolve) => { finishRemote = resolve; })),
      }),
      uiState: createInitialUiState(), queue: new MemoryQueue(), player: new NoopPlayer(),
    });

    const search = coordinator.dispatch({
      type: "globalSearch", operation: "submit", query: "mix", providerFilter: "all", resultTypeFilter: "all",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.appState.globalSearch.providers).toMatchObject({
      local: { status: "success" }, navidrome: { status: "loading" },
    });
    finishRemote?.([]);
    await search;
    expect(coordinator.appState.globalSearch.providers.navidrome).toMatchObject({ status: "empty" });
  });

  test("classifies Provider authentication, offline, and ordinary failures independently", async () => {
    const failing = (id: string, error: Error) => provider(id, async () => { throw error; });
    const auth = Object.assign(new Error("credentials expired"), { kind: "auth" });
    const offline = Object.assign(new Error("server unreachable"), { kind: "api" });
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({
        auth: failing("auth", auth), offline: failing("offline", offline), broken: failing("broken", new Error("bad response")),
      }),
      uiState: createInitialUiState(), queue: new MemoryQueue(), player: new NoopPlayer(),
    });
    await coordinator.dispatch({
      type: "globalSearch", operation: "submit", query: "mix", providerFilter: "all", resultTypeFilter: "all",
    });
    expect(coordinator.appState.globalSearch.providers).toMatchObject({
      auth: { status: "auth" }, offline: { status: "offline" }, broken: { status: "failure" },
    });
  });

  test("replacement submissions supersede stale Provider completions", async () => {
    const completions: Array<(results: readonly ProviderSearchResult[]) => void> = [];
    const slow = provider("local", () => new Promise((resolve) => completions.push(resolve)));
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({ local: slow }), uiState: createInitialUiState(),
      queue: new MemoryQueue(), player: new NoopPlayer(),
    });

    const first = coordinator.dispatch({ type: "globalSearch", operation: "submit", query: "old", providerFilter: "all", resultTypeFilter: "all" });
    await Promise.resolve();
    const second = coordinator.dispatch({ type: "globalSearch", operation: "submit", query: "new", providerFilter: "all", resultTypeFilter: "all" });
    await Promise.resolve();
    completions[1]?.([result("local", "track", "new-result")]);
    await second;
    completions[0]?.([result("local", "track", "stale-result")]);
    await first;

    expect(coordinator.appState.globalSearch.query).toBe("new");
    expect(coordinator.appState.globalSearch.providers.local?.results.map((item) => item.id)).toEqual(["new-result"]);
  });

  test("text controls submit filters without triggering playback and clearing restores Provider context", async () => {
    const appState = createInitialAppState({ local: provider("local", async () => []) });
    const ui = new UiStateStore(createInitialUiState());
    ui.dispatch({ type: "setProviderLocation", location: { providerId: "local", path: ["/music"] } });
    ui.dispatch({ type: "openOverlay", overlay: {
      kind: "music-picker", focus: "search", query: "", selectedIdentity: null, scroll: 0,
      providerLocation: { providerId: "local", path: ["/music"] }, selectedResultIndex: 4,
      providerFilter: "local", resultTypeFilter: "track",
    } });
    const intents: unknown[] = [];
    const router = new RootInputRouter({
      registry: createActionRegistry(), appState: () => appState, uiState: ui,
      dispatchApp: async (intent) => { intents.push(intent); },
    });

    for (const key of "amber mix") await router.route(key);
    await router.route("\x17");
    expect(ui.snapshot.overlays.at(-1)?.query).toBe("amber");
    for (const key of " mix") await router.route(key);
    await router.route("\r");
    expect(intents).toEqual([{
      type: "globalSearch", operation: "submit", query: "amber mix",
      providerFilter: "local", resultTypeFilter: "track",
    }]);
    expect(ui.snapshot.overlays.at(-1)).toMatchObject({ focus: "results", selectedResultIndex: 0 });

    appState.globalSearch.query = "amber mix";
    ui.dispatch({ type: "setOverlayFocus", focus: "search" });
    await router.route("\x15");
    expect(intents.at(-1)).toEqual({ type: "globalSearch", operation: "clear" });
    expect(ui.snapshot.overlays.at(-1)).toMatchObject({
      query: "", providerLocation: { providerId: "local", path: ["/music"] }, selectedResultIndex: 0,
    });
  });

  test("registry resolves only playable Global Search rows to explicit semantic targets", () => {
    const track = {
      identity: { providerId: "local", stableId: "/music/amber.flac" },
      title: "Amber", providerLabel: "Local",
    };
    const appState = createInitialAppState({ local: provider("local", async () => []) });
    appState.globalSearch = {
      requestId: 1, query: "amber", providerFilter: "all", resultTypeFilter: "all",
      providers: { local: { providerLabel: "Local", status: "success", results: [{
        providerId: "local", providerLabel: "Local", type: "track", id: "amber", label: "Amber", target: track,
      }] } },
    };
    const uiState = createInitialUiState();
    const rows = globalSearchRows(appState.globalSearch);
    uiState.overlays = [{
      kind: "music-picker", focus: "results", query: "amber", selectedIdentity: null,
      selectedResultIndex: rows.findIndex((row) => row.kind === "result"), scroll: 0,
    }];

    expect(actionForBinding(createActionRegistry(), "\r", { appState, uiState })?.intent).toEqual({
      type: "playNext", target: track,
    });
    uiState.overlays = [{ ...uiState.overlays[0]!, selectedResultIndex: 0 }];
    expect(actionForBinding(createActionRegistry(), "\r", { appState, uiState })).toBeNull();
  });

  test("Enter opens an Artist search result as Album navigation without treating the Artist as playable", async () => {
    const appState = createInitialAppState({ navidrome: provider("navidrome", async () => [], ["artist"]) });
    appState.globalSearch = {
      requestId: 1, query: "mixers", providerFilter: "all", resultTypeFilter: "artist",
      providers: { navidrome: { providerLabel: "Navidrome", status: "success", results: [{
        providerId: "navidrome", providerLabel: "Navidrome", type: "artist",
        id: "artist-1", label: "The Mixers",
      }] } },
    };
    const rows = globalSearchRows(appState.globalSearch);
    const ui = new UiStateStore(createInitialUiState());
    ui.dispatch({ type: "openOverlay", overlay: {
      kind: "music-picker", focus: "results", query: "mixers", selectedIdentity: null, scroll: 0,
      selectedResultIndex: rows.findIndex((row) => row.kind === "result"),
    } });
    const intents: unknown[] = [];
    const router = new RootInputRouter({
      registry: createActionRegistry(), appState: () => appState, uiState: ui,
      dispatchApp: async (intent) => { intents.push(intent); },
    });

    await router.route("\r");

    expect(intents).toEqual([{ type: "globalSearch", operation: "open", result: {
      providerId: "navidrome", providerLabel: "Navidrome", type: "artist",
      id: "artist-1", label: "The Mixers",
    } }]);
  });

  test("right arrow opens a lightweight Album result while Enter remains Play Next", async () => {
    const collection = {
      kind: "music-collection" as const, id: "navidrome:album:album", label: "Album",
      resolve: { providerId: "navidrome", operation: "album-tracks" as const, collectionId: "album" },
    };
    const appState = createInitialAppState({ navidrome: provider("navidrome", async () => [], ["album"]) });
    const albumResult = {
      providerId: "navidrome", providerLabel: "Navidrome", type: "album" as const,
      id: "album", label: "Album", detail: "Artist", target: collection,
    };
    appState.globalSearch = {
      requestId: 1, query: "album", providerFilter: "all", resultTypeFilter: "album",
      providers: { navidrome: { providerLabel: "Navidrome", status: "success", results: [albumResult] } },
    };
    const rows = globalSearchRows(appState.globalSearch);
    const ui = new UiStateStore(createInitialUiState());
    ui.dispatch({ type: "openOverlay", overlay: {
      kind: "music-picker", focus: "results", query: "album", selectedIdentity: null, scroll: 0,
      selectedResultIndex: rows.findIndex((row) => row.kind === "result"),
    } });
    const intents: unknown[] = [];
    const router = new RootInputRouter({
      registry: createActionRegistry(), appState: () => appState, uiState: ui,
      dispatchApp: async (intent) => { intents.push(intent); },
    });

    await router.route("\x1b[C");
    expect(intents).toEqual([{ type: "globalSearch", operation: "open", result: albumResult }]);
    intents.length = 0;
    await router.route("\r");
    expect(intents).toEqual([{ type: "playNext", target: collection }]);
  });

  test("search result movement cannot replace the remembered Provider navigation selection", () => {
    const ui = new UiStateStore(createInitialUiState());
    ui.dispatch({ type: "openOverlay", overlay: {
      kind: "music-picker", focus: "results", query: "", selectedIdentity: null,
      selectedResultIndex: 0, scroll: 0, providerLocation: { providerId: "local", path: ["/music"] },
    } });
    ui.dispatch({ type: "moveOverlaySelection", delta: 3, rowCount: 10, visibleRows: 5 });
    expect(ui.snapshot.providerNavigationMemory).toMatchObject({ selectedIndex: 3, location: { providerId: "local" } });

    ui.dispatch({ type: "setQuery", query: "amber" });
    ui.dispatch({ type: "prepareSearchResults" });
    ui.dispatch({ type: "moveOverlaySelection", delta: 5, rowCount: 10, visibleRows: 5 });
    ui.dispatch({ type: "restoreProviderNavigation" });
    expect(ui.snapshot.overlays.at(-1)).toMatchObject({
      query: "", selectedResultIndex: 3, providerLocation: { providerId: "local", path: ["/music"] },
    });
  });

  test("dismissal clears overlay-local search state and Retry is unavailable on successes", async () => {
    const appState = createInitialAppState({ local: provider("local", async () => []) });
    const trackResult = result("local", "track", "amber");
    appState.globalSearch = {
      requestId: 1, query: "amber", providerFilter: "local", resultTypeFilter: "track",
      providers: { local: { providerLabel: "Local", status: "success", results: [trackResult] } },
    };
    const ui = new UiStateStore(createInitialUiState());
    ui.dispatch({ type: "openOverlay", overlay: {
      kind: "music-picker", focus: "results", query: "amber", selectedIdentity: null,
      selectedResultIndex: globalSearchRows(appState.globalSearch).findIndex((row) => row.kind === "result"),
      scroll: 0, providerFilter: "local", resultTypeFilter: "track",
    } });
    const intents: unknown[] = [];
    const router = new RootInputRouter({
      registry: createActionRegistry(), appState: () => appState, uiState: ui,
      dispatchApp: async (intent) => { intents.push(intent); },
    });

    await router.route("r");
    expect(intents).toEqual([]);
    await router.route("q");
    expect(intents).toEqual([{ type: "globalSearch", operation: "clear" }]);
    expect(ui.snapshot.overlays).toEqual([]);
  });
});
