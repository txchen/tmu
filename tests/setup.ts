import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateHomeMarker = "TMU_VITEST_STATE_HOME";
const existingTestStateHome = process.env[stateHomeMarker];
const testStateHome = existingTestStateHome ?? mkdtempSync(join(tmpdir(), "tmu-vitest-state-"));
process.env[stateHomeMarker] = testStateHome;
process.env.XDG_STATE_HOME = testStateHome;
if (!existingTestStateHome) {
  process.once("exit", () => rmSync(testStateHome, { recursive: true, force: true }));
}
