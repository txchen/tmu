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

  test("configured Navidrome returns typed ranked results with playable Tracks and collections", async () => {
    const config = createDefaultTmuConfig({ providers: { navidrome: {
      enabled: true, serverUrl: "https://music.example.test", username: "alex", password: "secret",
    } } }).providers.navidrome;
    const navidrome = createNavidromeProvider({ config, saltFactory: () => "salt", fetcher: async () => new Response(JSON.stringify({
      "subsonic-response": { status: "ok", searchResult3: {
        song: [{ id: "track-1", title: "First" }, { id: "track-2", title: "Second" }],
        artist: [{ id: "artist-1", name: "Artist" }],
        album: [{ id: "album-1", name: "Album" }],
        playlist: [{ id: "playlist-1", name: "Playlist" }],
      } },
    })) });

    const results = await navidrome.search!({
      query: "mix", resultTypes: ["track", "artist", "album", "playlist"], limit: 50,
    });
    expect(results.map((item) => [item.type, item.label])).toEqual([
      ["track", "First"], ["track", "Second"], ["artist", "Artist"], ["album", "Album"], ["playlist", "Playlist"],
    ]);
    expect(results.find((item) => item.type === "track")?.target).toBeDefined();
    expect(results.find((item) => item.type === "album")?.target).toMatchObject({ kind: "music-collection" });
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
});
