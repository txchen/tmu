import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export class JsonRecoveryMessages {
  private messages: string[] = [];

  reset(): void {
    this.messages = [];
  }

  push(message: string): void {
    this.messages.push(message);
  }

  drain(): string[] {
    const messages = this.messages;
    this.messages = [];
    return messages;
  }
}

export async function loadJsonRecord<T>(options: {
  path: string;
  label: string;
  recoveryMessages: JsonRecoveryMessages;
  parse(value: unknown): T | null;
}): Promise<T | null> {
  options.recoveryMessages.reset();

  let raw: string;
  try {
    raw = await readFile(options.path, "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) {
      options.recoveryMessages.push(`Ignored unreadable ${options.label} at ${options.path}: ${errorMessage(error)}`);
    }
    return null;
  }

  try {
    const record = options.parse(JSON.parse(raw));
    if (!record) {
      options.recoveryMessages.push(`Ignored invalid ${options.label} at ${options.path}`);
      return null;
    }
    return record;
  } catch (error) {
    options.recoveryMessages.push(`Ignored corrupted ${options.label} at ${options.path}: ${errorMessage(error)}`);
    return null;
  }
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
