import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type OwnedChildKind = "mpv" | "yt-dlp";
export type OwnedChildRecord = Readonly<{
  pid: number;
  kind: OwnedChildKind;
  identity: string;
  child: Pick<ChildProcess, "pid" | "exitCode" | "kill">;
}>;

export type ProcessIdentityReader = (pid: number) => string | null;
export type PersistedChildIdentity = Readonly<{ pid: number; kind: OwnedChildKind; identity: string }>;

/** Tracks only handles spawned by this daemon and verifies OS process identity before fallback termination. */
export class OwnedChildRegistry {
  private readonly records = new Map<number, OwnedChildRecord>();
  constructor(private readonly readIdentity: ProcessIdentityReader = readProcessIdentity) {}
  private changeListener?: (records: readonly PersistedChildIdentity[]) => void;

  onChange(listener: (records: readonly PersistedChildIdentity[]) => void): () => void {
    this.changeListener = listener; listener(this.snapshot());
    return () => { if (this.changeListener === listener) this.changeListener = undefined; };
  }

  register(child: Pick<ChildProcess, "pid" | "exitCode" | "kill" | "once">, kind: OwnedChildKind): () => void {
    const pid = child.pid;
    if (!pid) return () => undefined;
    const identity = this.readIdentity(pid);
    if (!identity) return () => undefined;
    const record = { pid, kind, identity, child };
    this.records.set(pid, record);
    this.changed();
    const unregister = () => { if (this.records.get(pid) === record) { this.records.delete(pid); this.changed(); } };
    child.once("close", unregister);
    child.once("exit", unregister);
    return unregister;
  }

  terminateVerified(signal: NodeJS.Signals = "SIGKILL"): Readonly<{ terminated: number[]; refused: number[] }> {
    const terminated: number[] = []; const refused: number[] = [];
    for (const [pid, record] of this.records) {
      if (record.child.exitCode !== null || record.child.pid !== pid || this.readIdentity(pid) !== record.identity) {
        refused.push(pid); this.records.delete(pid); continue;
      }
      if (record.child.kill(signal)) terminated.push(pid); else refused.push(pid);
    }
    return { terminated, refused };
  }

  private snapshot(): PersistedChildIdentity[] {
    return [...this.records.values()].map(({ pid, kind, identity }) => ({ pid, kind, identity }));
  }
  private changed(): void { this.changeListener?.(this.snapshot()); }
}

export const daemonOwnedChildren = new OwnedChildRegistry();

export function readProcessIdentity(pid: number): string | null {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      return fields[19] ?? null; // Linux starttime, stable for the process lifetime.
    }
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 500 }).trim() || null;
  } catch { return null; }
}
