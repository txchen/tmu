import type { UiState } from "./domain";

export type ActionDefinition = {
  id: string;
  label: string;
  shortcut?: string;
};

export type ActionRegistry = readonly ActionDefinition[];
export type ResolvedAction = ActionDefinition;

export function createActionRegistry(): ActionRegistry {
  return [
    { id: "playback.toggle", label: "Play/Pause", shortcut: "Space" },
    { id: "help", label: "Help", shortcut: "?" },
  ];
}

export function footerActions(
  registry: ActionRegistry,
  context: { uiState: Pick<UiState, "activeTab"> },
): ActionRegistry {
  void context;
  return registry.slice(0, 5);
}
