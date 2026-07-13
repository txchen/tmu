const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const originalExecFile = childProcess.execFile;
childProcess.execFile = function observedExecFile(file, ...args) {
  if (file === "/usr/bin/osascript" && process.env.TMU_OSASCRIPT_SENTINEL) {
    fs.writeFileSync(process.env.TMU_OSASCRIPT_SENTINEL, "called");
  }
  return originalExecFile.call(this, file, ...args);
};
syncBuiltinESMExports();
