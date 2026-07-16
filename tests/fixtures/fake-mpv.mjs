#!/usr/bin/env node

import net from "node:net";
import { rmSync } from "node:fs";

if (process.argv.includes("--version")) {
  process.stdout.write("mpv fake-package-smoke\n");
  process.exit(0);
}

const socketPath = process.argv.find((arg) => arg.startsWith("--input-ipc-server="))?.slice("--input-ipc-server=".length);
if (!socketPath) process.exit(2);
try { rmSync(socketPath); } catch { /* absent */ }

const server = net.createServer((socket) => {
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString();
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const request = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      const command = request.command?.[0];
      socket.write(`${JSON.stringify({ error: "success", request_id: request.request_id, data: command === "get_property" ? 1 : null })}\n`);
      if (command === "loadfile") {
        socket.write(`${JSON.stringify({ event: "property-change", name: "duration", data: 600 })}\n`);
        socket.write(`${JSON.stringify({ event: "property-change", name: "idle-active", data: false })}\n`);
        socket.write(`${JSON.stringify({ event: "property-change", name: "pause", data: false })}\n`);
      }
      if (command === "quit") server.close(() => process.exit(0));
    }
  });
});
server.listen(socketPath);
