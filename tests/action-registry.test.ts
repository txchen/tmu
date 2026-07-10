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
  test("keeps superseded legacy bindings inert", async () => {
    const current = context();
    current.uiState.activeTargetId = "local";
    current.uiState.focusedPane = "content";
    current.appState.providers.local = {
      id: "local",
      label: "Local",
      hint: "files",
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
