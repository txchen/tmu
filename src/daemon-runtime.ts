import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmod, lstat, mkdir, open, rm, stat, writeFile } from "node:fs/promises";
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

const STARTUP_TIMEOUT_MS = 15_000;
const SOCKET_NAME = "daemon.sock";

export type DaemonPaths = Readonly<{ runtimeDirectory: string; socketPath: string; lockPath: string; readyPath: string; logPath: string }>;

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
  constructor(private readonly application: InProcessDaemonApplication, readonly paths: DaemonPaths) {}

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

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new FrameDecoder();
    let client: DaemonClient | undefined;
    let initialized = false;
    const send = (message: unknown) => { if (!socket.destroyed) socket.write(encodeFrame(message)); };
    socket.on("data", async (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (!initialized) {
            const hello = validateHello(frame);
            if (hello.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
              send({ type: "protocolError", expected: DAEMON_PROTOCOL_VERSION, received: hello.protocolVersion });
              socket.end(); return;
            }
            client = await this.application.connect();
            initialized = true;
            client.onSnapshot((snapshot) => send({ type: "snapshot", snapshot }));
            client.onFeedback((feedback) => send({ type: "feedback", feedback }));
            client.onNotice((notice) => send({ type: "notice", notice }));
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
              throw new Error(`TMU Daemon protocol mismatch (expected ${message.expected}, received ${message.received})`);
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
    if (value.type === "snapshot") { assertExactKeys(value, ["type", "snapshot"]); this.snapshot = freezeTree(validateSnapshot(value.snapshot)); for (const fn of this.snapshots) fn(this.snapshot); return; }
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

export async function runDaemonProcess(): Promise<void> {
  const paths = await resolveDaemonPaths();
  await appendLog(paths.logPath, `starting pid=${process.pid}`);
  const { coordinator } = await createTmuRuntime();
  const application = new InProcessDaemonApplication(coordinator);
  const server = new UnixDaemonServer(application, paths);
  try {
    await application.start();
    await server.listen();
    await writeFile(paths.readyPath, JSON.stringify({ pid: process.pid, protocolVersion: DAEMON_PROTOCOL_VERSION, startedAt: Date.now() }), { mode: 0o600 });
    await rm(paths.lockPath, { recursive: true, force: true });
    await appendLog(paths.logPath, "ready");
    await new Promise<void>((resolve) => {
      const stop = () => resolve(); process.once("SIGTERM", stop); process.once("SIGINT", stop);
    });
  } catch (error) {
    await appendLog(paths.logPath, `fatal ${error instanceof Error ? error.message : String(error)}`);
    await rm(paths.lockPath, { recursive: true, force: true });
    throw error;
  } finally { await server.close(); await rm(paths.readyPath, { force: true }); }
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
async function appendLog(path: string, message: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600); try { await handle.appendFile(`${new Date().toISOString()} ${message}\n`); } finally { await handle.close(); }
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
