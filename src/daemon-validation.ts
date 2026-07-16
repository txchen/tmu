import type { AppIntent, Track, TrackIdentity, UiState } from "./domain";
import type { ClientUiState, CommandFeedback, ConfirmationChallenge, DaemonNotice, SharedCommand, SharedStateSnapshot } from "./daemon-client";
import { isRecord } from "./daemon-protocol";

const challengeKinds = ["clear-playlist", "delete-playlist", "cancel-download", "remove-pending-download", "delete-cache", "cleanup-cache", "accept-playlist", "quit-downloads", "shutdown-daemon"] as const;

export function assertExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) if (!(key in value)) invalid(`missing ${key}`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`unknown ${key}`);
}

export function validateSharedCommand(value: unknown): SharedCommand {
  const command = record(value, "Shared Command");
  const type = string(command.type, "command type");
  if (type === "intent") {
    assertExactKeys(command, ["type", "intent"], ["playlistId"]);
    if (command.playlistId !== undefined) string(command.playlistId, "playlistId");
    return { type, intent: validateAppIntent(command.intent), ...(command.playlistId === undefined ? {} : { playlistId: command.playlistId as string }) };
  }
  if (type === "createPlaylist") { assertExactKeys(command, ["type", "name"]); string(command.name, "name"); return command as SharedCommand; }
  if (type === "viewPlaylist") { assertExactKeys(command, ["type", "playlistId"]); string(command.playlistId, "playlistId"); return command as SharedCommand; }
  if (type === "adjustVolume") { assertExactKeys(command, ["type", "delta"]); finite(command.delta, "delta"); return command as SharedCommand; }
  if (type === "setVolume") { assertExactKeys(command, ["type", "percent"]); finite(command.percent, "percent"); return command as SharedCommand; }
  if (type === "broadcastNotice") { assertExactKeys(command, ["type", "message"]); string(command.message, "message"); return command as SharedCommand; }
  if (type === "background") {
    assertExactKeys(command, ["type", "operation"], ["value"]);
    oneOf(command.operation, ["enter", "retry", "setEnabled", "setSound", "adjustVolume"], "background operation");
    if (command.operation === "setEnabled" && typeof command.value !== "boolean") invalid("background boolean");
    if (command.operation === "setSound" && typeof command.value !== "string") invalid("background sound");
    if (command.operation === "adjustVolume" && command.value !== 1 && command.value !== -1) invalid("background delta");
    if ((command.operation === "enter" || command.operation === "retry") && command.value !== undefined) invalid("background value");
    return command as SharedCommand;
  }
  return invalid("command type");
}

export function validateAppIntent(value: unknown): AppIntent {
  const intent = record(value, "AppIntent");
  const type = string(intent.type, "intent type");
  if (["playNext", "playNow", "addToPlaylist"].includes(type)) { assertExactKeys(intent, ["type", "target"]); validateTrack(intent.target); return intent as AppIntent; }
  if (["playSelected", "removePlaylistTrack"].includes(type)) { assertExactKeys(intent, ["type", "identity"]); validateIdentity(intent.identity); return intent as AppIntent; }
  if (type === "movePlaylistTrack") { assertExactKeys(intent, ["type", "identity", "delta"]); validateIdentity(intent.identity); finite(intent.delta, "delta"); return intent as AppIntent; }
  if (type === "renameTrack") { assertExactKeys(intent, ["type", "identity", "title"]); validateIdentity(intent.identity); string(intent.title, "title"); return intent as AppIntent; }
  if (type === "clearPlaylist") { assertExactKeys(intent, ["type"]); return intent as AppIntent; }
  if (type === "createPlaylist") { assertExactKeys(intent, ["type", "name"]); string(intent.name, "name"); return intent as AppIntent; }
  if (type === "renamePlaylist") { assertExactKeys(intent, ["type", "playlistId", "name"]); string(intent.playlistId, "playlistId"); string(intent.name, "name"); return intent as AppIntent; }
  if (type === "movePlaylist") { assertExactKeys(intent, ["type", "playlistId", "delta"]); string(intent.playlistId, "playlistId"); oneOf(intent.delta, [-1, 1], "playlist delta"); return intent as AppIntent; }
  if (["switchPlaylist", "deletePlaylist"].includes(type)) { assertExactKeys(intent, ["type", "playlistId"]); string(intent.playlistId, "playlistId"); return intent as AppIntent; }
  if (type === "cacheOperation") {
    const operation = string(intent.operation, "cache operation");
    if (operation === "request-delete") { assertExactKeys(intent, ["type", "operation", "identity"]); validateIdentity(intent.identity); }
    else if (operation === "request-cleanup") { assertExactKeys(intent, ["type", "operation", "stem"]); string(intent.stem, "stem"); }
    else if (operation === "confirm" || operation === "cancel") assertExactKeys(intent, ["type", "operation"]);
    else invalid("cache operation");
    return intent as AppIntent;
  }
  if (type === "downloadOperation") {
    const operation = string(intent.operation, "download operation");
    if (operation === "start") { assertExactKeys(intent, ["type", "operation", "url"]); string(intent.url, "url"); }
    else if (operation === "remove-pending") { assertExactKeys(intent, ["type", "operation", "batchId"]); integer(intent.batchId, "batchId"); }
    else if (operation === "acknowledge-accepted") { assertExactKeys(intent, ["type", "operation", "submissionId"]); integer(intent.submissionId, "submissionId"); }
    else if (["cancel", "cancel-active", "confirm-quit", "cancel-quit", "confirm-playlist", "cancel-playlist"].includes(operation)) assertExactKeys(intent, ["type", "operation"]);
    else invalid("download operation");
    return intent as AppIntent;
  }
  if (type === "playerOperation") {
    const operation = string(intent.operation, "player operation");
    if (operation === "seek") { assertExactKeys(intent, ["type", "operation", "seconds"]); finite(intent.seconds, "seconds"); }
    else if (operation === "adjust-volume") { assertExactKeys(intent, ["type", "operation", "delta"]); finite(intent.delta, "delta"); }
    else if (operation === "set-volume") { assertExactKeys(intent, ["type", "operation", "percent", "ready"]); finite(intent.percent, "percent"); bool(intent.ready, "ready"); }
    else if (["toggle-play-pause", "stop", "next-track", "previous-track", "randomize-playlist", "toggle-repeat-all", "quit"].includes(operation)) assertExactKeys(intent, ["type", "operation"]);
    else invalid("player operation");
    return intent as AppIntent;
  }
  return invalid("intent type");
}

export function validateChallenge(value: unknown): ConfirmationChallenge {
  const item = record(value, "challenge"); assertExactKeys(item, ["token", "kind", "targetId", "revision", "impact", "expiresAt"]);
  string(item.token, "token"); oneOf(item.kind, challengeKinds, "challenge kind"); string(item.targetId, "targetId"); integer(item.revision, "revision"); string(item.impact, "impact"); finite(item.expiresAt, "expiresAt");
  return item as ConfirmationChallenge;
}

export function validateFeedback(value: unknown): CommandFeedback {
  const item = record(value, "feedback"); assertExactKeys(item, ["requestId", "status", "message", "revision"]);
  string(item.requestId, "requestId"); oneOf(item.status, ["success", "error", "stale-confirmation"], "feedback status"); string(item.message, "message"); integer(item.revision, "revision"); return item as CommandFeedback;
}

export function validateNotice(value: unknown): DaemonNotice {
  const item = record(value, "notice"); assertExactKeys(item, ["message", "revision"]); string(item.message, "message"); integer(item.revision, "revision"); return item as DaemonNotice;
}

export function validateUiState(value: unknown): ClientUiState {
  const ui = record(value, "UI State");
  assertExactKeys(ui, ["activeTab", "selectedPlaylistIndex", "playlistScroll", "overlays", "selectedPlaylistIdentity", "library", "downloader", "background", "terminal", "pendingConfirmation", "renameDialog", "notification", "pendingVimChord", "playlistManager", "viewedPlaylistId"]);
  oneOf(ui.activeTab, ["playback", "library", "downloader", "background"], "activeTab"); integer(ui.selectedPlaylistIndex, "selectedPlaylistIndex"); integer(ui.playlistScroll, "playlistScroll"); array(ui.overlays, "overlays").forEach((value) => { const overlay = record(value, "overlay"); assertExactKeys(overlay, ["kind", "focus", "query", "scroll", "pendingG"]); oneOf(overlay.kind, ["shortcut-help"], "overlay kind"); oneOf(overlay.focus, ["search", "results"], "overlay focus"); string(overlay.query, "overlay query"); integer(overlay.scroll, "overlay scroll"); bool(overlay.pendingG, "overlay pendingG"); }); nullableIdentity(ui.selectedPlaylistIdentity); string(ui.viewedPlaylistId, "viewedPlaylistId");
  const library = record(ui.library, "library"); assertExactKeys(library, ["query", "inputFocused", "selectedIndex", "healthSelectedIndex", "scroll"]); string(library.query, "query"); bool(library.inputFocused, "inputFocused"); integer(library.selectedIndex, "selectedIndex"); integer(library.healthSelectedIndex, "healthSelectedIndex"); integer(library.scroll, "scroll");
  const downloader = record(ui.downloader, "downloader"); assertExactKeys(downloader, ["urlInput", "inputFocused", "selectedBatchIndex", "scroll"]); string(downloader.urlInput, "urlInput"); bool(downloader.inputFocused, "inputFocused"); integer(downloader.selectedBatchIndex, "selectedBatchIndex"); integer(downloader.scroll, "scroll");
  const background = record(ui.background, "background"); assertExactKeys(background, ["selectedRow", "pendingVolumePercent", "soundPicker"]); integer(background.selectedRow, "selectedRow"); if (background.pendingVolumePercent !== null) finite(background.pendingVolumePercent, "pendingVolumePercent");
  if (background.soundPicker !== null) { const picker = record(background.soundPicker, "soundPicker"); assertExactKeys(picker, ["selectedIndex", "scroll"]); integer(picker.selectedIndex, "selectedIndex"); integer(picker.scroll, "scroll"); }
  const terminal = record(ui.terminal, "terminal"); assertExactKeys(terminal, ["columns", "rows", "tier"]); integer(terminal.columns, "columns"); integer(terminal.rows, "rows"); oneOf(terminal.tier, ["wide", "medium", "narrow", "terminal-too-small"], "tier");
  if (ui.pendingConfirmation !== null) { const item = record(ui.pendingConfirmation, "pendingConfirmation"); assertExactKeys(item, ["kind", "choice"], ["batchId", "target"]); oneOf(item.kind, challengeKinds.slice(0, -1), "confirmation kind"); oneOf(item.choice, ["cancel", "confirm"], "confirmation choice"); if (item.batchId !== undefined) integer(item.batchId, "batchId"); if (item.target !== undefined) string(item.target, "target"); }
  if (ui.renameDialog !== null) { const item = record(ui.renameDialog, "renameDialog"); assertExactKeys(item, ["identity", "currentTitle", "value", "cursor", "error"]); validateIdentity(item.identity); string(item.currentTitle, "currentTitle"); string(item.value, "value"); integer(item.cursor, "cursor"); if (item.error !== null) string(item.error, "error"); }
  if (ui.notification !== null) { const item = record(ui.notification, "notification"); assertExactKeys(item, ["level", "message"], ["expiresAtMs"]); oneOf(item.level, ["success", "warning", "error"], "notification level"); string(item.message, "message"); if (item.expiresAtMs !== undefined) finite(item.expiresAtMs, "expiresAtMs"); }
  if (ui.pendingVimChord !== null) { const item = record(ui.pendingVimChord, "pendingVimChord"); assertExactKeys(item, ["key", "expiresAtMs"]); oneOf(item.key, ["g"], "vim key"); finite(item.expiresAtMs, "expiresAtMs"); }
  if (ui.playlistManager !== null) { const item = record(ui.playlistManager, "playlistManager"); assertExactKeys(item, ["selectedIndex", "scroll", "mode", "value", "cursor", "error"]); integer(item.selectedIndex, "selectedIndex"); integer(item.scroll, "scroll"); oneOf(item.mode, ["browse", "create", "rename"], "manager mode"); string(item.value, "value"); integer(item.cursor, "cursor"); if (item.error !== null) string(item.error, "error"); }
  validateJson(ui, "UI State");
  return ui as ClientUiState;
}

export function validateSnapshot(value: unknown): SharedStateSnapshot {
  const snapshot = record(value, "snapshot"); assertExactKeys(snapshot, ["revision", "state"]); integer(snapshot.revision, "revision");
  const state = record(snapshot.state, "shared state");
  assertExactKeys(state, ["backgroundSounds", "config", "configPath", "configSource", "dependencyHealth", "providers", "playback", "volume", "downloads", "lastEvent", "playingPlaylistContent", "playlists"], ["cacheConfirmation"]);
  string(state.configPath, "configPath"); oneOf(state.configSource, ["defaults", "file"], "configSource"); string(state.lastEvent, "lastEvent");
  const playlists = record(state.playlists, "playlists"); assertExactKeys(playlists, ["playlists", "playingPlaylistId"]); string(playlists.playingPlaylistId, "playingPlaylistId"); array(playlists.playlists, "playlists").forEach(validatePlaylist);
  validatePlaylistContent(state.playingPlaylistContent);
  const playback = record(state.playback, "playback"); if (!("currentTrackIdentity" in playback)) invalid("playback currentTrackIdentity"); nullableIdentity(playback.currentTrackIdentity); oneOf(playback.status, ["idle", "playing", "paused", "stopped", "error"], "playback status");
  const volume = record(state.volume, "volume"); assertExactKeys(volume, ["percent", "ready"]); finite(volume.percent, "volume percent"); bool(volume.ready, "volume ready");
  const downloads = record(state.downloads, "downloads"); for (const key of ["active", "lines", "pendingBatches", "summaries", "quitConfirmationRequired", "preparingSubmissions"]) if (!(key in downloads)) invalid(`downloads ${key}`); bool(downloads.active, "downloads active"); array(downloads.lines, "download lines").forEach((v) => string(v, "download line")); array(downloads.pendingBatches, "pendingBatches"); array(downloads.summaries, "summaries");
  record(state.providers, "providers"); record(state.config, "config"); record(state.dependencyHealth, "dependencyHealth"); record(state.backgroundSounds, "backgroundSounds"); validateJson(state, "shared state");
  return snapshot as SharedStateSnapshot;
}

function validatePlaylist(value: unknown): void { const p = record(value, "playlist"); assertExactKeys(p, ["id", "name", "entries", "currentIndex", "repeatAll", "positionSeconds", "playbackStatus"]); string(p.id, "id"); string(p.name, "name"); validatePlaylistContent(p); finite(p.positionSeconds, "positionSeconds"); oneOf(p.playbackStatus, ["stopped", "resumable"], "playbackStatus"); }
function validatePlaylistContent(value: unknown): void { const p = record(value, "playlist content"); for (const key of ["entries", "currentIndex", "repeatAll"]) if (!(key in p)) invalid(`playlist ${key}`); array(p.entries, "entries").forEach((e) => { const entry = record(e, "entry"); assertExactKeys(entry, ["track", "availability"]); validateTrack(entry.track); record(entry.availability, "availability"); }); integer(p.currentIndex, "currentIndex"); bool(p.repeatAll, "repeatAll"); }
function validateTrack(value: unknown): Track { const t = record(value, "Track"); assertExactKeys(t, ["identity", "title", "providerLabel"], ["artist", "durationSeconds"]); validateIdentity(t.identity); string(t.title, "title"); string(t.providerLabel, "providerLabel"); if (t.artist !== undefined) string(t.artist, "artist"); if (t.durationSeconds !== undefined) finite(t.durationSeconds, "durationSeconds"); return t as Track; }
function validateIdentity(value: unknown): TrackIdentity { const i = record(value, "Track Identity"); assertExactKeys(i, ["providerId", "stableId"]); string(i.providerId, "providerId"); string(i.stableId, "stableId"); return i as TrackIdentity; }
function nullableIdentity(value: unknown): void { if (value !== null) validateIdentity(value); }
function validateJson(value: unknown, name: string): void { if (value === null || ["string", "boolean"].includes(typeof value)) return; if (typeof value === "number") { finite(value, name); return; } if (Array.isArray(value)) { value.forEach((v) => validateJson(v, name)); return; } if (isRecord(value)) { Object.values(value).forEach((v) => validateJson(v, name)); return; } invalid(name); }
function record(value: unknown, name: string): Record<string, unknown> { if (!isRecord(value)) invalid(name); return value; }
function array(value: unknown, name: string): unknown[] { if (!Array.isArray(value)) invalid(name); return value; }
function string(value: unknown, name: string): string { if (typeof value !== "string") invalid(name); return value; }
function finite(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value)) invalid(name); return value; }
function integer(value: unknown, name: string): number { const n = finite(value, name); if (!Number.isInteger(n)) invalid(name); return n; }
function bool(value: unknown, name: string): boolean { if (typeof value !== "boolean") invalid(name); return value; }
function oneOf<T>(value: unknown, values: readonly T[], name: string): T { if (!values.includes(value as T)) invalid(name); return value as T; }
function invalid(name: string): never { throw new Error(`Invalid daemon message: ${name}`); }
