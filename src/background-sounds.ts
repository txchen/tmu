import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export type BackgroundSoundOption = { id: string; label: string };
export type BackgroundSoundsSnapshot = {
  enabled: boolean;
  sound: BackgroundSoundOption;
  sounds: readonly BackgroundSoundOption[];
  volumePercent: number;
};
const backgroundSoundsFailureCodes = [
  "unsupported-platform", "helper-missing", "framework-load", "contract-mismatch", "unavailable",
  "timeout", "helper-exit", "malformed-response", "invalid-snapshot", "apply-mismatch", "cancelled",
] as const;
export type BackgroundSoundsFailureCode = typeof backgroundSoundsFailureCodes[number];

export interface BackgroundSoundsControl {
  probe(signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
  read(signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
  setEnabled(value: boolean, signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
  setSound(id: string, signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
  setVolume(percent: number, signal?: AbortSignal): Promise<BackgroundSoundsSnapshot>;
}

export class BackgroundSoundsError extends Error {
  constructor(readonly code: BackgroundSoundsFailureCode, message: string) {
    super(message);
    this.name = "BackgroundSoundsError";
  }
}

export function isBackgroundSoundsCandidate(platform: string, kernelRelease: string): boolean {
  if (platform !== "darwin") return false;
  const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(kernelRelease);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 25 || (major === 25 && minor >= 5);
}

type RunResult = { stdout: string; stderr: string };
type HelperRunner = (
  executable: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; shell: false; signal?: AbortSignal },
) => Promise<RunResult>;

const nodeExecFile = promisify(execFile) as unknown as HelperRunner;

export class JxaBackgroundSoundsControl implements BackgroundSoundsControl {
  private readonly run: HelperRunner;
  readonly helperPath: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;

  constructor(options: {
    run?: HelperRunner;
    helperPath?: string;
    timeoutMs?: number;
    maxBufferBytes?: number;
  } = {}) {
    this.run = options.run ?? nodeExecFile;
    this.helperPath = options.helperPath ?? fileURLToPath(new URL("./background-sounds.jxa", import.meta.url));
    this.timeoutMs = options.timeoutMs ?? 4_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 64 * 1024;
  }

  probe(signal?: AbortSignal): Promise<BackgroundSoundsSnapshot> { return this.invoke("probe", signal); }
  read(signal?: AbortSignal): Promise<BackgroundSoundsSnapshot> { return this.invoke("read", signal); }
  async setEnabled(value: boolean, signal?: AbortSignal): Promise<BackgroundSoundsSnapshot> {
    const snapshot = await this.invoke("set-enabled", signal, value ? "true" : "false");
    return this.confirm(snapshot.enabled === value, snapshot);
  }
  async setSound(id: string, signal?: AbortSignal): Promise<BackgroundSoundsSnapshot> {
    if (!id || id.length > 200) throw new BackgroundSoundsError("invalid-snapshot", "The selected Background Sound is invalid.");
    const snapshot = await this.invoke("set-sound", signal, JSON.stringify(id));
    return this.confirm(snapshot.sound.id === id, snapshot);
  }
  async setVolume(percent: number, signal?: AbortSignal): Promise<BackgroundSoundsSnapshot> {
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      throw new BackgroundSoundsError("invalid-snapshot", "Background Sound volume must be an integer from 0 to 100.");
    }
    const snapshot = await this.invoke("set-volume", signal, String(percent));
    return this.confirm(snapshot.volumePercent === percent, snapshot);
  }

  private confirm(matches: boolean, snapshot: BackgroundSoundsSnapshot): BackgroundSoundsSnapshot {
    if (!matches) throw new BackgroundSoundsError("apply-mismatch", "macOS did not confirm the requested Background Sounds change.");
    return snapshot;
  }

  private async invoke(command: "probe" | "read" | "set-enabled" | "set-sound" | "set-volume", signal?: AbortSignal, value?: string): Promise<BackgroundSoundsSnapshot> {
    if (!existsSync(this.helperPath) && this.run === nodeExecFile) {
      throw new BackgroundSoundsError("helper-missing", "The bundled Background Sounds helper is missing. Reinstall TMU and retry.");
    }
    try {
      const result = await this.run(
        "/usr/bin/osascript",
        ["-l", "JavaScript", this.helperPath, command, ...(value === undefined ? [] : [value])],
        { timeout: this.timeoutMs, maxBuffer: this.maxBufferBytes, shell: false, ...(signal ? { signal } : {}) },
      );
      return parseEnvelope(result.stdout);
    } catch (error) {
      if (error instanceof BackgroundSoundsError) throw error;
      const cause = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      if (signal?.aborted || cause.name === "AbortError") {
        throw new BackgroundSoundsError("cancelled", "Background Sounds refresh was cancelled.");
      }
      if (cause.killed || cause.signal === "SIGTERM") {
        throw new BackgroundSoundsError("timeout", "macOS did not respond in time. Retry the Background Sounds check.");
      }
      throw new BackgroundSoundsError("helper-exit", "macOS Background Sounds could not be read. Retry or check System Settings.");
    }
  }
}

function parseEnvelope(stdout: string): BackgroundSoundsSnapshot {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch {
    throw new BackgroundSoundsError("malformed-response", "macOS returned an unreadable Background Sounds response.");
  }
  if (!isRecord(value) || value.protocolVersion !== 1 || typeof value.ok !== "boolean") {
    throw new BackgroundSoundsError("malformed-response", "The Background Sounds helper protocol is not supported.");
  }
  if (!value.ok) {
    const code = isFailureCode(value.code) ? value.code : "helper-exit";
    const message = typeof value.message === "string" && value.message.length <= 500
      ? value.message : "macOS Background Sounds is unavailable.";
    throw new BackgroundSoundsError(code, message);
  }
  if (!isSnapshot(value.snapshot)) {
    throw new BackgroundSoundsError("invalid-snapshot", "macOS returned incomplete Background Sounds state.");
  }
  return value.snapshot;
}

function isSnapshot(value: unknown): value is BackgroundSoundsSnapshot {
  if (!isRecord(value) || typeof value.enabled !== "boolean" || !isOption(value.sound)
    || !Array.isArray(value.sounds) || !Number.isInteger(value.volumePercent)
    || (value.volumePercent as number) < 0 || (value.volumePercent as number) > 100) return false;
  const sounds = value.sounds as unknown[];
  if (sounds.length === 0 || !sounds.every(isOption)) return false;
  const ids = sounds.map((sound) => (sound as BackgroundSoundOption).id);
  return new Set(ids).size === ids.length && ids.includes(value.sound.id);
}

function isOption(value: unknown): value is BackgroundSoundOption {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0
    && value.id.length <= 200 && typeof value.label === "string" && value.label.length > 0 && value.label.length <= 200;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isFailureCode(value: unknown): value is BackgroundSoundsFailureCode {
  return typeof value === "string" && (backgroundSoundsFailureCodes as readonly string[]).includes(value);
}

export class UnavailableBackgroundSoundsControl implements BackgroundSoundsControl {
  private fail(): never { throw new BackgroundSoundsError("unsupported-platform", "Background Sounds requires macOS 26.5 or newer."); }
  async probe(): Promise<BackgroundSoundsSnapshot> { return this.fail(); }
  async read(): Promise<BackgroundSoundsSnapshot> { return this.fail(); }
  async setEnabled(): Promise<BackgroundSoundsSnapshot> { return this.fail(); }
  async setSound(): Promise<BackgroundSoundsSnapshot> { return this.fail(); }
  async setVolume(): Promise<BackgroundSoundsSnapshot> { return this.fail(); }
}
