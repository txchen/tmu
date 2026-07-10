import { isNavidromeProvider } from "./navidrome";
import type {
  AppState,
  ProviderBrowserEntry,
  ProviderLocation,
  PickerOverlay,
  ResponsiveTier,
} from "./domain";

export type ProviderNavigationRow = ProviderBrowserEntry & {
  readonly providerId: string;
};

export function providerNavigationRows(
  appState: Pick<AppState, "config" | "providers">,
  location: ProviderLocation,
): readonly ProviderNavigationRow[] {
  if (location.providerId) {
    const provider = appState.providers[location.providerId];
    return provider?.listBrowserEntries?.(location).map((entry) => ({ ...entry, providerId: provider.id })) ?? [];
  }

  return ["local", "navidrome", "offline-youtube-cache"].flatMap((providerId) => {
    const provider = appState.providers[providerId];
    if (!provider) return [];
    if (providerId === "navidrome" && !appState.config.providers.navidrome.serverUrl.trim()) return [];
    return [{
      id: provider.id,
      providerId: provider.id,
      kind: provider.capabilities.browsableHierarchy[0] ?? "track",
      label: provider.label,
      detail: providerRootDetail(appState, providerId),
    } satisfies ProviderNavigationRow];
  });
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

function providerRootDetail(
  appState: Pick<AppState, "config" | "providers">,
  providerId: string,
): string {
  const provider = appState.providers[providerId];
  if (providerId !== "navidrome" || !isNavidromeProvider(provider)) return provider?.hint ?? "";
  const state = provider.getConnectionState();
  if (state.status === "missing-config") {
    return state.missingFields.includes("enabled")
      ? "Disabled · Enable in TMU Config"
      : `${state.message} · Update TMU Config`;
  }
  if (state.status === "auth-failure") return "Authentication failed · Check credentials and retry";
  if (state.status === "api-failure") return "Offline · Retry";
  if (state.status === "checking") return "Checking connection · Retry";
  return provider.hint;
}
