#!/usr/bin/env node

export {};

import { main } from "./main";
import { queryDaemonStatus, runDaemonProcess, type DaemonOperationalStatus } from "./daemon-runtime";
import { createInterface } from "node:readline/promises";

const minimumNodeMajor = 24;
const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "", 10);

if (!Number.isFinite(nodeMajor) || nodeMajor < minimumNodeMajor) {
  process.stderr.write(`TMU requires Node.js ${minimumNodeMajor} or newer (running ${process.versions.node}).\n`);
  process.exitCode = 1;
} else {
  if (process.argv[2] === "--tmu-daemon-process") await runDaemonProcess();
  else if (process.argv[2] === "daemon") await daemonCommand(process.argv.slice(3));
  else await main();
}

async function daemonCommand(args: string[]): Promise<void> {
  const operation = args[0];
  if (operation !== "status" && operation !== "stop") {
    process.stderr.write("Usage: tmu daemon status | tmu daemon stop [--force]\n"); process.exitCode = 2; return;
  }
  try {
    const status = await queryDaemonStatus();
    printStatus(status);
    if (operation === "status") return;
    const force = args.includes("--force");
    if (!force && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      process.stderr.write("Refusing non-interactive daemon stop; use --force to skip confirmation.\n"); process.exitCode = 2; return;
    }
    if (!force) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await prompt.question("Shut down TMU Daemon? [y/N] "); prompt.close();
      if (!/^y(?:es)?$/i.test(answer.trim())) { process.stdout.write("Shutdown cancelled.\n"); return; }
    }
    await queryDaemonStatus({ stop: true, expectedImpact: status.impact });
    process.stdout.write("Graceful daemon shutdown requested.\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`TMU Daemon is unavailable: ${message}\nNo process was signalled. Verify daemon status and process identity before manual cleanup.\n`);
    process.exitCode = 1;
  }
}

function printStatus(status: DaemonOperationalStatus): void {
  process.stdout.write([
    `TMU Daemon: ${status.lifecycle}`, `PID: ${status.pid}`, `Daemon version: ${status.daemonVersion}`,
    `Protocol: ${status.protocolVersion} (control ${status.controlProtocolVersion})`, `Uptime: ${status.uptimeMs} ms`,
    `Runtime: ${status.runtimePath}`, `Log: ${status.logPath}`, `Clients: ${status.clientCount}`,
    `Playing Playlist: ${status.playingPlaylist}`, `Current Track: ${status.currentTrack ?? "none"}`, `Playback: ${status.playbackStatus}`,
    `Downloads: ${status.activeDownloads} active, ${status.pendingDownloads} pending`, `Config: ${status.configPath} (${status.configSource})`,
    `Recovery: ${status.recoveryState}`, `Latest severe error: ${status.latestSevereError ?? "none"}`, `Impact: ${status.impact}`,
  ].join("\n") + "\n");
}
