#!/usr/bin/env bun
// PROTOTYPE - Three terminal navigation variants switchable with `v`.

type Variant = "A" | "B" | "C";
type Focus = "sources" | "content" | "queue";
type SourceId = "local" | "navidrome" | "cache" | "youtube-url" | "queue";

type Track = {
  id: string;
  source: SourceId;
  title: string;
  detail: string;
  duration: string;
};

type Source = {
  id: SourceId;
  label: string;
  hint: string;
};

type State = {
  variant: Variant;
  focus: Focus;
  sourceIndex: number;
  contentIndex: number;
  queueIndex: number;
  queue: Track[];
  currentIndex: number;
  playing: boolean;
  startup: "empty" | "cli-seeded";
  lastEvent: string;
  renders: number;
};

const sources: Source[] = [
  { id: "local", label: "Local", hint: "files and folders" },
  { id: "navidrome", label: "Navidrome", hint: "artists, albums, playlists" },
  { id: "cache", label: "Offline Cache", hint: "downloaded YouTube audio" },
  { id: "youtube-url", label: "YouTube URL", hint: "download then enqueue" },
  { id: "queue", label: "Queue", hint: "shared playback queue" },
];

const catalog: Record<SourceId, Track[]> = {
  local: [
    { id: "local:/music/amber.flac", source: "local", title: "Amber Path", detail: "~/Music/Aster", duration: "3:25" },
    { id: "local:/music/cinder.mp3", source: "local", title: "Cinder Room", detail: "~/Music/West Pier", duration: "4:02" },
    { id: "local:/music/folder", source: "local", title: "Open folder...", detail: "expand files into queue", duration: "--" },
  ],
  navidrome: [
    { id: "nav:https://music.example:song-101", source: "navidrome", title: "Northbound", detail: "Mira Vale - Remote album", duration: "3:18" },
    { id: "nav:https://music.example:song-102", source: "navidrome", title: "Station Light", detail: "Signal Club - Artist browse", duration: "4:36" },
    { id: "nav:https://music.example:playlist-5", source: "navidrome", title: "Open playlists", detail: "read-only playlists", duration: "--" },
  ],
  cache: [
    { id: "youtube:late-upload", source: "cache", title: "Late Upload", detail: "youtube:late-upload", duration: "3:51" },
    { id: "youtube:offline-copy", source: "cache", title: "Offline Copy", detail: "youtube:offline-copy", duration: "3:04" },
  ],
  "youtube-url": [
    { id: "download:url", source: "youtube-url", title: "Paste URL...", detail: "yt-dlp download into Offline Cache", duration: "--" },
    { id: "download:recent", source: "youtube-url", title: "Retry last failed URL", detail: "visible failure stays in queue", duration: "--" },
  ],
  queue: [],
};

function createState(seedArgs: string[]): State {
  const seeded = seedArgs.map((path, index) => ({
    id: `local:${path}`,
    source: "local" as const,
    title: path.split("/").pop() || `CLI track ${index + 1}`,
    detail: path,
    duration: "--",
  }));
  return {
    variant: "A",
    focus: seedArgs.length ? "queue" : "sources",
    sourceIndex: seedArgs.length ? 4 : 0,
    contentIndex: 0,
    queueIndex: 0,
    queue: seeded,
    currentIndex: seedArgs.length ? 0 : -1,
    playing: seedArgs.length > 0,
    startup: seedArgs.length ? "cli-seeded" : "empty",
    lastEvent: seedArgs.length ? "CLI args seeded the shared queue" : "opened source switcher",
    renders: 0,
  };
}

function selectedSource(state: State): Source {
  return sources[state.sourceIndex] ?? sources[0];
}

function visibleItems(state: State): Track[] {
  const source = selectedSource(state);
  return source.id === "queue" ? state.queue : catalog[source.id];
}

function currentTrack(state: State): Track | undefined {
  return state.currentIndex >= 0 ? state.queue[state.currentIndex] : undefined;
}

function clean(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}.` : text.padEnd(width);
}

function line(label: string, active: boolean, focused: boolean): string {
  const cursor = active ? ">" : " ";
  const mark = active && focused ? "*" : " ";
  return `${cursor}${mark} ${label}`;
}

function sourceList(state: State, width = 23): string {
  return sources
    .map((source, index) => {
      const active = index === state.sourceIndex;
      return line(clean(`${index + 1} ${source.label}`, width), active, state.focus === "sources");
    })
    .join("\n");
}

function contentList(state: State, width = 48): string {
  const items = visibleItems(state);
  if (selectedSource(state).id === "queue" && items.length === 0) {
    return "   Queue is empty. Add from Local, Navidrome, Offline Cache, or YouTube URL.";
  }
  return items
    .map((item, index) => {
      const active = index === (selectedSource(state).id === "queue" ? state.queueIndex : state.contentIndex);
      return line(clean(`${item.title}  ${item.duration}  ${item.detail}`, width), active, state.focus === "content" || (state.focus === "queue" && selectedSource(state).id === "queue"));
    })
    .join("\n");
}

function queueList(state: State, width = 44): string {
  if (state.queue.length === 0) return "   Empty queue";
  return state.queue
    .map((track, index) => {
      const current = index === state.currentIndex ? (state.playing ? "playing" : "paused") : "queued";
      return line(clean(`${track.title} [${current}]`, width), index === state.queueIndex, state.focus === "queue");
    })
    .join("\n");
}

function twoColumns(left: string, right: string, leftWidth: number): string {
  const leftRows = left.split("\n");
  const rightRows = right.split("\n");
  const rows = [];
  for (let index = 0; index < Math.max(leftRows.length, rightRows.length); index += 1) {
    rows.push(`${(leftRows[index] ?? "").padEnd(leftWidth)}${rightRows[index] ?? ""}`);
  }
  return rows.join("\n");
}

function nowPlaying(state: State): string {
  const current = currentTrack(state);
  if (!current) return "Idle - add a Track to the shared Queue";
  return `${state.playing ? "Playing" : "Paused "} ${current.title} (${current.source})`;
}

function renderVariantA(state: State): string {
  return [
    "Variant A - Source rail with persistent queue strip",
    "Sources                  Provider Browsing Surface",
    "----------------------   ------------------------------------------------",
    twoColumns(sourceList(state), contentList(state), 25),
    "",
    "Queue / Player",
    "--------------",
    nowPlaying(state),
    queueList(state),
  ].join("\n");
}

function renderVariantB(state: State): string {
  const tabs = sources.map((source, index) => `${index === state.sourceIndex ? "[" : " "}${index + 1}:${source.label}${index === state.sourceIndex ? "]" : " "}`).join(" ");
  return [
    "Variant B - Queue-first shell",
    nowPlaying(state),
    "",
    "Shared Queue",
    "------------",
    queueList(state, 72),
    "",
    "Sources",
    tabs,
    "",
    `${selectedSource(state).label}: ${selectedSource(state).hint}`,
    contentList(state, 72),
  ].join("\n");
}

function renderVariantC(state: State): string {
  const commands = sources
    .map((source, index) => line(`${index + 1} ${source.label} - ${source.hint}`, index === state.sourceIndex, state.focus === "sources"))
    .join("\n");
  return [
    "Variant C - Command palette shell",
    nowPlaying(state),
    "",
    "Commands",
    "--------",
    commands,
    "",
    "Selected Surface",
    "----------------",
    contentList(state, 72),
    "",
    "Queue",
    "-----",
    queueList(state, 72),
  ].join("\n");
}

function render(state: State): string {
  state.renders += 1;
  const body = state.variant === "A" ? renderVariantA(state) : state.variant === "B" ? renderVariantB(state) : renderVariantC(state);
  return [
    "\x1b[2J\x1b[H",
    "TMU source switcher/navigation prototype",
    `startup: ${state.startup} | focus: ${state.focus} | renders: ${state.renders}`,
    "",
    body,
    "",
    `last: ${state.lastEvent}`,
    "keys: v variant | 1-5 source/queue | tab focus | arrows move | enter/a add/start | p play | n next | q quit",
  ].join("\n");
}

function clamp(value: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, value));
}

function selectedItem(state: State): Track | undefined {
  const items = visibleItems(state);
  return items[clamp(selectedSource(state).id === "queue" ? state.queueIndex : state.contentIndex, items.length)];
}

function addSelected(state: State): void {
  const source = selectedSource(state);
  if (source.id === "queue") {
    if (state.queue.length) {
      state.currentIndex = state.queueIndex;
      state.playing = true;
      state.lastEvent = `started ${state.queue[state.queueIndex]?.title}`;
    }
    return;
  }
  const item = selectedItem(state);
  if (!item) return;
  if (source.id === "youtube-url") {
    state.lastEvent = "would open YouTube URL prompt, download into Offline Cache, then enqueue";
    return;
  }
  if (state.queue.some((track) => track.id === item.id)) {
    state.lastEvent = `deduped ${item.title}`;
    return;
  }
  state.queue.push(item);
  state.queueIndex = state.queue.length - 1;
  if (state.currentIndex === -1) {
    state.currentIndex = 0;
    state.playing = true;
  }
  state.lastEvent = `added ${item.title} to shared Queue`;
}

function handleKey(state: State, key: string): boolean {
  if (key === "q" || key === "\u0003") return false;
  if (key === "v") {
    state.variant = state.variant === "A" ? "B" : state.variant === "B" ? "C" : "A";
    state.lastEvent = `variant ${state.variant}`;
  } else if (/^[1-5]$/.test(key)) {
    state.sourceIndex = Number(key) - 1;
    state.focus = state.sourceIndex === 4 ? "queue" : "content";
    state.contentIndex = 0;
    state.lastEvent = `switched to ${selectedSource(state).label}`;
  } else if (key === "\t") {
    state.focus = state.focus === "sources" ? "content" : state.focus === "content" ? "queue" : "sources";
    state.lastEvent = `focus ${state.focus}`;
  } else if (key === "\x1b[A" || key === "\x1b[D") {
    move(state, -1);
  } else if (key === "\x1b[B" || key === "\x1b[C") {
    move(state, 1);
  } else if (key === "\r" || key === "a") {
    addSelected(state);
  } else if (key === "p") {
    state.playing = !state.playing;
    state.lastEvent = state.playing ? "resumed" : "paused";
  } else if (key === "n") {
    if (state.queue.length) {
      state.currentIndex = (Math.max(0, state.currentIndex) + 1) % state.queue.length;
      state.queueIndex = state.currentIndex;
      state.playing = true;
      state.lastEvent = `advanced to ${state.queue[state.currentIndex]?.title}`;
    }
  }
  return true;
}

function splitKeys(data: Buffer): string[] {
  const raw = data.toString("utf8");
  if (raw.startsWith("\x1b[")) return [raw];
  return [...raw];
}

function move(state: State, delta: number): void {
  if (state.focus === "sources") {
    state.sourceIndex = clamp(state.sourceIndex + delta, sources.length);
    state.contentIndex = 0;
    state.lastEvent = `selected ${selectedSource(state).label}`;
  } else if (state.focus === "queue" || selectedSource(state).id === "queue") {
    state.queueIndex = clamp(state.queueIndex + delta, state.queue.length);
    state.lastEvent = "moved queue selection";
  } else {
    state.contentIndex = clamp(state.contentIndex + delta, visibleItems(state).length);
    state.lastEvent = "moved provider selection";
  }
}

function parseSeedArgs(): string[] {
  const seedIndex = Bun.argv.indexOf("--seed");
  if (seedIndex === -1) return [];
  return Bun.argv.slice(seedIndex + 1).filter((arg) => !arg.startsWith("--"));
}

function runSnapshot(): void {
  const states = [createState([]), createState(["./song-a.flac", "./song-b.mp3"])];
  for (const state of states) {
    for (const variant of ["A", "B", "C"] as const) {
      state.variant = variant;
      console.log(render(state).replaceAll("\x1b[2J\x1b[H", ""));
      console.log("\n---\n");
    }
  }
}

function runInteractive(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Interactive mode needs a TTY. Use --snapshot in non-interactive shells.");
    process.exit(1);
  }
  const state = createState(parseSeedArgs());
  const draw = () => process.stdout.write(render(state));
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    for (const key of splitKeys(data)) {
      if (!handleKey(state, key)) {
        process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
        process.stdin.setRawMode(false);
        process.exit(0);
      }
    }
    draw();
  });
  process.stdout.write("\x1b[?25l");
  draw();
}

if (Bun.argv.includes("--snapshot")) {
  runSnapshot();
} else {
  runInteractive();
}
