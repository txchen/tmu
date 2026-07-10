#!/usr/bin/env bun
import {
  createInitialPrototypeState,
  currentTrack,
  helpRows,
  paletteRows,
  pickerRows,
  reduceKey,
  reduceResize,
  selectedQueueEntry,
  shouldQuit,
  stateSummary,
  topOverlay,
  type ClearConfirmOverlay,
  type HelpOverlay,
  type Overlay,
  type PaletteOverlay,
  type PickerOverlay,
  type PrototypeState,
  type QueueEntry,
  type YoutubeUrlOverlay,
} from "./model";

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";
const inverse = "\x1b[7m";

let state = createInitialPrototypeState(process.stdout.columns ?? 120, process.stdout.rows ?? 36);

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stdout.write(`${render(state)}\n`);
  process.exit(0);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\x1b[?25l");
draw();

process.stdout.on("resize", () => {
  state = reduceResize(state, process.stdout.columns ?? state.terminal.columns, process.stdout.rows ?? state.terminal.rows);
  draw();
});

process.stdin.on("data", (data) => {
  for (const key of splitKeys(data)) {
    const quit = shouldQuit(state, key);
    state = reduceKey(state, key);
    if (quit) {
      shutdown();
      return;
    }
  }
  draw();
});

function draw(): void {
  process.stdout.write(`\x1b[2J\x1b[H${render(state)}`);
}

function shutdown(): void {
  process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
  process.stdin.setRawMode(false);
  process.exit(0);
}

function render(currentState: PrototypeState): string {
  const lines = [
    `${bold}TMU TUI experience prototype${reset} ${dim}(throwaway: Validate Queue Home and Picker Overlays with an interactive prototype)${reset}`,
    `${dim}Question: validate Queue Home, Picker Overlays, queue shaping, discovery, dismissal, and responsive layout by keyboard.${reset}`,
    "",
    ...renderMainSurface(currentState),
    "",
    ...renderOverlay(currentState),
    ...renderState(currentState),
    "",
    renderFooter(currentState),
  ];

  return fitToTerminal(lines, currentState.terminal.rows).join("\n");
}

function renderMainSurface(currentState: PrototypeState): string[] {
  if (currentState.terminal.tier === "wide") {
    return [
      twoColumns(
        renderQueuePane(currentState, 58),
        renderPlayingPane(currentState, 48),
        60,
      ),
    ];
  }

  if (currentState.terminal.tier === "medium") {
    return [
      ...renderQueuePane(currentState, currentState.terminal.columns),
      "",
      ...renderPlayingPane(currentState, currentState.terminal.columns),
    ];
  }

  const current = currentTrack(currentState);
  return [
    `${bold}Queue Home${reset} ${dim}narrow layout${reset}`,
    ...currentState.queue.map((entry, index) => queueLine(currentState, entry, index, currentState.terminal.columns)),
    "",
    `${bold}Current:${reset} ${current ? current.title : "none"}  ${bold}State:${reset} ${currentState.playback} @ ${currentState.playbackPosition}`,
  ];
}

function renderQueuePane(currentState: PrototypeState, width: number): string[] {
  const rows = currentState.queue.length
    ? currentState.queue.map((entry, index) => queueLine(currentState, entry, index, width))
    : [`${dim}Empty Queue. o opens music finder, / searches, u downloads a YouTube URL.${reset}`];
  return [
    `${bold}Queue Pane${reset} ${dim}(only focus target on Queue Home)${reset}`,
    ...rows,
  ];
}

function renderPlayingPane(currentState: PrototypeState, width: number): string[] {
  const current = currentTrack(currentState);
  const restored = currentState.playback === "restored"
    ? `Resume from ${currentState.playbackPosition}; launch did not autoplay.`
    : `${currentState.playback} @ ${currentState.playbackPosition}`;
  const availability = current?.availability ? `Unavailable: ${current.availability}` : "Available";
  return [
    `${bold}Playing Track Pane${reset} ${dim}(informational, non-focusable)${reset}`,
    truncate(`${bold}Current Track:${reset} ${current ? current.title : "none"}`, width),
    truncate(`${bold}Artist:${reset} ${current?.artist ?? "none"}`, width),
    truncate(`${bold}Playback:${reset} ${restored}`, width),
    truncate(`${bold}Availability:${reset} ${availability}`, width),
    truncate(`${bold}Modes:${reset} shuffle ${onOff(currentState.shuffle)} | repeat all ${onOff(currentState.repeatAll)} | volume ${currentState.volume}%`, width),
    `${dim}Low-Power TUI check: no timer is running; redraws happen only on key input or resize.${reset}`,
  ];
}

function renderOverlay(currentState: PrototypeState): string[] {
  const overlay = topOverlay(currentState);
  if (!overlay) return [];
  const rendered = overlay.kind === "picker"
    ? renderPicker(currentState, overlay)
    : overlay.kind === "help"
      ? renderHelp(currentState, overlay)
      : overlay.kind === "palette"
        ? renderPalette(currentState, overlay)
        : overlay.kind === "clear-confirm"
          ? renderClearConfirm(overlay)
          : renderYoutubeUrl(overlay);

  return [
    "",
    `${inverse} ${overlayTitle(overlay)} ${reset}`,
    ...rendered,
  ];
}

function renderPicker(currentState: PrototypeState, overlay: PickerOverlay): string[] {
  const rows = pickerRows(overlay);
  const location = overlay.mode === "search" ? "Global Search" : `Provider root/${overlay.location.join("/") || ""}`;
  return [
    `${bold}Mode:${reset} ${overlay.mode}  ${bold}Focus:${reset} ${overlay.focus}  ${bold}Location:${reset} ${location}`,
    `${bold}Search:${reset} ${overlay.focus === "search" ? inverse : ""}${overlay.query || "<empty>"}${reset}  ${bold}Provider filter:${reset} ${overlay.providerFilter}`,
    ...rows.map((row, index) => {
      const selected = index === overlay.selected;
      const prefix = selected ? ">" : " ";
      const kind = row.kind.padEnd(9);
      const disabled = row.disabledReason ? ` [${row.disabledReason}]` : "";
      return truncate(`${selected ? inverse : ""}${prefix} ${kind} ${row.label} - ${row.detail}${disabled}${reset}`, currentState.terminal.columns);
    }),
  ];
}

function renderHelp(currentState: PrototypeState, overlay: HelpOverlay): string[] {
  const rows = helpRows(currentState, overlay);
  return [
    `${bold}Filter:${reset} ${overlay.focus === "filter" ? inverse : ""}${overlay.query || "<empty>"}${reset}`,
    ...rows.map((row, index) => truncate(`${index === overlay.selected ? ">" : " "} ${row}`, currentState.terminal.columns)),
  ];
}

function renderPalette(currentState: PrototypeState, overlay: PaletteOverlay): string[] {
  return [
    `${bold}Query:${reset} ${inverse}${overlay.query || "<empty>"}${reset}`,
    ...paletteRows(currentState, overlay).map((command, index) => {
      const enabled = command.enabled(currentState);
      const reason = enabled ? "" : ` - disabled: ${command.disabledReason}`;
      return truncate(`${index === overlay.selected ? ">" : " "} ${command.label} [${command.keys}]${reason}`, currentState.terminal.columns);
    }),
  ];
}

function renderClearConfirm(overlay: ClearConfirmOverlay): string[] {
  return [
    "Clear Queue stops playback, clears Current Track, and removes every Track.",
    `${choice("cancel", overlay.choice)}   ${choice("clear", overlay.choice)}`,
    `${dim}h/l, Left/Right, or Tab changes choice. Enter activates. y confirms. n/Esc cancels.${reset}`,
  ];
}

function renderYoutubeUrl(overlay: YoutubeUrlOverlay): string[] {
  return [
    `${bold}URL:${reset} ${inverse}${overlay.input || "<paste YouTube or YouTube Music URL>"}${reset}`,
    `${bold}Status:${reset} ${overlay.status}`,
    `${dim}Enter downloads into Offline YouTube Cache and applies Play Next. Esc dismisses.${reset}`,
  ];
}

function renderState(currentState: PrototypeState): string[] {
  const summary = stateSummary(currentState);
  return [
    "",
    `${bold}State exposed for validation${reset}`,
    ...Object.entries(summary).map(([key, value]) => `${key.padEnd(13)} ${String(value)}`),
    `lastAction    ${currentState.lastAction}`,
  ];
}

function renderFooter(currentState: PrototypeState): string {
  const selected = selectedQueueEntry(currentState)?.track.title ?? "none";
  const top = topOverlay(currentState);
  if (top?.kind === "picker" && top.focus === "search") return footer("type query", "Enter submit", "Esc results", "Ctrl-u clear");
  if (top?.kind === "palette") return footer("type command", "Enter run", "Esc dismiss", "j/k move");
  if (top) return footer("Esc/q dismiss", "? help", ": palette", "j/k move");
  return footer(
    `selected ${selected}`,
    "o picker",
    "/ search",
    "Enter Play Next",
    "P Play Now",
    "? help",
    ": palette",
    "q quit",
  );
}

function queueLine(currentState: PrototypeState, entry: QueueEntry, index: number, width: number): string {
  const selected = index === currentState.selectedQueueIndex;
  const current = entry.track.id === currentState.currentTrackId;
  const unavailable = entry.track.availability ? ` unavailable:${entry.track.availability}` : "";
  const text = `${selected ? ">" : " "} ${current ? "*" : " "} ${entry.track.title} - ${entry.track.artist} [${entry.track.provider}] ${entry.track.duration}${unavailable}`;
  return truncate(`${selected ? inverse : ""}${text}${reset}`, width);
}

function overlayTitle(overlay: Overlay): string {
  if (overlay.kind === "picker") return "Picker Overlay";
  if (overlay.kind === "help") return "Contextual Shortcut Help";
  if (overlay.kind === "palette") return "Command Palette";
  if (overlay.kind === "clear-confirm") return "Clear Queue Confirmation";
  return "YouTube URL Download Flow";
}

function choice(value: ClearConfirmOverlay["choice"], current: ClearConfirmOverlay["choice"]): string {
  return current === value ? `${inverse} ${value.toUpperCase()} ${reset}` : ` ${value.toUpperCase()} `;
}

function twoColumns(left: string[], right: string[], leftWidth: number): string {
  const height = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let index = 0; index < height; index += 1) {
    lines.push(`${padAnsi(left[index] ?? "", leftWidth)}  ${right[index] ?? ""}`);
  }
  return lines.join("\n");
}

function footer(...parts: string[]): string {
  return parts.map((part) => `[${part}]`).join("  ");
}

function fitToTerminal(lines: string[], rows: number): string[] {
  const maxRows = Math.max(18, rows - 1);
  if (lines.length <= maxRows) return lines;
  return [
    ...lines.slice(0, maxRows - 2),
    `${dim}... ${lines.length - maxRows + 2} lines hidden by terminal height ...${reset}`,
    lines[lines.length - 1] ?? "",
  ];
}

function padAnsi(value: string, width: number): string {
  const plainLength = stripAnsi(value).length;
  if (plainLength >= width) return truncate(value, width);
  return `${value}${" ".repeat(width - plainLength)}`;
}

function truncate(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= width) return value;
  return `${plain.slice(0, Math.max(0, width - 1))}...`;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

function splitKeys(data: string | Buffer): string[] {
  const raw = data.toString();
  if (raw.startsWith("\x1b[")) return [raw];
  return [...raw];
}
