import type {
  AppState,
  ProviderBrowserEntry,
  ProviderLocation,
  PickerOverlay,
  ResponsiveTier,
} from "./domain";

export type ProviderNavigationRow = Omit<ProviderBrowserEntry, "kind"> & {
  readonly providerId: string;
  readonly kind: ProviderBrowserEntry["kind"] | "provider";
};

export function providerNavigationRows(
  appState: Pick<AppState, "providers">,
  location: ProviderLocation,
): readonly ProviderNavigationRow[] {
  if (location.providerId) {
    const provider = appState.providers[location.providerId];
    return provider?.listBrowserEntries?.(location).map((entry) => ({ ...entry, providerId: provider.id })) ?? [];
  }

  return Object.values(appState.providers)
    .map((provider) => ({ provider, root: provider.getNavigationRoot() }))
    .filter(({ root }) => root.visible)
    .sort((left, right) => left.root.order - right.root.order || left.provider.label.localeCompare(right.provider.label))
    .map(({ provider, root }) => ({
      id: provider.id,
      providerId: provider.id,
      kind: "provider" as const,
      label: provider.label,
      detail: root.detail,
    }));
}

export type OverlayGeometry = { readonly width: number; readonly height: number };

export function overlayGeometry(
  kind: PickerOverlay["kind"],
  tier: ResponsiveTier,
  columns: number,
  rows: number,
): OverlayGeometry {
  if (tier === "narrow") return { width: columns, height: Math.max(1, rows - 2) };
  if (tier === "medium") return { width: Math.max(1, columns - 4), height: Math.max(1, rows - 2) };
  const cap = kind === "music-picker" ? { width: 112, height: 32 }
    : kind === "confirmation" ? { width: 56, height: 9 }
    : kind === "youtube-url" ? { width: 88, height: 12 }
    : { width: 88, height: 28 };
  return {
    width: Math.min(cap.width, Math.max(1, Math.floor(columns * 0.8))),
    height: Math.min(cap.height, Math.max(1, rows - 4)),
  };
}

export function overlayContentRows(
  kind: PickerOverlay["kind"],
  tier: ResponsiveTier,
  columns: number,
  rows: number,
): number {
  return Math.max(1, overlayGeometry(kind, tier, columns, rows).height - 5);
}
