// PROTOTYPE - throwaway model for issue "Validate Queue Home and Picker Overlays with an interactive prototype".
// Question: can TMU's decided Queue Home, Picker Overlay, keyboard discovery, queue shaping,
// dismissal, and resize behavior be driven intuitively with the keyboard alone?

export type Track = {
  id: string;
  title: string;
  artist: string;
  provider: "Local" | "Navidrome" | "Offline YouTube Cache";
  album?: string;
  duration: string;
  availability?: string;
};

export type QueueEntry = {
  track: Track;
};

export type PlaybackStatus = "restored" | "playing" | "paused" | "stopped";

export type PickerFocus = "results" | "search";
export type PickerMode = "provider" | "search";

export type PickerOverlay = {
  kind: "picker";
  focus: PickerFocus;
  mode: PickerMode;
  query: string;
  location: string[];
  selected: number;
  providerFilter: "All" | Track["provider"];
  resultTypeFilter: "All" | "Tracks" | "Albums" | "Playlists";
};

export type HelpOverlay = {
  kind: "help";
  focus: "results" | "filter";
  query: string;
  selected: number;
};

export type PaletteOverlay = {
  kind: "palette";
  query: string;
  selected: number;
};

export type ClearConfirmOverlay = {
  kind: "clear-confirm";
  choice: "cancel" | "clear";
};

export type YoutubeUrlOverlay = {
  kind: "youtube-url";
  input: string;
  status: "editing" | "downloading" | "done";
};

export type Overlay =
  | PickerOverlay
  | HelpOverlay
  | PaletteOverlay
  | ClearConfirmOverlay
  | YoutubeUrlOverlay;

export type TerminalTier = "wide" | "medium" | "narrow";

export type PrototypeState = {
  queue: QueueEntry[];
  selectedQueueIndex: number;
  currentTrackId: string | null;
  playback: PlaybackStatus;
  playbackPosition: string;
  shuffle: boolean;
  repeatAll: boolean;
  volume: number;
  overlays: Overlay[];
  pendingChord: null | "g";
  terminal: {
    columns: number;
    rows: number;
    tier: TerminalTier;
  };
  redraws: number;
  lastAction: string;
};

export type PickerRow = {
  id: string;
  label: string;
  detail: string;
  kind: "group" | "provider" | "directory" | "artist" | "album" | "playlist" | "track" | "status";
  provider?: Track["provider"];
  tracks?: Track[];
  path?: string[];
  disabledReason?: string;
};

type Command = {
  id: string;
  label: string;
  keys: string;
  context: "global" | "queue" | "picker" | "overlay";
  enabled: (state: PrototypeState) => boolean;
  disabledReason: string;
  run: (state: PrototypeState) => PrototypeState;
};

const CATALOG: Record<string, Track> = {
  "navidrome:moon": {
    id: "navidrome:moon",
    title: "Moonlight",
    artist: "Asha Mir",
    provider: "Navidrome",
    album: "Night Signals",
    duration: "4:18",
  },
  "navidrome:lighthouse": {
    id: "navidrome:lighthouse",
    title: "Lighthouse",
    artist: "Asha Mir",
    provider: "Navidrome",
    album: "Night Signals",
    duration: "3:42",
  },
  "navidrome:wire": {
    id: "navidrome:wire",
    title: "Copper Wire",
    artist: "The Index",
    provider: "Navidrome",
    album: "Terminal Pop",
    duration: "2:58",
  },
  "local:basement": {
    id: "local:basement",
    title: "Basement Demo",
    artist: "Ada Park",
    provider: "Local",
    album: "Loose Files",
    duration: "2:41",
  },
  "local:sketch": {
    id: "local:sketch",
    title: "Sketch 07",
    artist: "Ada Park",
    provider: "Local",
    album: "Loose Files",
    duration: "1:36",
  },
  "youtube:lecture": {
    id: "youtube:lecture",
    title: "Live Session Cut",
    artist: "Mira Lane",
    provider: "Offline YouTube Cache",
    album: "Cached Audio",
    duration: "5:03",
  },
  "youtube:unavailable": {
    id: "youtube:unavailable",
    title: "Missing Cache File",
    artist: "Unknown",
    provider: "Offline YouTube Cache",
    album: "Cached Audio",
    duration: "3:11",
    availability: "cached file moved",
  },
};

const NIGHT_SIGNALS = [CATALOG["navidrome:moon"], CATALOG["navidrome:lighthouse"]];
const LOCAL_SKETCHES = [CATALOG["local:basement"], CATALOG["local:sketch"]];
const MORNING_FOCUS = [
  CATALOG["navidrome:moon"],
  CATALOG["youtube:lecture"],
  CATALOG["local:basement"],
];

export function createInitialPrototypeState(columns = 120, rows = 36): PrototypeState {
  return markRedrawn({
    queue: [
      { track: CATALOG["navidrome:moon"] },
      { track: CATALOG["youtube:unavailable"] },
      { track: CATALOG["local:basement"] },
      { track: CATALOG["navidrome:wire"] },
    ],
    selectedQueueIndex: 0,
    currentTrackId: "navidrome:moon",
    playback: "restored",
    playbackPosition: "1:42",
    shuffle: false,
    repeatAll: false,
    volume: 72,
    overlays: [],
    pendingChord: null,
    terminal: {
      columns,
      rows,
      tier: tierForColumns(columns),
    },
    redraws: 0,
    lastAction: "Restored Last Queue Snapshot into Queue Home; no autoplay.",
  });
}

export function reduceKey(state: PrototypeState, key: string): PrototypeState {
  if (key === "\u0003") return markRedrawn({ ...state, lastAction: "Quit requested with Ctrl-c." });

  if (state.pendingChord === "g") {
    if (key === "g") {
      return moveSelection({ ...state, pendingChord: null }, "first");
    }
    state = { ...state, pendingChord: null, lastAction: "Pending g chord cancelled." };
  }

  const top = topOverlay(state);
  if (top) return reduceOverlayKey(state, top, key);
  return reduceQueueHomeKey(state, key);
}

export function reduceResize(state: PrototypeState, columns: number, rows: number): PrototypeState {
  return markRedrawn({
    ...state,
    terminal: {
      columns,
      rows,
      tier: tierForColumns(columns),
    },
    lastAction: `Resize repaired layout to ${tierForColumns(columns)} (${columns}x${rows}); selection stayed on identity.`,
  });
}

export function shouldQuit(state: PrototypeState, key: string): boolean {
  return !topOverlay(state) && (key === "q" || key === "\u0003");
}

export function topOverlay(state: PrototypeState): Overlay | null {
  return state.overlays[state.overlays.length - 1] ?? null;
}

export function currentTrack(state: PrototypeState): Track | null {
  if (!state.currentTrackId) return null;
  return state.queue.find((entry) => entry.track.id === state.currentTrackId)?.track ?? null;
}

export function selectedQueueEntry(state: PrototypeState): QueueEntry | null {
  return state.queue[state.selectedQueueIndex] ?? null;
}

export function pickerRows(overlay: PickerOverlay): PickerRow[] {
  if (overlay.mode === "search") return globalSearchRows(overlay);
  return providerNavigationRows(overlay.location);
}

export function helpRows(state: PrototypeState, overlay: HelpOverlay): string[] {
  const context = topOverlay({ ...state, overlays: state.overlays.slice(0, -1) })?.kind ?? "queue-home";
  const rows = [
    "Queue Home",
    "Space: Play/Pause/Resume Current Track; with no Current Track, start selected row.",
    "Enter: Play Next selected Queue Track. S-Enter/P: Play Now selected Queue Track.",
    "J/K: move selected Track while selection follows identity.",
    "x: remove selected Track. c: Clear Queue confirmation.",
    "o: open Picker Overlay at Provider root. /: open Picker Overlay in search field.",
    "u: open YouTube URL Download Flow.",
    "",
    "Picker Overlay",
    "Enter: Play Next Track, Album, or Playlist; opens Providers, Artists, and Local Directories.",
    "S-Enter/P: Play Now playable rows. l/Right: inspect collection or open container.",
    "h/Left/Backspace: parent location. Esc: search field to results, then dismiss overlay.",
    "f: cycle Provider filter. r: retry selected failed Provider section.",
    "",
    "Discovery",
    "?: Contextual Shortcut Help. :: Command Palette. q/Esc dismiss top overlay.",
    `Current context: ${context}.`,
  ];
  if (!overlay.query.trim()) return rows;
  const query = overlay.query.toLowerCase();
  return rows.filter((row) => row.toLowerCase().includes(query));
}

export function paletteRows(state: PrototypeState, overlay: PaletteOverlay): Command[] {
  const query = overlay.query.trim().toLowerCase();
  const rows = commands().filter((command) => {
    if (!query) return true;
    return `${command.label} ${command.keys}`.toLowerCase().includes(query);
  });
  return rows.map((command) => ({
    ...command,
    disabledReason: command.enabled(state) ? "" : command.disabledReason,
  }));
}

export function stateSummary(state: PrototypeState): Record<string, string | number | boolean> {
  const top = topOverlay(state);
  const selected = selectedQueueEntry(state)?.track;
  const current = currentTrack(state);
  return {
    surface: top ? top.kind : "Queue Home",
    selected: selected ? selected.title : "none",
    current: current ? current.title : "none",
    playback: `${state.playback} @ ${state.playbackPosition}`,
    queueSize: state.queue.length,
    shuffle: state.shuffle,
    repeatAll: state.repeatAll,
    volume: state.volume,
    terminalTier: state.terminal.tier,
    redraws: state.redraws,
  };
}

function reduceQueueHomeKey(state: PrototypeState, key: string): PrototypeState {
  if (key === "q") return markRedrawn({ ...state, lastAction: "Quit requested." });
  if (key === "g") return markRedrawn({ ...state, pendingChord: "g", lastAction: "Pending chord: g. Press g for first row." });
  if (key === "G" || key === "\x1b[F") return moveSelection(state, "last");
  if (key === "j" || key === "\x1b[B") return moveSelection(state, 1);
  if (key === "k" || key === "\x1b[A") return moveSelection(state, -1);
  if (key === "\u0004" || key === "\x1b[6~") return moveSelection(state, pageSize(state));
  if (key === "\u0015" || key === "\x1b[5~") return moveSelection(state, -pageSize(state));
  if (key === "\r") return playNextSelectedQueueTrack(state);
  if (key === "\x1b[13;2u" || key === "P") return playNowSelectedQueueTrack(state);
  if (key === " ") return togglePlayback(state);
  if (key === "s") return stopPlayback(state);
  if (key === "n") return nextTrack(state);
  if (key === "p") return previousTrack(state);
  if (key === "[") return markRedrawn({ ...state, lastAction: "Seeked Current Track backward 5 seconds." });
  if (key === "]") return markRedrawn({ ...state, lastAction: "Seeked Current Track forward 5 seconds." });
  if (key === "-") return setVolume(state, -5);
  if (key === "+" || key === "=") return setVolume(state, 5);
  if (key === "z") return toggleShuffle(state);
  if (key === "J") return moveQueueEntry(state, 1);
  if (key === "K") return moveQueueEntry(state, -1);
  if (key === "x" || key === "\x1b[3~") return removeSelectedQueueEntry(state);
  if (key === "c") return pushOverlay(state, { kind: "clear-confirm", choice: "cancel" }, "Clear Queue confirmation opened with Cancel selected.");
  if (key === "o") return openPicker(state, "results");
  if (key === "/") return openPicker(state, "search");
  if (key === "u") return pushOverlay(state, { kind: "youtube-url", input: "", status: "editing" }, "YouTube URL Download Flow opened.");
  if (key === "?") return pushOverlay(state, { kind: "help", focus: "results", query: "", selected: 0 }, "Contextual Shortcut Help opened.");
  if (key === ":") return pushOverlay(state, { kind: "palette", query: "", selected: 0 }, "Command Palette opened.");
  return markRedrawn({ ...state, lastAction: `No Queue Home action for ${describeKey(key)}.` });
}

function reduceOverlayKey(state: PrototypeState, top: Overlay, key: string): PrototypeState {
  if (top.kind === "picker") return reducePickerKey(state, top, key);
  if (top.kind === "help") return reduceHelpKey(state, top, key);
  if (top.kind === "palette") return reducePaletteKey(state, top, key);
  if (top.kind === "clear-confirm") return reduceClearConfirmKey(state, top, key);
  return reduceYoutubeUrlKey(state, top, key);
}

function reducePickerKey(state: PrototypeState, overlay: PickerOverlay, key: string): PrototypeState {
  if (overlay.focus === "search") {
    if (key === "\x1b") return replaceTopOverlay(state, { ...overlay, focus: "results" }, "Search field lost focus; query preserved.");
    if (key === "\r") {
      const next = normalizePickerSelection({
        ...overlay,
        mode: overlay.query.trim() ? "search" : "provider",
        focus: "results",
        selected: 0,
      });
      const action = next.mode === "search"
        ? `Submitted Global Search for "${next.query}".`
        : "Cleared query; restored Provider navigation.";
      return replaceTopOverlay(state, next, action);
    }
    if (key === "\x7f" || key === "\b") return replaceTopOverlay(state, { ...overlay, query: overlay.query.slice(0, -1) }, "Edited search query.");
    if (key === "\u0017") return replaceTopOverlay(state, { ...overlay, query: overlay.query.replace(/\s*\S+$/, "") }, "Deleted previous search word.");
    if (key === "\u0015") return replaceTopOverlay(state, { ...overlay, query: "" }, "Cleared search field.");
    if (isPrintable(key)) return replaceTopOverlay(state, { ...overlay, query: `${overlay.query}${key}` }, "Edited search query.");
    return state;
  }

  if (key === "\x1b" || key === "q") return popOverlay(state, "Picker Overlay dismissed; Queue Home context restored.");
  if (key === "?") return pushOverlay(state, { kind: "help", focus: "results", query: "", selected: 0 }, "Contextual Shortcut Help opened above Picker Overlay.");
  if (key === ":") return pushOverlay(state, { kind: "palette", query: "", selected: 0 }, "Command Palette opened above Picker Overlay.");
  if (key === "/") return replaceTopOverlay(state, { ...overlay, focus: "search" }, "Search field focused.");
  if (key === "j" || key === "\x1b[B") return replaceTopOverlay(state, movePickerSelection(overlay, 1), "Picker selection moved down.");
  if (key === "k" || key === "\x1b[A") return replaceTopOverlay(state, movePickerSelection(overlay, -1), "Picker selection moved up.");
  if (key === "g") return markRedrawn({ ...state, pendingChord: "g", lastAction: "Pending chord: g. Press g for first result." });
  if (key === "G" || key === "\x1b[F") return replaceTopOverlay(state, { ...overlay, selected: pickerRows(overlay).length - 1 }, "Picker selection moved to last result.");
  if (key === "h" || key === "\x1b[D" || key === "\x7f") return replaceTopOverlay(state, parentPickerLocation(overlay), "Picker returned to parent location.");
  if (key === "l" || key === "\x1b[C") return openSelectedPickerRow(state, overlay, "inspect");
  if (key === "\r") return openSelectedPickerRow(state, overlay, "enter");
  if (key === "\x1b[13;2u" || key === "P") return openSelectedPickerRow(state, overlay, "play-now");
  if (key === "f") return replaceTopOverlay(state, cycleProviderFilter(overlay), "Provider filter cycled for next submitted Global Search.");
  if (key === "r") return markRedrawn({ ...state, lastAction: "Retried selected Provider section; successful sections stayed visible." });
  return markRedrawn({ ...state, lastAction: `No Picker action for ${describeKey(key)}.` });
}

function reduceHelpKey(state: PrototypeState, overlay: HelpOverlay, key: string): PrototypeState {
  if (overlay.focus === "filter") {
    if (key === "\x1b") return replaceTopOverlay(state, { ...overlay, focus: "results" }, "Help filter lost focus.");
    if (key === "\x7f" || key === "\b") return replaceTopOverlay(state, { ...overlay, query: overlay.query.slice(0, -1) }, "Edited Help filter.");
    if (key === "\u0015") return replaceTopOverlay(state, { ...overlay, query: "" }, "Cleared Help filter.");
    if (isPrintable(key)) return replaceTopOverlay(state, { ...overlay, query: `${overlay.query}${key}` }, "Edited Help filter.");
    return state;
  }

  if (key === "\x1b" || key === "q") return popOverlay(state, "Contextual Shortcut Help dismissed; prior overlay restored.");
  if (key === "/") return replaceTopOverlay(state, { ...overlay, focus: "filter" }, "Help filter focused.");
  if (key === "j" || key === "\x1b[B") return replaceTopOverlay(state, moveHelpSelection(state, overlay, 1), "Help selection moved down.");
  if (key === "k" || key === "\x1b[A") return replaceTopOverlay(state, moveHelpSelection(state, overlay, -1), "Help selection moved up.");
  return markRedrawn({ ...state, lastAction: `No Help action for ${describeKey(key)}.` });
}

function reducePaletteKey(state: PrototypeState, overlay: PaletteOverlay, key: string): PrototypeState {
  if (key === "\x1b") return popOverlay(state, "Command Palette dismissed; prior context restored.");
  if (key === "\x7f" || key === "\b") return replaceTopOverlay(state, { ...overlay, query: overlay.query.slice(0, -1), selected: 0 }, "Edited Command Palette query.");
  if (key === "\u0015") return replaceTopOverlay(state, { ...overlay, query: "", selected: 0 }, "Cleared Command Palette query.");
  if (key === "j" || key === "\x1b[B") return replaceTopOverlay(state, movePaletteSelection(state, overlay, 1), "Palette selection moved down.");
  if (key === "k" || key === "\x1b[A") return replaceTopOverlay(state, movePaletteSelection(state, overlay, -1), "Palette selection moved up.");
  if (key === "\r") {
    const command = paletteRows(state, overlay)[overlay.selected];
    if (!command) return markRedrawn({ ...state, lastAction: "No palette command selected." });
    if (!command.enabled(state)) return markRedrawn({ ...state, lastAction: `${command.label} disabled: ${command.disabledReason}` });
    return command.run(popOverlayRaw(state));
  }
  if (isPrintable(key)) return replaceTopOverlay(state, { ...overlay, query: `${overlay.query}${key}`, selected: 0 }, "Edited Command Palette query.");
  return state;
}

function reduceClearConfirmKey(state: PrototypeState, overlay: ClearConfirmOverlay, key: string): PrototypeState {
  if (key === "\x1b" || key === "q" || key === "n") return popOverlay(state, "Clear Queue cancelled; Queue and playback unchanged.");
  if (key === "h" || key === "l" || key === "\t" || key === "\x1b[D" || key === "\x1b[C") {
    return replaceTopOverlay(state, { ...overlay, choice: overlay.choice === "cancel" ? "clear" : "cancel" }, "Clear Queue confirmation choice changed.");
  }
  if (key === "y") return clearQueue(popOverlayRaw(state));
  if (key === "\r") return overlay.choice === "clear"
    ? clearQueue(popOverlayRaw(state))
    : popOverlay(state, "Clear Queue cancelled; Queue and playback unchanged.");
  return markRedrawn({ ...state, lastAction: `No confirmation action for ${describeKey(key)}.` });
}

function reduceYoutubeUrlKey(state: PrototypeState, overlay: YoutubeUrlOverlay, key: string): PrototypeState {
  if ((key === "\x1b" || key === "q") && overlay.status !== "editing") return popOverlay(state, "YouTube URL Download Flow hidden; background status remains in App State.");
  if (key === "\x1b") return popOverlay(state, "YouTube URL Download Flow dismissed; Queue Home context restored.");
  if (key === "\x7f" || key === "\b") return replaceTopOverlay(state, { ...overlay, input: overlay.input.slice(0, -1) }, "Edited YouTube URL.");
  if (key === "\r") {
    const downloaded: Track = {
      id: `youtube:download-${state.redraws}`,
      title: overlay.input.trim() ? "Downloaded YouTube Track" : "Downloaded Placeholder Track",
      artist: "Offline YouTube Cache",
      provider: "Offline YouTube Cache",
      album: "Cached Audio",
      duration: "4:00",
    };
    const next = applyPlayNext(state, [downloaded], "Downloaded URL into Offline YouTube Cache, then applied Play Next.");
    return replaceTopOverlay(next, { ...overlay, status: "done" }, "Downloaded URL into Offline YouTube Cache, then applied Play Next.");
  }
  if (isPrintable(key)) return replaceTopOverlay(state, { ...overlay, input: `${overlay.input}${key}` }, "Edited YouTube URL.");
  return state;
}

function openPicker(state: PrototypeState, focus: PickerFocus): PrototypeState {
  return pushOverlay(state, {
    kind: "picker",
    focus,
    mode: "provider",
    query: "",
    location: [],
    selected: 0,
    providerFilter: "All",
    resultTypeFilter: "All",
  }, focus === "search" ? "Music-finding Picker Overlay opened with search focused." : "Music-finding Picker Overlay opened at Provider root.");
}

function openSelectedPickerRow(state: PrototypeState, overlay: PickerOverlay, intent: "enter" | "inspect" | "play-now"): PrototypeState {
  const row = pickerRows(overlay)[overlay.selected];
  if (!row) return markRedrawn({ ...state, lastAction: "No Picker row selected." });
  if (row.disabledReason) return markRedrawn({ ...state, lastAction: `${row.label} disabled: ${row.disabledReason}` });

  if (intent === "play-now") {
    if (!row.tracks) return markRedrawn({ ...state, lastAction: `${row.label} is not playable with Play Now.` });
    return applyPlayNow(state, row.tracks, `Play Now applied to ${row.label}; playback started from beginning.`);
  }

  if (intent === "inspect" && row.path) {
    return replaceTopOverlay(state, normalizePickerSelection({ ...overlay, location: row.path, selected: 0 }), `Opened ${row.label} for inspection.`);
  }

  if (row.tracks && intent === "enter") {
    return applyPlayNext(state, row.tracks, `Play Next applied to ${row.label}; playback did not start.`);
  }

  if (row.path) {
    return replaceTopOverlay(state, normalizePickerSelection({ ...overlay, location: row.path, selected: 0 }), `Opened ${row.label}.`);
  }

  return markRedrawn({ ...state, lastAction: `${row.label} has no action in this context.` });
}

function providerNavigationRows(location: string[]): PickerRow[] {
  const [provider, section] = location;
  if (!provider) {
    return [
      { id: "local", label: "Local", detail: "folder navigation and searchable Tracks", kind: "provider", provider: "Local", path: ["local"] },
      { id: "navidrome", label: "Navidrome", detail: "Artists, Albums, Playlists, Tracks", kind: "provider", provider: "Navidrome", path: ["navidrome"] },
      { id: "offline", label: "Offline YouTube Cache", detail: "cached Tracks", kind: "provider", provider: "Offline YouTube Cache", path: ["offline"] },
      { id: "navidrome-status", label: "Navidrome offline example", detail: "visible with retry action", kind: "status", provider: "Navidrome", disabledReason: "server unreachable" },
    ];
  }

  if (provider === "local" && !section) {
    return [
      { id: "local-dir", label: "~/Music/Loose Files", detail: "Local Directory; opens, not queueable recursively", kind: "directory", provider: "Local", path: ["local", "loose-files"] },
      { id: "local-album", label: "Local Sketches", detail: "Album-like Music Collection from selected files", kind: "album", provider: "Local", tracks: LOCAL_SKETCHES, path: ["local", "loose-files"] },
      { id: CATALOG["local:basement"].id, label: "Basement Demo", detail: "Track", kind: "track", provider: "Local", tracks: [CATALOG["local:basement"]] },
    ];
  }

  if (provider === "local" && section === "loose-files") {
    return LOCAL_SKETCHES.map((track) => trackRow(track));
  }

  if (provider === "navidrome" && !section) {
    return [
      { id: "artist:asha", label: "Asha Mir", detail: "Artist; opens Albums, not directly queueable", kind: "artist", provider: "Navidrome", path: ["navidrome", "asha"] },
      { id: "album:night", label: "Night Signals", detail: "Album; Enter Play Next, l inspect", kind: "album", provider: "Navidrome", tracks: NIGHT_SIGNALS, path: ["navidrome", "night-signals"] },
      { id: "playlist:morning", label: "Morning Focus", detail: "Playlist; ordered Music Collection", kind: "playlist", provider: "Navidrome", tracks: MORNING_FOCUS, path: ["navidrome", "morning-focus"] },
      trackRow(CATALOG["navidrome:wire"]),
    ];
  }

  if (provider === "navidrome" && section === "asha") {
    return [
      { id: "album:night", label: "Night Signals", detail: "Album by Asha Mir", kind: "album", provider: "Navidrome", tracks: NIGHT_SIGNALS, path: ["navidrome", "night-signals"] },
    ];
  }

  if (provider === "navidrome" && (section === "night-signals" || section === "morning-focus")) {
    const tracks = section === "night-signals" ? NIGHT_SIGNALS : MORNING_FOCUS;
    return tracks.map((track) => trackRow(track));
  }

  if (provider === "offline") {
    return [
      trackRow(CATALOG["youtube:lecture"]),
      trackRow(CATALOG["youtube:unavailable"]),
    ];
  }

  return [];
}

function globalSearchRows(overlay: PickerOverlay): PickerRow[] {
  const query = overlay.query.trim() || "all";
  const rows: PickerRow[] = [
    { id: "group-tracks-local", label: "Tracks - Local", detail: `Provider ranking for "${query}"`, kind: "group" },
    trackRow(CATALOG["local:basement"]),
    { id: "group-tracks-navidrome", label: "Tracks - Navidrome", detail: `Provider ranking for "${query}"`, kind: "group" },
    trackRow(CATALOG["navidrome:moon"]),
    trackRow(CATALOG["navidrome:wire"]),
    { id: "group-albums", label: "Albums - Navidrome", detail: "Music Collections resolve lazily", kind: "group" },
    { id: "album:night", label: "Night Signals", detail: "Album; Enter Play Next, l inspect", kind: "album", provider: "Navidrome", tracks: NIGHT_SIGNALS, path: ["navidrome", "night-signals"] },
    { id: "group-playlists", label: "Playlists - Navidrome", detail: "Music Collections resolve atomically", kind: "group" },
    { id: "playlist:morning", label: "Morning Focus", detail: "Playlist", kind: "playlist", provider: "Navidrome", tracks: MORNING_FOCUS, path: ["navidrome", "morning-focus"] },
    { id: "group-artists", label: "Artists - Navidrome", detail: "navigation only", kind: "group" },
    { id: "artist:asha", label: "Asha Mir", detail: "Artist; opens Albums", kind: "artist", provider: "Navidrome", path: ["navidrome", "asha"] },
    { id: "status-offline", label: "Offline YouTube Cache", detail: "no matching cached Tracks", kind: "status", provider: "Offline YouTube Cache", disabledReason: "no matches" },
  ];

  return rows.filter((row) => {
    if (overlay.providerFilter !== "All" && row.provider && row.provider !== overlay.providerFilter) return false;
    if (overlay.resultTypeFilter === "Tracks" && row.kind !== "track" && row.kind !== "group") return false;
    if (overlay.resultTypeFilter === "Albums" && row.kind !== "album" && row.kind !== "group") return false;
    if (overlay.resultTypeFilter === "Playlists" && row.kind !== "playlist" && row.kind !== "group") return false;
    return true;
  });
}

function trackRow(track: Track): PickerRow {
  return {
    id: track.id,
    label: track.title,
    detail: `${track.artist} - ${track.provider}${track.availability ? ` - unavailable: ${track.availability}` : ""}`,
    kind: "track",
    provider: track.provider,
    tracks: [track],
    disabledReason: track.availability,
  };
}

function applyPlayNext(state: PrototypeState, tracks: Track[], lastAction: string): PrototypeState {
  const currentId = state.currentTrackId;
  const block = dedupeTracks(tracks).filter((track) => track.id !== currentId);
  const blockIds = new Set(block.map((track) => track.id));
  const queue = state.queue.filter((entry) => !blockIds.has(entry.track.id));
  const currentIndex = currentId ? queue.findIndex((entry) => entry.track.id === currentId) : -1;
  const insertIndex = currentIndex === -1 ? 0 : currentIndex + 1;
  queue.splice(insertIndex, 0, ...block.map((track) => ({ track })));
  const selectedId = block[0]?.id ?? selectedQueueEntry(state)?.track.id;
  return markRedrawn({
    ...state,
    queue,
    selectedQueueIndex: indexForTrack(queue, selectedId),
    lastAction,
  });
}

function applyPlayNow(state: PrototypeState, tracks: Track[], lastAction: string): PrototypeState {
  const block = dedupeTracks(tracks);
  if (block.length === 0) return markRedrawn({ ...state, lastAction: "Play Now had no playable Tracks." });
  const blockIds = new Set(block.map((track) => track.id));
  const formerCurrentId = state.currentTrackId;
  const queue = state.queue.filter((entry) => !blockIds.has(entry.track.id));
  const formerCurrentIndex = formerCurrentId && !blockIds.has(formerCurrentId)
    ? queue.findIndex((entry) => entry.track.id === formerCurrentId)
    : -1;
  const insertIndex = formerCurrentIndex === -1 ? 0 : formerCurrentIndex + 1;
  queue.splice(insertIndex, 0, ...block.map((track) => ({ track })));
  return markRedrawn({
    ...state,
    queue,
    currentTrackId: block[0].id,
    selectedQueueIndex: indexForTrack(queue, block[0].id),
    playback: "playing",
    playbackPosition: "0:00",
    lastAction,
  });
}

function playNextSelectedQueueTrack(state: PrototypeState): PrototypeState {
  const selected = selectedQueueEntry(state)?.track;
  if (!selected) return markRedrawn({ ...state, lastAction: "Queue is empty; Play Next did nothing." });
  if (selected.availability) return markRedrawn({ ...state, lastAction: `Play Next failed: ${selected.title} is unavailable (${selected.availability}).` });
  return applyPlayNext(state, [selected], `Play Next moved ${selected.title} immediately after Current Track; playback did not start.`);
}

function playNowSelectedQueueTrack(state: PrototypeState): PrototypeState {
  const selected = selectedQueueEntry(state)?.track;
  if (!selected) return markRedrawn({ ...state, lastAction: "Queue is empty; Play Now did nothing." });
  if (selected.availability) return markRedrawn({ ...state, lastAction: `Play Now failed on requested Track; no substitution (${selected.availability}).` });
  return applyPlayNow(state, [selected], `Play Now started ${selected.title} from the beginning.`);
}

function togglePlayback(state: PrototypeState): PrototypeState {
  const current = currentTrack(state);
  if (!current) {
    const selected = selectedQueueEntry(state)?.track;
    if (!selected) return markRedrawn({ ...state, lastAction: "No Current Track or selection to play." });
    if (selected.availability) return markRedrawn({ ...state, lastAction: `Selected Track is unavailable: ${selected.availability}.` });
    return markRedrawn({
      ...state,
      currentTrackId: selected.id,
      playback: "playing",
      playbackPosition: "0:00",
      lastAction: `No Current Track existed; Play started selected Track ${selected.title}.`,
    });
  }

  if (current.availability) return markRedrawn({ ...state, lastAction: `Resume failed on Current Track; no substitution (${current.availability}).` });
  if (state.playback === "playing") return markRedrawn({ ...state, playback: "paused", lastAction: `Paused ${current.title}; position preserved.` });
  if (state.playback === "restored") return markRedrawn({ ...state, playback: "playing", lastAction: `Explicit Resume started ${current.title} at ${state.playbackPosition}.` });
  if (state.playback === "stopped") return markRedrawn({ ...state, playback: "playing", playbackPosition: "0:00", lastAction: `Started stopped Current Track ${current.title} from the beginning.` });
  return markRedrawn({ ...state, playback: "playing", lastAction: `Resumed ${current.title}.` });
}

function stopPlayback(state: PrototypeState): PrototypeState {
  const current = currentTrack(state);
  return markRedrawn({
    ...state,
    playback: "stopped",
    playbackPosition: "0:00",
    lastAction: current ? `Stopped ${current.title}; Current Track retained at 0:00.` : "Stop retained empty playback state.",
  });
}

function nextTrack(state: PrototypeState): PrototypeState {
  if (state.queue.length === 0) return markRedrawn({ ...state, lastAction: "Queue is empty; Next did nothing." });
  const currentIndex = currentIndexInQueue(state);
  for (let offset = 1; offset <= state.queue.length; offset += 1) {
    const index = (currentIndex + offset) % state.queue.length;
    const track = state.queue[index]?.track;
    if (!track) break;
    if (!track.availability) {
      return markRedrawn({
        ...state,
        currentTrackId: track.id,
        selectedQueueIndex: index,
        playback: "playing",
        playbackPosition: "0:00",
        lastAction: `Advanced to next playable Track ${track.title}; unavailable candidates were skipped.`,
      });
    }
    if (!state.repeatAll && index <= currentIndex) break;
  }
  return markRedrawn({ ...state, playback: "stopped", playbackPosition: "0:00", lastAction: "No next playable Track; retained Current Track and stopped." });
}

function previousTrack(state: PrototypeState): PrototypeState {
  const currentIndex = currentIndexInQueue(state);
  if (state.playbackPosition !== "0:00") {
    return markRedrawn({ ...state, playbackPosition: "0:00", lastAction: "Previous restarted Current Track because position was past the threshold." });
  }
  const previousIndex = Math.max(0, currentIndex - 1);
  const previous = state.queue[previousIndex]?.track;
  if (!previous || previous.availability) return markRedrawn({ ...state, playbackPosition: "0:00", lastAction: "Previous stayed on Current Track." });
  return markRedrawn({
    ...state,
    currentTrackId: previous.id,
    selectedQueueIndex: previousIndex,
    playback: "playing",
    playbackPosition: "0:00",
    lastAction: `Previous started ${previous.title}.`,
  });
}

function moveQueueEntry(state: PrototypeState, delta: number): PrototypeState {
  const from = state.selectedQueueIndex;
  const to = clamp(from + delta, 0, state.queue.length - 1);
  if (from === to) return markRedrawn({ ...state, lastAction: "Queue row already at boundary." });
  const queue = [...state.queue];
  const [entry] = queue.splice(from, 1);
  if (!entry) return state;
  queue.splice(to, 0, entry);
  return markRedrawn({
    ...state,
    queue,
    selectedQueueIndex: indexForTrack(queue, entry.track.id),
    lastAction: `Moved ${entry.track.title}; selection followed Track Identity and playback was uninterrupted.`,
  });
}

function removeSelectedQueueEntry(state: PrototypeState): PrototypeState {
  const selected = selectedQueueEntry(state);
  if (!selected) return markRedrawn({ ...state, lastAction: "Queue is empty; nothing removed." });
  const queue = state.queue.filter((entry) => entry.track.id !== selected.track.id);
  const removedCurrent = selected.track.id === state.currentTrackId;
  return markRedrawn({
    ...state,
    queue,
    selectedQueueIndex: clamp(state.selectedQueueIndex, 0, queue.length - 1),
    currentTrackId: removedCurrent ? null : state.currentTrackId,
    playback: removedCurrent ? "stopped" : state.playback,
    playbackPosition: removedCurrent ? "0:00" : state.playbackPosition,
    lastAction: removedCurrent
      ? `Removed Current Track ${selected.track.title}; playback stopped and did not auto-advance.`
      : `Removed ${selected.track.title}.`,
  });
}

function clearQueue(state: PrototypeState): PrototypeState {
  return markRedrawn({
    ...state,
    queue: [],
    selectedQueueIndex: 0,
    currentTrackId: null,
    playback: "stopped",
    playbackPosition: "0:00",
    lastAction: "Clear Queue confirmed; playback stopped, Current Track cleared, Queue emptied.",
  });
}

function toggleShuffle(state: PrototypeState): PrototypeState {
  if (state.shuffle) return markRedrawn({ ...state, shuffle: false, lastAction: "Shuffle disabled; visible Queue order retained." });
  const currentIndex = currentIndexInQueue(state);
  const before = state.queue.slice(0, currentIndex + 1);
  const after = [...state.queue.slice(currentIndex + 1)].reverse();
  return markRedrawn({
    ...state,
    shuffle: true,
    queue: [...before, ...after],
    selectedQueueIndex: indexForTrack([...before, ...after], selectedQueueEntry(state)?.track.id),
    lastAction: "Shuffle visibly randomized only Tracks after Current Track.",
  });
}

function setVolume(state: PrototypeState, delta: number): PrototypeState {
  const volume = clamp(state.volume + delta, 0, 100);
  return markRedrawn({ ...state, volume, lastAction: `Volume set to ${volume}%.` });
}

function moveSelection(state: PrototypeState, delta: number | "first" | "last"): PrototypeState {
  const index = delta === "first"
    ? 0
    : delta === "last"
      ? state.queue.length - 1
      : clamp(state.selectedQueueIndex + delta, 0, state.queue.length - 1);
  const track = state.queue[index]?.track;
  return markRedrawn({
    ...state,
    selectedQueueIndex: Math.max(0, index),
    lastAction: track ? `Queue selection moved to ${track.title}.` : "Queue is empty; no row selected.",
  });
}

function pushOverlay(state: PrototypeState, overlay: Overlay, lastAction: string): PrototypeState {
  return markRedrawn({ ...state, overlays: [...state.overlays, overlay], lastAction });
}

function popOverlay(state: PrototypeState, lastAction: string): PrototypeState {
  return markRedrawn({ ...popOverlayRaw(state), lastAction });
}

function popOverlayRaw(state: PrototypeState): PrototypeState {
  return { ...state, overlays: state.overlays.slice(0, -1) };
}

function replaceTopOverlay<T extends Overlay>(state: PrototypeState, overlay: T, lastAction: string): PrototypeState {
  return markRedrawn({
    ...state,
    overlays: [...state.overlays.slice(0, -1), overlay],
    lastAction,
  });
}

function movePickerSelection(overlay: PickerOverlay, delta: number): PickerOverlay {
  return { ...overlay, selected: clamp(overlay.selected + delta, 0, pickerRows(overlay).length - 1) };
}

function moveHelpSelection(state: PrototypeState, overlay: HelpOverlay, delta: number): HelpOverlay {
  return { ...overlay, selected: clamp(overlay.selected + delta, 0, helpRows(state, overlay).length - 1) };
}

function movePaletteSelection(state: PrototypeState, overlay: PaletteOverlay, delta: number): PaletteOverlay {
  return { ...overlay, selected: clamp(overlay.selected + delta, 0, paletteRows(state, overlay).length - 1) };
}

function parentPickerLocation(overlay: PickerOverlay): PickerOverlay {
  if (overlay.mode === "search") return normalizePickerSelection({ ...overlay, mode: "provider", query: "", location: [], selected: 0 });
  return normalizePickerSelection({ ...overlay, location: overlay.location.slice(0, -1), selected: 0 });
}

function normalizePickerSelection(overlay: PickerOverlay): PickerOverlay {
  return { ...overlay, selected: clamp(overlay.selected, 0, pickerRows(overlay).length - 1) };
}

function cycleProviderFilter(overlay: PickerOverlay): PickerOverlay {
  const filters: PickerOverlay["providerFilter"][] = ["All", "Local", "Navidrome", "Offline YouTube Cache"];
  const next = filters[(filters.indexOf(overlay.providerFilter) + 1) % filters.length] ?? "All";
  return normalizePickerSelection({ ...overlay, providerFilter: next, selected: 0 });
}

function commands(): Command[] {
  return [
    {
      id: "open-picker",
      label: "Open music finder",
      keys: "o",
      context: "queue",
      enabled: () => true,
      disabledReason: "",
      run: (state) => openPicker(state, "results"),
    },
    {
      id: "search",
      label: "Search all Providers",
      keys: "/",
      context: "queue",
      enabled: () => true,
      disabledReason: "",
      run: (state) => openPicker(state, "search"),
    },
    {
      id: "play-now",
      label: "Play Now selected Track",
      keys: "S-Enter/P",
      context: "queue",
      enabled: (state) => Boolean(selectedQueueEntry(state)),
      disabledReason: "Queue has no selected Track",
      run: playNowSelectedQueueTrack,
    },
    {
      id: "clear",
      label: "Clear Queue",
      keys: "c",
      context: "queue",
      enabled: (state) => state.queue.length > 0,
      disabledReason: "Queue is already empty",
      run: (state) => pushOverlay(state, { kind: "clear-confirm", choice: "cancel" }, "Clear Queue confirmation opened from Command Palette."),
    },
    {
      id: "repeat",
      label: "Toggle Repeat All",
      keys: "palette only",
      context: "global",
      enabled: () => true,
      disabledReason: "",
      run: (state) => markRedrawn({ ...state, repeatAll: !state.repeatAll, lastAction: `Repeat All ${state.repeatAll ? "disabled" : "enabled"} from Command Palette.` }),
    },
  ];
}

function dedupeTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    if (track.availability) return false;
    if (seen.has(track.id)) return false;
    seen.add(track.id);
    return true;
  });
}

function currentIndexInQueue(state: PrototypeState): number {
  if (!state.currentTrackId) return state.selectedQueueIndex;
  const index = state.queue.findIndex((entry) => entry.track.id === state.currentTrackId);
  return index === -1 ? state.selectedQueueIndex : index;
}

function indexForTrack(queue: QueueEntry[], trackId: string | undefined): number {
  if (!trackId) return 0;
  const index = queue.findIndex((entry) => entry.track.id === trackId);
  return index === -1 ? 0 : index;
}

function pageSize(state: PrototypeState): number {
  return Math.max(3, Math.floor(state.terminal.rows / 2));
}

function markRedrawn(state: PrototypeState): PrototypeState {
  return { ...state, redraws: state.redraws + 1 };
}

function tierForColumns(columns: number): TerminalTier {
  if (columns >= 112) return "wide";
  if (columns >= 78) return "medium";
  return "narrow";
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function isPrintable(key: string): boolean {
  return key.length === 1 && key >= " " && key !== "\x7f";
}

function describeKey(key: string): string {
  if (key === "\r") return "Enter";
  if (key === "\x1b") return "Esc";
  if (key === " ") return "Space";
  if (key === "\t") return "Tab";
  return JSON.stringify(key);
}
