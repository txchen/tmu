#!/usr/bin/env node

export {};

import { main } from "./main";

const minimumNodeMajor = 24;
const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "", 10);

if (!Number.isFinite(nodeMajor) || nodeMajor < minimumNodeMajor) {
  process.stderr.write(`TMU requires Node.js ${minimumNodeMajor} or newer (running ${process.versions.node}).\n`);
  process.exitCode = 1;
} else {
  await main();
}
