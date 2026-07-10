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
      aliases: ["enqueue", "add next"],
      bindings: ["Enter"],
      enabled: true,
      intent: { type: "playQueueTrack", track: amber },
    });
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

    await coordinator.dispatch({ type: "enqueueTrack", track: amber });
    await coordinator.dispatch({ type: "enqueueTrack", track: cinder });
    await coordinator.dispatch({ type: "removeQueueTrack", identity: amber.identity });

    expect(coordinator.appState.queue.entries.map((entry) => entry.track)).toEqual([cinder]);
    expect(coordinator.uiState.selectedQueueIdentity).toEqual(cinder.identity);
  });
});

describe("root input router", () => {
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
    const router = new RootInputRouter({
      registry: createActionRegistry(),
      appState: () => current.appState,
      uiState: ui,
      dispatchApp: async () => undefined,
      now: () => now,
    });

    await router.route("g");
    expect(ui.snapshot.pendingVimChord).toEqual({ key: "g", expiresAtMs: 1_750 });
    now = 1_200;
    await router.route("g");
    expect(ui.snapshot.pendingVimChord).toBeNull();

    await router.route("g");
    await router.route("x");
    expect(ui.snapshot.pendingVimChord).toBeNull();
  });
});
