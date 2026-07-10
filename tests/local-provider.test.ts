import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalProvider } from "../src/providers";

describe("LocalProvider", () => {
  test("resolves an existing Local Track and reports when its file disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "tmu-local-provider-"));
    const file = join(root, "track.flac");
    try {
      await writeFile(file, "audio");
      const stableId = await realpath(file);
      const provider = createLocalProvider();
      const identity = { providerId: "local", stableId };

      await expect(provider.resolvePlaybackLocator(identity)).resolves.toEqual({ kind: "file", path: stableId });
      await rm(file);
      await expect(provider.resolvePlaybackLocator(identity)).rejects.toThrow("Local file no longer exists");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
