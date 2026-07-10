import {
  identityKey,
  type Provider,
  type ProviderSearchRequest,
  GlobalSearchState,
  ProviderSearchResult,
  ProviderSearchResultType,
  ProviderSearchState,
} from "./domain";

const RESULT_TYPES: readonly ProviderSearchResultType[] = ["track", "artist", "album", "playlist"];
const TYPE_LABELS: Record<ProviderSearchResultType, string> = {
  track: "Tracks", artist: "Artists", album: "Albums", playlist: "Playlists",
};

export type GlobalSearchRow =
  | { kind: "type-heading"; label: string }
  | { kind: "provider-heading"; providerId: string; label: string; state: ProviderSearchState }
  | { kind: "provider-status"; providerId: string; label: string; state: ProviderSearchState }
  | { kind: "result"; result: ProviderSearchResult };

export function createEmptyGlobalSearchState(): GlobalSearchState {
  return { requestId: 0, query: "", providerFilter: "all", resultTypeFilter: "all", providers: {} };
}

export function globalSearchRows(state: GlobalSearchState): GlobalSearchRow[] {
  const rows: GlobalSearchRow[] = [];
  const providerEntries = Object.entries(state.providers);
  for (const type of RESULT_TYPES) {
    const groups = providerEntries.map(([providerId, providerState]) => ({
      providerId,
      providerState,
      results: providerState.results.filter((result) => result.type === type).slice(0, 50),
    })).filter(({ results }) => results.length > 0);
    if (groups.length === 0) continue;
    rows.push({ kind: "type-heading", label: TYPE_LABELS[type] });
    for (const group of groups) {
      const label = group.results[0]?.providerLabel ?? group.providerId;
      rows.push({ kind: "provider-heading", providerId: group.providerId, label, state: group.providerState });
      rows.push(...group.results.map((result) => ({ kind: "result" as const, result })));
    }
  }
  for (const [providerId, providerState] of providerEntries) {
    if (providerState.status === "success") continue;
    const firstResult = providerState.results[0];
    rows.push({
      kind: "provider-status",
      providerId,
      label: providerState.providerLabel ?? firstResult?.providerLabel ?? providerId,
      state: providerState,
    });
  }
  return rows;
}

export function globalSearchResultAt(state: GlobalSearchState, index: number): ProviderSearchResult | undefined {
  const row = globalSearchRows(state)[index];
  return row?.kind === "result" ? row.result : undefined;
}

export function globalSearchRetryProviderId(row: GlobalSearchRow | undefined): string | undefined {
  return row?.kind === "provider-status" ? row.providerId : undefined;
}

export function searchKnownTracks(
  provider: Pick<Provider, "id" | "label">,
  tracks: readonly import("./domain").Track[],
  request: ProviderSearchRequest,
): ProviderSearchResult[] {
  if (!request.resultTypes.includes("track") || request.signal?.aborted) return [];
  const query = request.query.trim().toLocaleLowerCase();
  if (!query) return [];
  return tracks
    .filter((track) => [track.title, track.artist, track.album]
      .some((value) => value?.toLocaleLowerCase().includes(query)))
    .slice(0, request.limit)
    .map((track) => ({
      providerId: provider.id, providerLabel: provider.label, type: "track" as const,
      id: identityKey(track.identity), label: track.title, detail: track.artist, target: track,
    }));
}
