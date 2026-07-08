#!/usr/bin/env bun
// PROTOTYPE - wipe after the low-power TUI render decision is captured.

type Focus = "sources" | "tracks" | "queue";

type Track = {
  id: string;
  source: "Local" | "Navidrome" | "YouTube Cache";
  title: string;
  artist: string;
  duration: number;
};

type AppState = {
  focus: Focus;
  sourceIndex: number;
  trackIndex: number;
  queueIndex: number;
  playing: boolean;
  currentIndex: number;
  position: number;
  positionTicks: boolean;
  renderCount: number;
  lastEvent: string;
};

type RenderSink = {
  write(chunk: string): void;
};

const sources = ["Local", "Navidrome", "YouTube Cache", "YouTube URL"];

const tracks: Track[] = [
  { id: "local-01", source: "Local", title: "Amber Path", artist: "Aster", duration: 205 },
  { id: "local-02", source: "Local", title: "Cinder Room", artist: "West Pier", duration: 242 },
  { id: "nav-01", source: "Navidrome", title: "Northbound", artist: "Mira Vale", duration: 198 },
  { id: "nav-02", source: "Navidrome", title: "Station Light", artist: "Signal Club", duration: 276 },
  { id: "cache-01", source: "YouTube Cache", title: "Late Upload", artist: "Mirror Set", duration: 231 },
  { id: "cache-02", source: "YouTube Cache", title: "Offline Copy", artist: "Rill", duration: 184 },
];

const initialQueue = [tracks[0], tracks[2], tracks[4]];

function createState(): AppState {
  return {
    focus: "sources",
    sourceIndex: 0,
    trackIndex: 0,
    queueIndex: 0,
    playing: true,
    currentIndex: 0,
    position: 34,
    positionTicks: true,
    renderCount: 0,
    lastEvent: "started",
  };
}

function visibleTracks(state: AppState): Track[] {
  const source = sources[state.sourceIndex];
  if (source === "YouTube URL") return [];
  return tracks.filter((track) => track.source === source);
}

function currentTrack(state: AppState): Track {
  return initialQueue[state.currentIndex] ?? initialQueue[0];
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${rest}`;
}

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, value));
}

function progressBar(position: number, duration: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((position / duration) * width)));
  return `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
}

function row(label: string, active: boolean, focused: boolean): string {
  const cursor = active ? ">" : " ";
  const marker = focused && active ? "*" : " ";
  return `${cursor}${marker} ${label}`;
}

function render(state: AppState): string {
  state.renderCount += 1;
  const list = visibleTracks(state);
  const selectedTrack = list[clampIndex(state.trackIndex, list.length)];
  const now = currentTrack(state);
  const sourceLines = sources
    .map((source, index) => row(source, index === state.sourceIndex, state.focus === "sources"))
    .join("\n");
  const trackLines = list.length
    ? list
        .map((track, index) =>
          row(`${track.title} - ${track.artist} ${formatTime(track.duration)}`, index === state.trackIndex, state.focus === "tracks"),
        )
        .join("\n")
    : "   Paste URL action lives here later";
  const queueLines = initialQueue
    .map((track, index) => {
      const status = index === state.currentIndex ? (state.playing ? "playing" : "paused") : "queued";
      return row(`${track.title} - ${track.artist} [${status}]`, index === state.queueIndex, state.focus === "queue");
    })
    .join("\n");
  const actionHint = selectedTrack
    ? `enter: enqueue ${selectedTrack.title}`
    : "enter: open URL download prompt later";

  return [
    "\x1b[2J\x1b[H",
    "TMU low-power TUI prototype",
    "render: event/state changes + optional 500ms playback-position tick",
    "",
    "Sources                    Tracks",
    "----------------------     -----------------------------------------",
    twoColumns(sourceLines, trackLines, 25),
    "",
    "Current",
    "-------",
    `${state.playing ? "Playing" : "Paused "} ${now.title} - ${now.artist}`,
    `[${progressBar(state.position, now.duration, 34)}] ${formatTime(state.position)} / ${formatTime(now.duration)}`,
    "",
    "Queue",
    "-----",
    queueLines,
    "",
    `Focus: ${state.focus} | ticks: ${state.positionTicks ? "on" : "off"} | renders: ${state.renderCount} | last: ${state.lastEvent}`,
    `${actionHint} | tab/arrows/space/n/t/q`,
  ].join("\n");
}

function twoColumns(left: string, right: string, leftWidth: number): string {
  const leftRows = left.split("\n");
  const rightRows = right.split("\n");
  const count = Math.max(leftRows.length, rightRows.length);
  const rows: string[] = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(`${(leftRows[index] ?? "").padEnd(leftWidth)}${rightRows[index] ?? ""}`);
  }
  return rows.join("\n");
}

function moveSelection(state: AppState, delta: number): void {
  if (state.focus === "sources") {
    state.sourceIndex = clampIndex(state.sourceIndex + delta, sources.length);
    state.trackIndex = 0;
  } else if (state.focus === "tracks") {
    state.trackIndex = clampIndex(state.trackIndex + delta, visibleTracks(state).length);
  } else {
    state.queueIndex = clampIndex(state.queueIndex + delta, initialQueue.length);
  }
}

function handleKey(state: AppState, data: Buffer): boolean {
  const key = data.toString("utf8");
  if (key === "q" || key === "\u0003") return false;
  if (key === "\t") {
    state.focus = state.focus === "sources" ? "tracks" : state.focus === "tracks" ? "queue" : "sources";
    state.lastEvent = "focus changed";
  } else if (key === "\x1b[A" || key === "\x1b[D") {
    moveSelection(state, -1);
    state.lastEvent = "selection up";
  } else if (key === "\x1b[B" || key === "\x1b[C") {
    moveSelection(state, 1);
    state.lastEvent = "selection down";
  } else if (key === " ") {
    state.playing = !state.playing;
    state.lastEvent = state.playing ? "resumed" : "paused";
  } else if (key === "n") {
    state.currentIndex = (state.currentIndex + 1) % initialQueue.length;
    state.position = 0;
    state.playing = true;
    state.lastEvent = "next track";
  } else if (key === "t") {
    state.positionTicks = !state.positionTicks;
    state.lastEvent = state.positionTicks ? "ticks enabled" : "ticks disabled";
  } else if (key === "\r") {
    if (state.focus === "queue") {
      state.currentIndex = state.queueIndex;
      state.position = 0;
      state.playing = true;
      state.lastEvent = "queue item started";
    } else {
      const track = visibleTracks(state)[state.trackIndex];
      state.lastEvent = track ? `would enqueue ${track.title}` : "would open URL prompt";
    }
  }
  return true;
}

function runInteractive(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Interactive mode needs a TTY. Use --bench in non-interactive shells.");
    process.exit(1);
  }

  const state = createState();
  const draw = () => process.stdout.write(render(state));
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (data) => {
    if (!handleKey(state, data)) {
      process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
      process.stdin.setRawMode(false);
      process.exit(0);
    }
    draw();
  });

  setInterval(() => {
    if (!state.positionTicks || !state.playing) return;
    const track = currentTrack(state);
    state.position += 0.5;
    if (state.position >= track.duration) {
      state.currentIndex = (state.currentIndex + 1) % initialQueue.length;
      state.position = 0;
    }
    state.lastEvent = "position tick";
    draw();
  }, 500).unref();

  process.stdout.write("\x1b[?25l");
  draw();
}

type BenchResult = {
  name: string;
  wallMs: number;
  cpuMs: number;
  cpuPercent: number;
  renders: number;
  bytes: number;
};

class CountingSink implements RenderSink {
  bytes = 0;

  write(chunk: string): void {
    this.bytes += Buffer.byteLength(chunk);
  }
}

async function benchScenario(name: string, tickMs: number | null, durationMs: number): Promise<BenchResult> {
  const state = createState();
  state.positionTicks = tickMs !== null;
  const sink = new CountingSink();
  const startedAt = performance.now();
  const cpuStart = process.cpuUsage();

  sink.write(render(state));
  if (tickMs === null) {
    await Bun.sleep(durationMs);
  } else {
    let nextTick = tickMs;
    while (performance.now() - startedAt < durationMs) {
      await Bun.sleep(Math.max(0, nextTick - (performance.now() - startedAt)));
      state.position += (tickMs ?? 0) / 1000;
      state.lastEvent = "bench tick";
      sink.write(render(state));
      nextTick += tickMs;
    }
  }

  const wallMs = performance.now() - startedAt;
  const cpu = process.cpuUsage(cpuStart);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  return {
    name,
    wallMs,
    cpuMs,
    cpuPercent: (cpuMs / wallMs) * 100,
    renders: state.renderCount,
    bytes: sink.bytes,
  };
}

async function runBench(): Promise<void> {
  const durationMs = 6000;
  const eventOnly = await benchScenario("event-only idle", null, durationMs);
  const coarseTicks = await benchScenario("500ms progress ticks", 500, durationMs);
  const rows = [eventOnly, coarseTicks].map((result) => ({
    scenario: result.name,
    wallMs: result.wallMs.toFixed(0),
    cpuMs: result.cpuMs.toFixed(1),
    cpuPercent: result.cpuPercent.toFixed(2),
    renders: result.renders,
    bytes: result.bytes,
  }));
  console.table(rows);
}

if (Bun.argv.includes("--bench")) {
  await runBench();
} else {
  runInteractive();
}
