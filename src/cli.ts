#!/usr/bin/env node

export {};

import { main } from "./main";
import { runDaemonProcess } from "./daemon-runtime";

const minimumNodeMajor = 24;
const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "", 10);

if (!Number.isFinite(nodeMajor) || nodeMajor < minimumNodeMajor) {
  process.stderr.write(`TMU requires Node.js ${minimumNodeMajor} or newer (running ${process.versions.node}).\n`);
  process.exitCode = 1;
} else {
  if (process.argv[2] === "--tmu-daemon-process") await runDaemonProcess();
  else await main();
}
