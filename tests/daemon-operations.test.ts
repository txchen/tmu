import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cleanup as cleanupTui, render } from "@vue-tui/testing";
import { createTmuApp } from "../src/app";
import { InProcessDaemonApplication } from "../src/daemon-client";
import { appendDaemonLog, queryDaemonStatus, redactLogMessage, resolveDaemonPaths, UnixDaemonServer } from "../src/daemon-runtime";
import { finishTuiSession } from "../src/main";
import { createTmuRoot } from "../src/vue-tui/component";

const cleanupFns: Array<() => Promise<void>> = [];
afterEach(async () => { cleanupTui(); while (cleanupFns.length) await cleanupFns.pop()!(); });

describe("daemon operations", () => {
  test("a peer-confirmed shutdown is terminal and broadcasts its live impact", async () => {
    const { coordinator } = createTmuApp();
    const daemon = new InProcessDaemonApplication(coordinator);
    await daemon.start(); cleanupFns.push(() => daemon.teardown());
    const requester = await daemon.connect(); const peer = await daemon.connect();
    const notices: string[] = []; peer.onNotice((notice) => notices.push(notice.message));

    const challenge = await requester.requestChallenge({ kind: "shutdown-daemon", targetId: "daemon" });
    expect(challenge.impact).toContain("2 connected clients");
    await expect(requester.confirmChallenge(challenge.token)).resolves.toMatchObject({ status: "success" });
    expect(notices).toEqual([expect.stringContaining("peer client's request")]);
    await expect(peer.submit({ type: "adjustVolume", delta: 5 })).resolves.toMatchObject({
      status: "error", message: "TMU Daemon is shutting down",
    });
    await expect(daemon.connect()).rejects.toThrow("shutting down");
    expect(daemon.status.lifecycle).toBe("terminating");
  });

  test("status and stop use the control handshake independently of the normal protocol", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmu-operations-"));
    const env = { ...process.env, XDG_RUNTIME_DIR: join(root, "run"), XDG_STATE_HOME: join(root, "state") };
    await mkdir(env.XDG_RUNTIME_DIR, { mode: 0o700 });
    const paths = await resolveDaemonPaths(env);
    const { coordinator } = createTmuApp({ configPath: join(root, "config.json"), configSource: "defaults" });
    const daemon = new InProcessDaemonApplication(coordinator); await daemon.start();
    const server = new UnixDaemonServer(daemon, paths); await server.listen();
    cleanupFns.push(() => server.close());

    const status = await queryDaemonStatus({ env });
    expect(status).toMatchObject({ lifecycle: "ready", protocolVersion: expect.any(Number), controlProtocolVersion: 1,
      configPath: join(root, "config.json"), configSource: "defaults", currentTrack: null });
    expect(status.runtimePath).toBe(paths.runtimeDirectory);
    await expect(queryDaemonStatus({ env, stop: true, expectedImpact: "stale impact" })).rejects.toThrow("impact changed");
    expect(daemon.status.lifecycle).toBe("ready");
    await queryDaemonStatus({ env, stop: true, expectedImpact: status.impact });
    expect(daemon.status.lifecycle).toBe("terminating");
  });

  test("raw-mode Ctrl-Q displays the daemon's challenge and cancellation or acceptance is explicit", async () => {
    const { coordinator } = createTmuApp(); const daemon = new InProcessDaemonApplication(coordinator);
    await daemon.start(); cleanupFns.push(() => daemon.teardown());
    let shutdownNoticeObserved = false;
    const client = await daemon.connectTui(); const terminal = await render(createTmuRoot({
      client,
      noColor: true,
      onDaemonShutdownNotice: () => { shutdownNoticeObserved = true; },
    }), { columns: 100, rows: 24 });
    await terminal.stdin.write("\x11");
    expect(terminal.lastFrame()).toContain("Shut down TMU Daemon?");
    expect(terminal.lastFrame()).toContain("1 connected clients");
    await terminal.stdin.write("n");
    expect(daemon.status.lifecycle).toBe("ready");
    await terminal.stdin.write("\x11"); await terminal.stdin.write("y");
    expect(daemon.status.lifecycle).toBe("terminating");
    expect(shutdownNoticeObserved).toBe(true);
  });

  test("prints shutdown confirmation after TUI teardown and stays silent for an ordinary exit", async () => {
    const events: string[] = [];
    await finishTuiSession(
      async () => { events.push("teardown"); },
      true,
      (message) => events.push(message),
    );
    expect(events).toEqual(["teardown", "TMU Daemon is shutting down.\n"]);

    events.length = 0;
    await finishTuiSession(async () => { events.push("teardown"); }, false, (message) => events.push(message));
    expect(events).toEqual(["teardown"]);
  });

  test("logs redact sensitive values and retain one bounded predecessor", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmu-log-")); const path = join(root, "daemon.log");
    expect(redactLogMessage("failed https://youtube.com/watch?v=secret input=hunter2 /Users/alice/Music/private/song.webm"))
      .toBe("failed [redacted-youtube-url] input=[redacted] [redacted-path]");
    await writeFile(path, "x".repeat(64));
    await appendDaemonLog(path, "download failed https://youtu.be/secret", 32);
    expect((await stat(`${path}.1`)).size).toBe(64);
    expect(await readFile(path, "utf8")).toContain("[redacted-youtube-url]");
    expect(await readFile(path, "utf8")).not.toContain("secret");
  });
});
