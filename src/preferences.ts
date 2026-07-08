import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NavigationTargetId, VolumeState } from "./domain";
import { JsonRecoveryMessages, loadJsonRecord } from "./json-persistence";

export type RestorableProviderTargetId = Extract<
  NavigationTargetId,
  "local" | "navidrome" | "offline-youtube-cache"
>;

export type AppPreferencesRecord = {
  version: 1;
  lastSelectedProviderId?: RestorableProviderTargetId;
  shuffle?: boolean;
  repeatAll?: boolean;
  volume?: VolumeState;
};

export type AppPreferencesPersistence = {
  load(): Promise<AppPreferencesRecord | null>;
  save(record: AppPreferencesRecord): Promise<void>;
  drainRecoveryMessages?(): string[];
};

export class InMemoryAppPreferencesPersistence implements AppPreferencesPersistence {
  private record: AppPreferencesRecord | null = null;

  async load(): Promise<AppPreferencesRecord | null> {
    return this.record ? cloneAppPreferencesRecord(this.record) : null;
  }

  async save(record: AppPreferencesRecord): Promise<void> {
    this.record = cloneAppPreferencesRecord(record);
  }
}

export class FileAppPreferencesPersistence implements AppPreferencesPersistence {
  private recoveryMessages = new JsonRecoveryMessages();

  constructor(private readonly path: string) {}

  async load(): Promise<AppPreferencesRecord | null> {
    return loadJsonRecord({
      path: this.path,
      label: "app preferences",
      recoveryMessages: this.recoveryMessages,
      parse: parseAppPreferencesRecord,
    });
  }

  async save(record: AppPreferencesRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;

    try {
      await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      await rename(tempPath, this.path);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  drainRecoveryMessages(): string[] {
    return this.recoveryMessages.drain();
  }
}

export function isRestorableProviderTargetId(value: unknown): value is RestorableProviderTargetId {
  return typeof value === "string"
    && (
      value === "local"
      || value === "navidrome"
      || value === "offline-youtube-cache"
    );
}

function parseAppPreferencesRecord(value: unknown): AppPreferencesRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<AppPreferencesRecord>;
  if (record.version !== 1) return null;
  if (record.lastSelectedProviderId !== undefined && !isRestorableProviderTargetId(record.lastSelectedProviderId)) return null;
  if (record.shuffle !== undefined && typeof record.shuffle !== "boolean") return null;
  if (record.repeatAll !== undefined && typeof record.repeatAll !== "boolean") return null;
  if (record.volume !== undefined && !isVolumeState(record.volume)) return null;

  const parsed: AppPreferencesRecord = { version: 1 };
  if (record.lastSelectedProviderId !== undefined) parsed.lastSelectedProviderId = record.lastSelectedProviderId;
  if (record.shuffle !== undefined) parsed.shuffle = record.shuffle;
  if (record.repeatAll !== undefined) parsed.repeatAll = record.repeatAll;
  if (record.volume !== undefined) parsed.volume = { ...record.volume };
  return parsed;
}

function cloneAppPreferencesRecord(record: AppPreferencesRecord): AppPreferencesRecord {
  const cloned: AppPreferencesRecord = { ...record };
  if (record.volume !== undefined) cloned.volume = { ...record.volume };
  return cloned;
}

function isVolumeState(value: unknown): value is VolumeState {
  return typeof value === "object"
    && value !== null
    && typeof (value as Partial<VolumeState>).percent === "number"
    && typeof (value as Partial<VolumeState>).ready === "boolean";
}
