import { describe, expect, test } from "bun:test";
import {
  AppCoordinator,
  MemoryQueue,
  NoopPlayer,
  RootInputRouter,
  UiStateStore,
  actionForBinding,
  createActionRegistry,
  createInitialAppState,
  createInitialUiState,
  discoveryActions,
  commandPaletteActions,
  footerActions,
  shortcutHelpActions,
  type AppIntent,
} from "../src/index";

const amber = {
  identity: { providerId: "local", stableId: "/music/amber.flac" },
  title: "Amber Path",
  providerLabel: "Local",
};

function context() {
  const appState = createInitialAppState({});
  appState.queue.entries = [{ track: amber, availability: { status: "available" } }];
  const uiState = createInitialUiState();
  uiState.activeTargetId = "queue";
  uiState.focusedPane = "queue";
  uiState.selectedQueueIdentity = amber.identity;
  return { appState, uiState };
}

describe("action registry contracts", () => {
  test("direct input and discovery resolve identical metadata and semantic targets", () => {
    const registry = createActionRegistry();
    const current = context();
    const direct = actionForBinding(registry, "\r", current);
    const discovered = discoveryActions(registry, current)
      .find((action) => action.id === "queue.play-next") ?? null;

    expect(direct).toEqual(discovered);
    expect(direct).toMatchObject({
      id: "queue.play-next",
      name: "Play Next",
      aliases: ["queue next", "add next"],
      bindings: ["Enter"],
      enabled: true,
      intent: { type: "playNext", target: amber },
    });
  });

  test("all discovery surfaces and direct bindings resolve from the same definitions", () => {
    const registry = createActionRegistry();
    const current = context();
    const discovery = discoveryActions(registry, current);

    expect(footerActions(registry, current)).toEqual(discovery);
    expect(shortcutHelpActions(registry, current)).toEqual(discovery);
    expect(commandPaletteActions(registry, current)).toEqual(discovery);
    for (const definition of registry.filter((action) => action.applies(current))) {
      const discovered = discovery.find((action) => action.id === definition.id) ?? null;
      for (const binding of definition.bindings) {
        expect(actionForBinding(registry, binding.key, current)).toEqual(discovered);
      }
    }
  });

  test("omits unsupported actions from discovery and makes their bindings inert", () => {
    const registry = createActionRegistry();
    const current = context();

    expect(discoveryActions(registry, current).some((action) => action.id === "provider.refresh")).toBe(false);
    expect(actionForBinding(registry, "f", current)).toBeNull();
  });

  test("explicit targets remain authoritative when UI selection points elsewhere", async () => {
    const cinder = {
      identity: { providerId: "local", stableId: "/music/cinder.flac" },
      title: "Cinder Room",
      providerLabel: "Local",
    };
    const uiState = createInitialUiState();
    uiState.selectedQueueIdentity = cinder.identity;
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({}),
      uiState,
      queue: new MemoryQueue(),
      player: new NoopPlayer(),
    });
    const uiBefore = structuredClone(coordinator.uiState);

    await coordinator.dispatch({ type: "playNext", target: amber });
    await coordinator.dispatch({ type: "playNext", target: cinder });
    await coordinator.dispatch({ type: "removeQueueTrack", identity: amber.identity });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track)).toEqual([cinder]);
    expect(coordinator.uiState).toEqual(uiBefore);
  });

  test("keeps context-relevant actions discoverable with disabled reasons", () => {
    const registry = createActionRegistry();
    const current = context();
    current.appState.queue.entries = [];
    current.uiState.selectedQueueIdentity = null;

    expect(discoveryActions(registry, current).find((action) => action.id === "queue.play-next")).toMatchObject({
      enabled: false,
      disabledReason: "Queue is empty",
      intent: null,
    });
  });

  test("does not fall through a results overlay without an explicit playable target", () => {
    const registry = createActionRegistry();
    const current = context();
    current.uiState.overlays = [{
      kind: "music-picker",
      focus: "results",
      query: "",
      selectedIdentity: null,
      scroll: 0,
    }];

    expect(actionForBinding(registry, "\r", current)).toBeNull();
    expect(actionForBinding(registry, "\x1b[13;2u", current)).toBeNull();
  });

  test("keeps a Provider's non-playable result authoritative", () => {
    const registry = createActionRegistry();
    const current = context();
    current.uiState.activeTargetId = "local";
    current.appState.providers.local = {
      id: "local",
      label: "Local",
      hint: "directories and Tracks",
      capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["local-directory", "track"], operations: [] },
      getNavigationRoot: () => ({ visible: true, order: 10, detail: "directories and Tracks" }),
      listVisibleTracks: () => [amber],
      playableTargetAt: () => undefined,
      resolvePlaybackLocator: async () => ({ kind: "file", path: amber.identity.stableId }),
    };

    expect(actionForBinding(registry, "\r", current)).toBeNull();
    expect(actionForBinding(registry, "\x1b[13;2u", current)).toBeNull();
  });

  test("routes Queue editing bindings through identity targets and a Clear Queue confirmation request", () => {
    const registry = createActionRegistry();
    const current = context();

    expect(actionForBinding(registry, "\x1b[3~", current)?.intent).toEqual({
      type: "removeQueueTrack",
      identity: amber.identity,
    });
    expect(actionForBinding(registry, "c", current)?.intent).toEqual({
      type: "requestConfirmation",
      kind: "clear-queue",
    });
  });

  test("Space carries the selected Track only when no Current Track exists", () => {
    const registry = createActionRegistry();
    const current = context();

    expect(actionForBinding(registry, " ", current)?.intent).toEqual({
      type: "playNow",
      target: amber,
    });

    current.appState.playback.currentTrackIdentity = amber.identity;
    expect(actionForBinding(registry, " ", current)?.intent).toEqual({
      type: "playerOperation",
      operation: "toggle-play-pause",
    });
  });

  test("keeps Play Next and Play Now distinct for a Music Collection", async () => {
    const cinder = {
      identity: { providerId: "local", stableId: "/music/cinder.flac" },
      title: "Cinder Room",
      providerLabel: "Local",
    };
    const drift = {
      identity: { providerId: "local", stableId: "/music/drift.flac" },
      title: "Drift Signal",
      providerLabel: "Local",
    };
    const queue = new MemoryQueue();
    const coordinator = new AppCoordinator({
      appState: createInitialAppState({}),
      uiState: createInitialUiState(),
      queue,
      player: new NoopPlayer(),
    });
    await coordinator.dispatch({ type: "playNext", target: amber });
    await coordinator.dispatch({ type: "playNext", target: cinder });
    queue.markAvailability(cinder.identity, { status: "unavailable", reason: "offline" });
    await coordinator.dispatch({ type: "playNow", target: amber });

    await coordinator.dispatch({
      type: "playNext",
      target: {
        kind: "music-collection",
        id: "night-drive",
        label: "Night Drive",
        tracks: [cinder, amber, drift, cinder],
      },
    });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual([
      "Amber Path",
      "Cinder Room",
      "Drift Signal",
    ]);
    expect(coordinator.appState.queue.currentIndex).toBe(0);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(amber.identity);
    expect(coordinator.appState.queue.entries[1]?.availability).toEqual({ status: "unavailable", reason: "offline" });

    const registry = createActionRegistry();
    const current = context();
    current.uiState.activeTargetId = "local";
    const collection = {
      kind: "music-collection" as const,
      id: "night-drive",
      label: "Night Drive",
      tracks: [cinder, drift],
    };
    expect(actionForBinding(registry, "\r", { ...current, selectedPlayableTarget: collection })?.intent)
      .toEqual({ type: "playNext", target: collection });
    expect(actionForBinding(registry, "\x1b[13;2u", { ...current, selectedPlayableTarget: collection })?.intent)
      .toEqual({ type: "playNow", target: collection });
  });
});

describe("root input router", () => {
  test("routes Enter and Shift+Enter with an explicit resolved Music Collection target", async () => {
    const cinder = {
      identity: { providerId: "remote", stableId: "cinder" },
      title: "Cinder Room",
      providerLabel: "Remote",
    };
    const drift = {
      identity: { providerId: "remote", stableId: "drift" },
      title: "Drift Signal",
      providerLabel: "Remote",
    };
    const collection = {
      kind: "music-collection" as const,
      id: "navidrome:album:night-drive",
      label: "Night Drive",
      resolve: { providerId: "navidrome", operation: "album-tracks" as const, collectionId: "night-drive" },
    };
    let resolutions = 0;
    let cancelResolution = true;
    const appState = createInitialAppState({
      navidrome: {
        id: "navidrome",
        label: "Remote",
        hint: "collections",
        capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["album", "track"], operations: [] },
        getNavigationRoot: () => ({ visible: true, order: 20, detail: "collections" }),
        listVisibleTracks: () => [],
        playableTargetAt: () => collection,
        resolveMusicCollection: async () => {
          resolutions += 1;
          if (cancelResolution) return { status: "cancelled" as const };
          return { status: "resolved" as const, tracks: [cinder, drift] };
        },
        resolvePlaybackLocator: async (identity) => ({ kind: "file" as const, path: `/remote/${identity.stableId}` }),
      },
    });
    const uiState = createInitialUiState();
    uiState.activeTargetId = "queue";
    uiState.focusedPane = "queue";
    uiState.providerLocation = { providerId: "navidrome", path: [] };
    uiState.overlays = [{
      kind: "music-picker",
      focus: "results",
      query: "night",
      selectedIdentity: null,
      selectedResultIndex: 0,
      providerLocation: { providerId: "navidrome", path: [] },
      scroll: 0,
    }];
    const queue = new MemoryQueue();
    queue.enqueue(amber);
    queue.startAt(0);
    appState.playback.currentTrackIdentity = amber.identity;
    const coordinator = new AppCoordinator({ appState, uiState, queue, player: new NoopPlayer() });
    const router = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => coordinator.appState,
      uiState: {
        get snapshot() { return coordinator.uiState; },
        dispatch: (action) => coordinator.dispatchUi(action),
      },
      dispatchApp: (intent) => coordinator.dispatch(intent),
    });

    await router.route("\r");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual([amber.title]);
    expect(coordinator.appState.lastEvent).toBe("Music Collection resolution cancelled");
    expect(coordinator.uiState.overlays.at(-1)?.selectedResultIndex).toBe(0);

    cancelResolution = false;
    await router.route("\r");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual([
      amber.title,
      cinder.title,
      drift.title,
    ]);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(amber.identity);
    expect(coordinator.uiState.overlays.at(-1)?.selectedResultIndex).toBe(0);

    await router.route("\x1b[13;2u");
    expect(coordinator.appState.queue.entries.map((entry) => entry.track.title)).toEqual([
      amber.title,
      cinder.title,
      drift.title,
    ]);
    expect(coordinator.appState.playback.currentTrackIdentity).toEqual(cinder.identity);
    expect(coordinator.uiState.overlays.at(-1)?.selectedResultIndex).toBe(0);
    expect(resolutions).toBe(3);
  });

  test("keeps superseded legacy bindings inert", async () => {
    const current = context();
    current.uiState.activeTargetId = "local";
    current.uiState.focusedPane = "content";
    current.appState.providers.local = {
      id: "local",
      label: "Local",
      hint: "files",
      capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["track"], operations: [] },
      getNavigationRoot: () => ({ visible: true, order: 10, detail: "files" }),
      listVisibleTracks: () => [amber],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/music/amber.flac" }),
    };
    const ui = new UiStateStore(current.uiState);
    const intents: AppIntent[] = [];
    const router = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => current.appState,
      uiState: ui,
      dispatchApp: (intent) => { intents.push(intent); },
    });

    await router.route("a");

    expect(intents).toEqual([]);
  });

  test("keeps Provider navigation inside the one root router", async () => {
    const current = context();
    current.uiState.activeTargetId = "navidrome";
    const ui = new UiStateStore(current.uiState);
    const intents: string[] = [];
    const router = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => current.appState,
      uiState: ui,
      dispatchApp: () => undefined,
      dispatchUiIntent: (intent) => { intents.push(intent.type); },
    });

    for (const key of ["\t", "\x1b[B", "2", "o", "/", "\r"]) await router.route(key);

    expect(intents).toEqual([
      "cycleFocus",
      "moveSelection",
      "selectNavigationTarget",
      "openLocalPathPrompt",
      "openNavidromeSearchPrompt",
      "activateSelectedContent",
    ]);
  });

  test("repairs Queue selection after semantic Queue mutations", async () => {
    const cinder = {
      identity: { providerId: "local", stableId: "/music/cinder.flac" },
      title: "Cinder Room",
      providerLabel: "Local",
    };
    const current = context();
    current.appState.queue.entries.push({ track: cinder, availability: { status: "available" } });
    const ui = new UiStateStore(current.uiState);
    const router = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => current.appState,
      uiState: ui,
      dispatchApp: () => { current.appState.queue.entries.shift(); },
    });

    await router.route("x");

    expect(ui.snapshot.selectedQueueIdentity).toEqual(cinder.identity);
  });

  test("keeps Clear Queue unchanged on default Cancel and dispatches only an explicit confirmation", async () => {
    const current = context();
    const ui = new UiStateStore(current.uiState);
    const intents: AppIntent[] = [];
    const router = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => current.appState,
      uiState: ui,
      dispatchApp: (intent) => { intents.push(intent); },
    });

    await router.route("c");
    expect(ui.snapshot.pendingConfirmation).toEqual({ kind: "clear-queue", choice: "cancel" });
    await router.route("\r");
    expect(intents).toEqual([]);
    expect(ui.snapshot.pendingConfirmation).toBeNull();

    await router.route("c");
    await router.route("l");
    expect(ui.snapshot.pendingConfirmation?.choice).toBe("confirm");
    await router.route("\r");
    expect(intents).toEqual([{ type: "clearQueue" }]);
    expect(ui.snapshot.pendingConfirmation).toBeNull();
  });

  test("supports every approved Clear Queue confirmation keyboard choice", async () => {
    const current = context();
    const ui = new UiStateStore(current.uiState);
    const intents: AppIntent[] = [];
    const router = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => current.appState,
      uiState: ui,
      dispatchApp: (intent) => { intents.push(intent); },
    });

    await router.route("c");
    await router.route("\x1b[C");
    expect(ui.snapshot.pendingConfirmation?.choice).toBe("confirm");
    await router.route("\x1b[D");
    expect(ui.snapshot.pendingConfirmation?.choice).toBe("cancel");
    await router.route("l");
    await router.route("h");
    expect(ui.snapshot.pendingConfirmation?.choice).toBe("cancel");
    await router.route("\t");
    expect(ui.snapshot.pendingConfirmation?.choice).toBe("confirm");
    await router.route("y");
    expect(intents).toEqual([{ type: "clearQueue" }]);

    for (const cancelKey of ["n", "q", "\x1b"]) {
      await router.route("c");
      await router.route(cancelKey);
      expect(ui.snapshot.pendingConfirmation).toBeNull();
    }
    expect(intents).toEqual([{ type: "clearQueue" }]);
  });

  test("gives text entry precedence over global shortcuts", async () => {
    const current = context();
    current.uiState.overlays = [{
      kind: "command-palette",
      focus: "search",
      query: "",
      selectedIdentity: null,
      scroll: 0,
    }];
    const ui = new UiStateStore(current.uiState);
    const intents: AppIntent[] = [];
    const router = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => current.appState,
      uiState: ui,
      dispatchApp: async (intent) => { intents.push(intent); },
      now: () => 1_000,
    });

    await router.route("q");

    expect(ui.snapshot.overlays.at(-1)?.query).toBe("q");
    expect(intents).toEqual([]);
  });

  test("turns submitted text into an explicit Provider operation", async () => {
    const current = context();
    current.uiState.activePrompt = "local-open-path";
    current.uiState.promptInput = "/music/album";
    const ui = new UiStateStore(current.uiState);
    const intents: AppIntent[] = [];
    const router = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => current.appState,
      uiState: ui,
      dispatchApp: async (intent) => { intents.push(intent); },
    });

    await router.route("\r");

    expect(intents).toEqual([{
      type: "providerOperation",
      providerId: "local",
      operation: "open-path",
      path: "/music/album",
    }]);
    expect(ui.snapshot.activePrompt).toBeNull();
  });

  test("routes only the top overlay and dismisses one non-text layer", async () => {
    const current = context();
    const ui = new UiStateStore(current.uiState);
    ui.dispatch({
      type: "openOverlay",
      overlay: { kind: "music-picker", focus: "results", query: "moon", selectedIdentity: null, scroll: 2 },
    });
    ui.dispatch({
      type: "openOverlay",
      overlay: { kind: "shortcut-help", focus: "results", query: "", selectedIdentity: null, scroll: 0 },
    });
    const router = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => current.appState,
      uiState: ui,
      dispatchApp: async () => undefined,
      now: () => 1_000,
    });

    await router.route("q");

    expect(ui.snapshot.overlays).toHaveLength(1);
    expect(ui.snapshot.overlays[0]?.kind).toBe("music-picker");
  });

  test("navigates the source-neutral Provider root with aliases and remembers process-local location", async () => {
    const current = context();
    current.appState.providers.local = {
      id: "local",
      label: "Local",
      hint: "files and folders",
      capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["local-directory", "track"], operations: [] },
      getNavigationRoot: () => ({ visible: true, order: 10, detail: "files and folders" }),
      listVisibleTracks: () => [amber],
      listBrowserEntries: (location) => location.path.length === 0
        ? [{ id: "/music/Album", kind: "local-directory", label: "Album" }]
        : [{ id: amber.identity.stableId, kind: "track", label: amber.title }],
      playableTargetAt: (location, index) => location.path.length > 0 && index === 0 ? amber : undefined,
      resolvePlaybackLocator: async () => ({ kind: "file", path: amber.identity.stableId }),
    };
    current.appState.providers["offline-youtube-cache"] = {
      id: "offline-youtube-cache",
      label: "Offline YouTube Cache",
      hint: "cached Tracks",
      capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["track"], operations: ["refresh"] },
      getNavigationRoot: () => ({ visible: true, order: 30, detail: "cached Tracks" }),
      listVisibleTracks: () => [],
      listBrowserEntries: () => [],
      resolvePlaybackLocator: async () => ({ kind: "file", path: "/cache" }),
    };
    const ui = new UiStateStore(current.uiState);
    const intents: AppIntent[] = [];
    const router = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => current.appState,
      uiState: ui,
      dispatchApp: async (intent) => { intents.push(intent); },
      now: () => 1_000,
    });

    await router.route("o");
    expect(ui.snapshot.overlays.at(-1)).toMatchObject({
      focus: "results", providerLocation: { providerId: null, path: [] }, selectedResultIndex: 0,
    });
    await router.route("\x1b[F");
    expect(ui.snapshot.overlays.at(-1)?.selectedResultIndex).toBe(1);
    await router.route("\x1b[H");
    await router.route("\r");
    expect(ui.snapshot.overlays.at(-1)?.providerLocation).toEqual({ providerId: "local", path: [] });
    await router.route("l");
    expect(ui.snapshot.overlays.at(-1)?.providerLocation).toEqual({ providerId: "local", path: ["/music/Album"] });
    await router.route("\r");
    expect(intents).toEqual([{ type: "playNext", target: amber }]);
    await router.route("q");
    await router.route("o");
    expect(ui.snapshot.overlays.at(-1)?.providerLocation).toEqual({ providerId: "local", path: ["/music/Album"] });
    await router.route("h");
    await router.route("\x7f");
    expect(ui.snapshot.overlays.at(-1)?.providerLocation).toEqual({ providerId: null, path: [] });
  });

  test("opens one music picker with search focused and returns Esc to results", async () => {
    const current = context();
    const ui = new UiStateStore(current.uiState);
    const router = new RootInputRouter({
      registry: createActionRegistry(), appState: () => current.appState, uiState: ui, dispatchApp: async () => undefined,
    });

    await router.route("/");
    expect(ui.snapshot.overlays.at(-1)).toMatchObject({ kind: "music-picker", focus: "search" });
    await router.route("ambient mix");
    await router.route("\x1b");
    expect(ui.snapshot.overlays.at(-1)).toMatchObject({ kind: "music-picker", focus: "results" });
  });

  test("routes configured Provider recovery from the results overlay", async () => {
    const current = context();
    current.appState.providers.navidrome = {
      id: "navidrome",
      label: "Navidrome",
      hint: "offline",
      capabilities: { searchableResultTypes: ["track"], browsableHierarchy: ["artist", "album", "playlist", "track"], operations: ["retry"] },
      getNavigationRoot: () => ({ visible: true, order: 20, detail: "Offline · Retry" }),
      listVisibleTracks: () => [],
      listBrowserEntries: () => [],
      resolvePlaybackLocator: async () => ({ kind: "url", url: "https://music.example.test/stream" }),
    };
    const ui = new UiStateStore(current.uiState);
    ui.dispatch({
      type: "openOverlay",
      overlay: {
        kind: "music-picker", focus: "results", query: "", selectedIdentity: null,
        selectedResultIndex: 0, scroll: 0, providerLocation: { providerId: "navidrome", path: [] },
      },
    });
    const intents: AppIntent[] = [];
    const router = new RootInputRouter({
      registry: createActionRegistry(), appState: () => current.appState, uiState: ui,
      dispatchApp: async (intent) => { intents.push(intent); },
    });

    await router.route("r");
    expect(intents).toEqual([{ type: "providerOperation", providerId: "navidrome", operation: "retry" }]);
    ui.dispatch({ type: "setProviderLocation", location: { providerId: null, path: [] } });
    await router.route("r");
    expect(intents.at(-1)).toEqual({ type: "providerOperation", providerId: "navidrome", operation: "retry" });
  });

  test("advances and cancels the visible gg key sequence", async () => {
    const current = context();
    const ui = new UiStateStore(current.uiState);
    let now = 1_000;
    let expiry: (() => void) | null = null;
    const router = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => current.appState,
      uiState: ui,
      dispatchApp: async () => undefined,
      now: () => now,
      timers: {
        setTimeout: (callback) => { expiry = callback; return callback; },
        clearTimeout: () => { expiry = null; },
      },
    });

    await router.route("g");
    expect(ui.snapshot.pendingVimChord).toEqual({ key: "g", expiresAtMs: 1_750 });
    now = 1_200;
    await router.route("g");
    expect(ui.snapshot.pendingVimChord).toBeNull();

    await router.route("g");
    await router.route("x");
    expect(ui.snapshot.pendingVimChord).toBeNull();

    await router.route("g");
    now = 2_000;
    const expire = expiry as (() => void) | null;
    if (expire) expire();
    expect(ui.snapshot.pendingVimChord).toBeNull();
  });
});
