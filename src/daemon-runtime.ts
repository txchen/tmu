import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTmuRuntime } from "./app";
import {
  InProcessDaemonApplication, adaptDaemonClientForTui, type ClientUiState, type CommandFeedback,
  type ConfirmationChallenge, type DaemonClient, type DaemonNotice, type SharedCommand,
  type SharedStateSnapshot, type TuiDaemonClient,
} from "./daemon-client";
import { UiStateStore, type UiStateAction } from "./ui-state";
import { DAEMON_PROTOCOL_VERSION, encodeFrame, FrameDecoder, isRecord } from "./daemon-protocol";
import { assertExactKeys, validateChallenge, validateFeedback, validateNotice, validateSharedCommand, validateSnapshot, validateUiState } from "./daemon-validation";
import { daemonOwnedChildren, type OwnedChildRegistry } from "./child-ownership";

const STARTUP_TIMEOUT_MS = 15_000;
const SOCKET_NAME = "daemon.sock";
const CONTROL_PROTOCOL_VERSION = 1;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 5_000;

export type DaemonPaths = Readonly<{ runtimeDirectory: string; socketPath: string; lockPath: string; readyPath: string; logPath: string }>;
export type UnixDaemonServerOptions = Readonly<{ maxOutboundBytes?: number }>;
export type DaemonOperationalStatus = Readonly<{
  controlProtocolVersion: number; protocolVersion: number; daemonVersion: string; pid: number; uptimeMs: number;
  lifecycle: "starting" | "ready" | "terminating" | "stopped"; runtimePath: string; logPath: string;
  clientCount: number; playingPlaylist: string; currentTrack: string | null; playbackStatus: string;
  activeDownloads: number; pendingDownloads: number; configPath: string; configSource: "defaults" | "file";
  recoveryState: string; latestSevereError: string | null; impact: string;
}>;

export class DaemonProtocolMismatchError extends Error {
  readonly code = "daemon-protocol-mismatch";
  constructor(readonly expected: number, readonly received: number) {
    super(`TMU Daemon protocol mismatch (daemon ${expected}, client ${received}). Restart TMU so the daemon and client use the same protocol.`);
    this.name = "DaemonProtocolMismatchError";
  }
}

const DEFAULT_MAX_OUTBOUND_BYTES = 1024 * 1024;

export async function resolveDaemonPaths(env: NodeJS.ProcessEnv = process.env): Promise<DaemonPaths> {
  const uid = process.getuid?.() ?? userInfo().uid;
  const xdg = env.XDG_RUNTIME_DIR;
  let base: string;
  if (xdg && await directoryOwnedByCurrentUser(xdg, uid)) base = xdg;
  else base = join(tmpdir(), `tmu-${uid}`);
  const runtimeDirectory = join(base, "tmu");
  await ensurePrivateDirectory(runtimeDirectory, uid);
  const stateBase = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const stateDirectory = join(stateBase, "tmu");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  return {
    runtimeDirectory, socketPath: join(runtimeDirectory, SOCKET_NAME), lockPath: join(runtimeDirectory, "startup.lock"),
    readyPath: join(runtimeDirectory, "ready.json"), logPath: join(stateDirectory, "daemon.log"),
  };
}

async function directoryOwnedByCurrentUser(path: string, uid: number): Promise<boolean> {
  try { const entry = await stat(path); return entry.isDirectory() && entry.uid === uid && (entry.mode & 0o022) === 0; }
  catch { return false; }
}

async function ensurePrivateDirectory(path: string, uid: number): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid) throw new Error(`Unsafe TMU runtime directory: ${path}`);
  if ((entry.mode & 0o077) !== 0) await chmod(path, 0o700);
}

type Request = { type: "request"; requestId: string; operation: "submit" | "requestChallenge" | "confirmChallenge" | "cancelChallenge"; payload: unknown };

export class UnixDaemonServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  constructor(
    private readonly application: InProcessDaemonApplication,
    readonly paths: DaemonPaths,
    private readonly options: UnixDaemonServerOptions = {},
  ) {}

  async listen(): Promise<void> {
    await removeOwnedSocket(this.paths.socketPath);
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.paths.socketPath, () => { this.server!.off("error", reject); resolve(); });
    });
    await chmod(this.paths.socketPath, 0o600);
  }

  async close(teardown = true): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    await rm(this.paths.socketPath, { force: true });
    if (teardown) await this.application.teardown();
  }

  async forceClose(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.server?.close();
    await rm(this.paths.socketPath, { force: true });
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new FrameDecoder();
    let client: DaemonClient | undefined;
    let initialized = false;
    const outbound = new SocketOutboundBuffer(socket, this.options.maxOutboundBytes ?? DEFAULT_MAX_OUTBOUND_BYTES);
    const send = (message: unknown, kind: OutboundKind = "control") => outbound.send(message, kind);
    socket.on("data", async (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (!initialized) {
            if (isRecord(frame) && frame.type === "control") {
              await this.handleControl(socket, frame);
              return;
            }
            const hello = validateHello(frame);
            if (hello.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
              send({ type: "protocolError", expected: DAEMON_PROTOCOL_VERSION, received: hello.protocolVersion });
              socket.end(); return;
            }
            client = await this.application.connect();
            initialized = true;
            client.onSnapshot((snapshot) => send({ type: "snapshot", snapshot }, "snapshot"));
            client.onFeedback((feedback) => send({ type: "feedback", feedback }, "control"));
            client.onNotice((notice) => send({ type: "notice", notice }, "control"));
            send({ type: "welcome", protocolVersion: DAEMON_PROTOCOL_VERSION, daemonVersion: packageVersion(), clientId: client.id,
              snapshot: client.snapshot, uiState: client.uiState });
            continue;
          }
          const request = validateRequest(frame);
          try {
            const result = await executeRequest(client!, request);
            // Snapshot publications are written to every connection during command execution.
            // Yield once so a completed submit observes cross-connection convergence.
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
            send({ type: "response", requestId: request.requestId, ok: true, result, uiState: client!.uiState });
          } catch (error) {
            send({ type: "response", requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error), uiState: client!.uiState });
          }
        }
      } catch (error) { send({ type: "fatal", error: error instanceof Error ? error.message : String(error) }); socket.destroy(); }
    });
    socket.on("close", () => { this.sockets.delete(socket); client?.disconnect(); });
    socket.on("error", () => undefined);
  }

  private async handleControl(socket: Socket, frame: Record<string, unknown>): Promise<void> {
    assertExactKeys(frame, ["type", "controlVersion", "operation"], frame.operation === "stop" ? ["confirmed", "expectedImpact"] : []);
    if (frame.controlVersion !== CONTROL_PROTOCOL_VERSION || !["status", "stop"].includes(String(frame.operation))) {
      socket.end(encodeFrame({ type: "controlError", error: "Unsupported TMU daemon control handshake" })); return;
    }
    const status = await operationalStatus(this.application, this.paths);
    if (frame.operation === "stop" && frame.expectedImpact !== status.impact) {
      socket.end(encodeFrame({ type: "controlError", error: "Daemon impact changed; review status and confirm again" })); return;
    }
    socket.write(encodeFrame({ type: "controlStatus", status }));
    if (frame.operation === "stop") {
      if (frame.confirmed !== true) { socket.end(); return; }
      this.application.requestOperationalShutdown();
    }
    socket.end();
  }
}

type OutboundKind = "snapshot" | "control";
type OutboundFrame = { bytes: Buffer; kind: OutboundKind };

class SocketOutboundBuffer {
  private blocked = false;
  private queuedBytes = 0;
  private readonly queue: OutboundFrame[] = [];

  constructor(private readonly socket: Socket, private readonly maxBytes: number) {
    socket.on("drain", () => this.flush());
  }

  send(message: unknown, kind: OutboundKind): void {
    if (this.socket.destroyed) return;
    const frame = { bytes: encodeFrame(message), kind };
    if (!this.blocked && this.queue.length === 0) {
      this.blocked = !this.socket.write(frame.bytes);
      return;
    }
    if (kind === "snapshot") {
      const existing = this.queue.findIndex((item) => item.kind === "snapshot");
      if (existing >= 0) {
        this.queuedBytes -= this.queue[existing]!.bytes.length;
        this.queue[existing] = frame;
      } else this.queue.push(frame);
    } else this.queue.push(frame);
    this.queuedBytes += frame.bytes.length;
    if (this.queuedBytes > this.maxBytes) this.socket.destroy(new Error("TMU Daemon disconnected a slow client"));
  }

  private flush(): void {
    if (this.socket.destroyed) return;
    this.blocked = false;
    while (!this.blocked && this.queue.length > 0) {
      const frame = this.queue.shift()!;
      this.queuedBytes -= frame.bytes.length;
      this.blocked = !this.socket.write(frame.bytes);
    }
  }
}

async function executeRequest(client: DaemonClient, request: Request): Promise<unknown> {
  const payload = request.payload;
  if (request.operation === "submit") return client.submit(validateSharedCommand(payload));
  if (request.operation === "requestChallenge") {
    if (!isRecord(payload) || typeof payload.kind !== "string" || typeof payload.targetId !== "string") throw new Error("Invalid challenge request");
    assertExactKeys(payload, ["kind", "targetId"]);
    if (!["clear-playlist", "delete-playlist", "cancel-download", "remove-pending-download", "delete-cache", "cleanup-cache", "accept-playlist", "quit-downloads", "shutdown-daemon"].includes(payload.kind)) throw new Error("Invalid challenge kind");
    const challenge = await client.requestChallenge(payload as { kind: ConfirmationChallenge["kind"]; targetId: string });
    return { token: challenge.token, kind: challenge.kind, targetId: challenge.targetId, revision: challenge.revision, impact: challenge.impact, expiresAt: challenge.expiresAt };
  }
  if (!isRecord(payload) || typeof payload.token !== "string") throw new Error("Invalid challenge token");
  assertExactKeys(payload, ["token"]);
  if (request.operation === "confirmChallenge") return client.confirmChallenge(payload.token);
  return client.cancelChallenge(payload.token);
}

function validateHello(value: unknown): { protocolVersion: number } {
  if (!isRecord(value) || value.type !== "hello" || !Number.isInteger(value.protocolVersion)
    || typeof value.clientVersion !== "string" || typeof value.clientIdentity !== "string") throw new Error("Invalid daemon hello");
  assertExactKeys(value, ["type", "protocolVersion", "clientVersion", "clientIdentity"]);
  return { protocolVersion: value.protocolVersion as number };
}

function validateRequest(value: unknown): Request {
  if (!isRecord(value) || value.type !== "request" || typeof value.requestId !== "string"
    || !["submit", "requestChallenge", "confirmChallenge", "cancelChallenge"].includes(String(value.operation))) throw new Error("Invalid daemon request");
  assertExactKeys(value, ["type", "requestId", "operation", "payload"]);
  return value as Request;
}

export class UnixDaemonClient implements DaemonClient {
  readonly id: string;
  snapshot: SharedStateSnapshot;
  private currentUi: ClientUiState;
  private readonly ui: UiStateStore;
  private readonly pending = new Map<string, { operation: Request["operation"]; resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly snapshots = new Set<(snapshot: SharedStateSnapshot) => void>();
  private readonly feedback = new Set<(feedback: CommandFeedback) => void>();
  private readonly notices = new Set<(notice: DaemonNotice) => void>();
  private disconnected = false;
  private constructor(private readonly socket: Socket, welcome: Record<string, unknown>) {
    this.id = welcome.clientId as string;
    this.snapshot = freezeTree(validateSnapshot(welcome.snapshot));
    this.currentUi = validateUiState(welcome.uiState);
    this.ui = new UiStateStore(this.currentUi);
  }

  static async connect(socketPath: string, options: { protocolVersion?: number; timeoutMs?: number } = {}): Promise<UnixDaemonClient> {
    await assertPrivateOwnedSocket(socketPath);
    const socket = createConnection(socketPath);
    const decoder = new FrameDecoder();
    const timeoutMs = options.timeoutMs ?? 5_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("Timed out connecting to TMU Daemon")); }, timeoutMs);
      const fail = (error: Error) => { clearTimeout(timer); reject(error); };
      socket.once("error", fail);
      socket.on("data", (chunk) => {
        try {
          for (const message of decoder.push(chunk)) {
            if (!isRecord(message)) throw new Error("Invalid daemon message");
            if (message.type === "protocolError") {
              assertExactKeys(message, ["type", "expected", "received"]);
              if (!Number.isInteger(message.expected) || !Number.isInteger(message.received)) throw new Error("Invalid protocol error");
              throw new DaemonProtocolMismatchError(message.expected as number, message.received as number);
            }
            if (message.type !== "welcome" || message.protocolVersion !== (options.protocolVersion ?? DAEMON_PROTOCOL_VERSION)
              || typeof message.clientId !== "string" || typeof message.daemonVersion !== "string") throw new Error("Invalid daemon welcome");
            assertExactKeys(message, ["type", "protocolVersion", "daemonVersion", "clientId", "snapshot", "uiState"]);
            validateSnapshot(message.snapshot); validateUiState(message.uiState);
            clearTimeout(timer); socket.off("error", fail);
            const client = new UnixDaemonClient(socket, message);
            socket.removeAllListeners("data");
            client.install(decoder);
            resolve(client);
          }
        } catch (error) { socket.destroy(); fail(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.once("connect", () => socket.write(encodeFrame({ type: "hello", protocolVersion: options.protocolVersion ?? DAEMON_PROTOCOL_VERSION,
        clientVersion: packageVersion(), clientIdentity: crypto.randomUUID() })));
    });
  }

  get uiState(): Readonly<ClientUiState> { return { ...this.ui.snapshot, viewedPlaylistId: this.currentUi.viewedPlaylistId }; }
  dispatchUi(action: UiStateAction): Readonly<ClientUiState> { this.ui.dispatch(action); return this.uiState; }
  submit(command: SharedCommand) { return this.request("submit", command) as Promise<CommandFeedback>; }
  requestChallenge(request: { kind: ConfirmationChallenge["kind"]; targetId: string }) { return this.request("requestChallenge", request) as Promise<ConfirmationChallenge>; }
  confirmChallenge(token: string) { return this.request("confirmChallenge", { token }) as Promise<CommandFeedback>; }
  async cancelChallenge(token: string) { await this.request("cancelChallenge", { token }); }
  onSnapshot(listener: (snapshot: SharedStateSnapshot) => void) { return subscribe(this.snapshots, listener); }
  onFeedback(listener: (feedback: CommandFeedback) => void) { return subscribe(this.feedback, listener); }
  onNotice(listener: (notice: DaemonNotice) => void) { return subscribe(this.notices, listener); }
  disconnect() { this.disconnected = true; this.socket.end(); this.socket.destroy(); }

  private request(operation: Request["operation"], payload: unknown): Promise<unknown> {
    if (this.disconnected) return Promise.reject(new Error("DaemonClient is disconnected"));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { operation, resolve, reject });
      this.socket.write(encodeFrame({ type: "request", requestId, operation, payload }));
    });
  }
  private install(decoder: FrameDecoder): void {
    this.socket.on("data", (chunk) => {
      try { for (const message of decoder.push(chunk)) this.handle(message); }
      catch (error) { this.failAll(error instanceof Error ? error : new Error(String(error))); this.socket.destroy(); }
    });
    this.socket.on("close", () => this.failAll(new Error("TMU Daemon connection closed")));
    this.socket.on("error", (error) => this.failAll(error));
  }
  private handle(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid daemon message");
    if (value.type === "snapshot") {
      assertExactKeys(value, ["type", "snapshot"]);
      const snapshot = validateSnapshot(value.snapshot);
      if (snapshot.revision <= this.snapshot.revision) return;
      this.snapshot = freezeTree(snapshot);
      for (const fn of this.snapshots) fn(this.snapshot);
      return;
    }
    if (value.type === "feedback") { assertExactKeys(value, ["type", "feedback"]); const feedback = validateFeedback(value.feedback); for (const fn of this.feedback) fn(feedback); return; }
    if (value.type === "notice") { assertExactKeys(value, ["type", "notice"]); const notice = validateNotice(value.notice); for (const fn of this.notices) fn(notice); return; }
    if (value.type === "response" && typeof value.requestId === "string" && typeof value.ok === "boolean") {
      const pending = this.pending.get(value.requestId); if (!pending) return;
      assertExactKeys(value, ["type", "requestId", "ok", "uiState"], value.ok ? ["result"] : ["error"]);
      const nextUi = validateUiState(value.uiState);
      if (value.ok) {
        const result = pending.operation === "submit" || pending.operation === "confirmChallenge" ? validateFeedback(value.result)
          : pending.operation === "requestChallenge" ? validateChallenge(value.result) : (value.result === undefined ? undefined : invalidResponse());
        this.pending.delete(value.requestId); this.currentUi = nextUi;
        pending.resolve(result);
      } else {
        if (typeof value.error !== "string") throw new Error("Invalid daemon response error");
        this.pending.delete(value.requestId); this.currentUi = nextUi;
        pending.reject(new Error(value.error));
      }
      return;
    }
    if (value.type === "fatal") { assertExactKeys(value, ["type", "error"]); if (typeof value.error !== "string") throw new Error("Invalid daemon fatal message"); throw new Error(value.error); }
    throw new Error("Invalid daemon message");
  }
  private failAll(error: Error): void { for (const item of this.pending.values()) item.reject(error); this.pending.clear(); }
}

async function assertPrivateOwnedSocket(socketPath: string): Promise<void> {
  const entry = await lstat(socketPath);
  const uid = process.getuid?.() ?? userInfo().uid;
  if (!entry.isSocket() || entry.uid !== uid || (entry.mode & 0o077) !== 0) {
    throw new Error(`Unsafe TMU Daemon socket: ${socketPath}`);
  }
}

export type BoundedShutdownResult = Readonly<{ clean: boolean; exitCode: 0 | 1; timedOut: boolean; persistenceFailed: boolean; terminated: number[]; refused: number[] }>;

export async function completeBoundedShutdown(options: {
  cleanup: Promise<void>; forceClose(): Promise<void>; finalPersistence(): Promise<void>; ownedChildren?: OwnedChildRegistry;
  graceMs?: number; finalPersistenceMs?: number;
}): Promise<BoundedShutdownResult> {
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanupError = false;
  const clean = await Promise.race([
    options.cleanup.then(() => true, () => { cleanupError = true; return false; }),
    new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), graceMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (clean) return { clean: true, exitCode: 0, timedOut: false, persistenceFailed: false, terminated: [], refused: [] };
  const children = (options.ownedChildren ?? daemonOwnedChildren).terminateVerified();
  await options.forceClose().catch(() => undefined);
  let persistenceFailed = false; let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    options.finalPersistence().catch(() => { persistenceFailed = true; }),
    new Promise<void>((resolve) => { persistenceTimer = setTimeout(() => { persistenceFailed = true; resolve(); }, options.finalPersistenceMs ?? 250); }),
  ]);
  if (persistenceTimer) clearTimeout(persistenceTimer);
  return { clean: false, exitCode: 1, timedOut: !cleanupError, persistenceFailed, ...children };
}

export async function runDaemonProcess(options: { exit?: (code: number) => never } = {}): Promise<void> {
  const paths = await resolveDaemonPaths();
  await appendLog(paths.logPath, `starting pid=${process.pid}`);
  const { coordinator } = await createTmuRuntime();
  const application = new InProcessDaemonApplication(coordinator);
  const server = new UnixDaemonServer(application, paths);
  let requestStop!: () => void;
  const stopped = new Promise<void>((resolve) => { requestStop = resolve; });
  application.onShutdown(requestStop);
  application.onOperationalLog((message) => { void appendDaemonLog(paths.logPath, message); });
  try {
    await application.start();
    await server.listen();
    await writeFile(paths.readyPath, JSON.stringify({ pid: process.pid, protocolVersion: DAEMON_PROTOCOL_VERSION, startedAt: Date.now() }), { mode: 0o600 });
    await rm(paths.lockPath, { recursive: true, force: true });
    await appendLog(paths.logPath, "ready");
    const signalStop = () => { application.requestOperationalShutdown(); requestStop(); };
    process.once("SIGTERM", signalStop); process.once("SIGINT", signalStop);
    await stopped;
    await appendDaemonLog(paths.logPath, "shutdown requested");
  } catch (error) {
    await appendLog(paths.logPath, `fatal ${error instanceof Error ? error.message : String(error)}`);
    await rm(paths.lockPath, { recursive: true, force: true });
    throw error;
  } finally {
    const result = await completeBoundedShutdown({ cleanup: server.close(), forceClose: () => server.forceClose(),
      finalPersistence: () => application.persistFinalSnapshot() });
    if (!result.clean) {
      await appendDaemonLog(paths.logPath, result.timedOut ? "severe graceful shutdown exceeded five-second budget" : "severe shutdown cleanup failed");
      if (result.persistenceFailed) await appendDaemonLog(paths.logPath, "severe final persistence attempt failed or timed out");
      if (result.refused.length) await appendDaemonLog(paths.logPath, `refused unverified child cleanup count=${result.refused.length}`);
      process.exitCode = 1;
    }
    await rm(paths.readyPath, { force: true });
    await appendDaemonLog(paths.logPath, result.clean ? "shutdown complete" : "shutdown cleanup failed");
    if (!result.clean) (options.exit ?? ((code: number) => process.exit(code)))(1);
  }
}

export async function queryDaemonStatus(options: { env?: NodeJS.ProcessEnv; stop?: boolean; expectedImpact?: string } = {}): Promise<DaemonOperationalStatus> {
  const paths = await resolveDaemonPaths(options.env);
  await assertPrivateOwnedSocket(paths.socketPath);
  const socket = createConnection(paths.socketPath);
  const decoder = new FrameDecoder();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`TMU Daemon control handshake timed out. See ${paths.logPath}; verify the PID before manual cleanup.`)); }, 5_000);
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("data", (chunk) => {
      try { for (const message of decoder.push(chunk)) {
        if (isRecord(message) && message.type === "controlError" && typeof message.error === "string") throw new Error(message.error);
        if (!isRecord(message) || message.type !== "controlStatus") throw new Error("Invalid TMU Daemon control response");
        assertExactKeys(message, ["type", "status"]);
        const status = validateOperationalStatus(message.status);
        clearTimeout(timer); socket.end(); resolve(status);
      } } catch (error) { clearTimeout(timer); socket.destroy(); reject(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.once("connect", () => socket.write(encodeFrame({ type: "control", controlVersion: CONTROL_PROTOCOL_VERSION,
      operation: options.stop ? "stop" : "status", ...(options.stop ? { confirmed: true, expectedImpact: options.expectedImpact } : {}) })));
  });
}

export function validateOperationalStatus(value: unknown): DaemonOperationalStatus {
  if (!isRecord(value)) throw new Error("Invalid TMU Daemon control status");
  assertExactKeys(value, ["controlProtocolVersion", "protocolVersion", "daemonVersion", "pid", "uptimeMs", "lifecycle", "runtimePath", "logPath",
    "clientCount", "playingPlaylist", "currentTrack", "playbackStatus", "activeDownloads", "pendingDownloads", "configPath", "configSource",
    "recoveryState", "latestSevereError", "impact"]);
  const integers = ["controlProtocolVersion", "protocolVersion", "pid", "uptimeMs", "clientCount", "activeDownloads", "pendingDownloads"] as const;
  for (const key of integers) if (!Number.isInteger(value[key]) || (value[key] as number) < 0) throw new Error(`Invalid TMU Daemon control status: ${key}`);
  const strings = ["daemonVersion", "runtimePath", "logPath", "playingPlaylist", "playbackStatus", "configPath", "recoveryState", "impact"] as const;
  for (const key of strings) if (typeof value[key] !== "string") throw new Error(`Invalid TMU Daemon control status: ${key}`);
  if (value.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION || (value.pid as number) === 0) throw new Error("Invalid TMU Daemon control status: identity");
  if (!["starting", "ready", "terminating", "stopped"].includes(String(value.lifecycle))) throw new Error("Invalid TMU Daemon control status: lifecycle");
  if (!["idle", "playing", "paused", "stopped", "error"].includes(String(value.playbackStatus))) throw new Error("Invalid TMU Daemon control status: playbackStatus");
  if (!["defaults", "file"].includes(String(value.configSource))) throw new Error("Invalid TMU Daemon control status: configSource");
  if (value.currentTrack !== null && typeof value.currentTrack !== "string") throw new Error("Invalid TMU Daemon control status: currentTrack");
  if (value.latestSevereError !== null && typeof value.latestSevereError !== "string") throw new Error("Invalid TMU Daemon control status: latestSevereError");
  return value as DaemonOperationalStatus;
}

export async function connectOrStartDaemon(options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<TuiDaemonClient> {
  const paths = await resolveDaemonPaths(options.env);
  try { return adaptDaemonClientForTui(await UnixDaemonClient.connect(paths.socketPath, { timeoutMs: 500 })); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
  }
  let winner = false;
  try { await mkdir(paths.lockPath, { mode: 0o700 }); winner = true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (winner) {
    await rm(paths.readyPath, { force: true });
    const entry = fileURLToPath(new URL("./cli.js", import.meta.url));
    const child = spawn(process.execPath, [entry, "--tmu-daemon-process"], { detached: true, stdio: "ignore", env: options.env ?? process.env });
    child.unref();
  }
  const deadline = Date.now() + (options.timeoutMs ?? STARTUP_TIMEOUT_MS);
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { return adaptDaemonClientForTui(await UnixDaemonClient.connect(paths.socketPath, { timeoutMs: 250 })); }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw new Error(`TMU Daemon failed to become ready. See ${paths.logPath}. ${lastError instanceof Error ? lastError.message : ""}`);
}

function subscribe<T>(set: Set<(value: T) => void>, listener: (value: T) => void): () => void { set.add(listener); return () => set.delete(listener); }
function packageVersion(): string { return process.env.npm_package_version ?? "0.3.0"; }
export async function appendDaemonLog(path: string, message: string, maximumBytes = LOG_MAX_BYTES): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const safe = redactLogMessage(message);
  try { if ((await stat(path)).size >= maximumBytes) { await rm(`${path}.1`, { force: true }); await rename(path, `${path}.1`); } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const handle = await open(path, "a", 0o600); try { await handle.appendFile(`${new Date().toISOString()} ${safe}\n`); } finally { await handle.close(); }
}

const appendLog = appendDaemonLog;

export function redactLogMessage(message: string): string {
  return message
    .replace(/https?:\/\/(?:www\.)?(?:youtube\.com|music\.youtube\.com|youtu\.be)\/\S+/gi, "[redacted-youtube-url]")
    .replace(/(?:\/[^\s/]+){3,}/g, "[redacted-path]")
    .replace(/\b(query|input|search)=(?:"[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]");
}

async function operationalStatus(application: InProcessDaemonApplication, paths: DaemonPaths): Promise<DaemonOperationalStatus> {
  const { lifecycle, clientCount, snapshot } = application.status;
  const state = snapshot.state;
  const playlist = state.playlists.playlists.find((item) => item.id === state.playlists.playingPlaylistId)!;
  const identity = state.playback.currentTrackIdentity;
  const track = identity ? playlist.entries.find((item) => item.track.identity.providerId === identity.providerId && item.track.identity.stableId === identity.stableId)?.track.title ?? identity.stableId : null;
  const active = state.downloads.activeBatch ? 1 : 0; const pending = state.downloads.pendingBatches.length;
  let latestSevereError: string | null = null;
  try {
    const lines = (await readFile(paths.logPath, "utf8")).split("\n").filter((line) => /\b(?:fatal|severe|persistence.*fail)/i.test(line));
    latestSevereError = lines.at(-1)?.slice(0, 500) ?? null;
  } catch { /* A new daemon may not have written a log entry yet. */ }
  return { controlProtocolVersion: CONTROL_PROTOCOL_VERSION, protocolVersion: DAEMON_PROTOCOL_VERSION, daemonVersion: packageVersion(), pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000), lifecycle, runtimePath: paths.runtimeDirectory, logPath: paths.logPath, clientCount,
    playingPlaylist: playlist.name, currentTrack: track, playbackStatus: state.playback.status, activeDownloads: active, pendingDownloads: pending,
    configPath: state.configPath, configSource: state.configSource, recoveryState: "normal", latestSevereError,
    impact: `Shut down TMU Daemon with ${identity ? "active playback" : "no active playback"}, ${active} active and ${pending} pending downloads, and ${clientCount} connected clients` };
}

function freezeTree<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) freezeTree(nested);
  return value;
}

async function removeOwnedSocket(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    const uid = process.getuid?.() ?? userInfo().uid;
    if (!entry.isSocket() || entry.uid !== uid) throw new Error(`Refusing unsafe TMU socket path: ${path}`);
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function invalidResponse(): never { throw new Error("Invalid daemon response result"); }
