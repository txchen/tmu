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
    { id: "tab.playback", label: "Playback", shortcut: "1" },
    { id: "tab.library", label: "Library", shortcut: "2" },
    { id: "tab.downloader", label: "YouTube Downloader", shortcut: "3" },
    { id: "playback.toggle", label: "Play/Pause", shortcut: "Space" },
  ];
}

export function footerActions(
  registry: ActionRegistry,
  context: { uiState: Pick<UiState, "activeTab"> },
): ActionRegistry {
  return registry.filter((action) =>
    action.id === "playback.toggle" || action.id === `tab.${context.uiState.activeTab}`
  );
}

export function searchCommandActions(registry: ActionRegistry, query: string): ActionRegistry {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized
    ? registry.filter((action) => action.label.toLocaleLowerCase().includes(normalized))
    : registry;
}
