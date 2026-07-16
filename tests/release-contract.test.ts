import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("TMU 0.4.0 release contract", () => {
  test("ships daemon architecture guidance and migration recovery instructions", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as { version: string; bin: Record<string, string>; files: string[] };
    expect(manifest.version).toBe("0.4.0");
    expect(manifest.bin).toEqual({ tmu: "dist/cli.js" });
    expect(manifest.files).toContain("RELEASE_NOTES.md");

    const readme = await readFile("README.md", "utf8");
    for (const phrase of ["TMU Daemon", "TUI Client", "Quit Client", "Shutdown Daemon", "Playing Playlist", "Viewed Playlist",
      "tmu daemon status", "tmu daemon stop", "loaded once by the TMU Daemon"]) expect(readme).toContain(phrase);
    expect(readme).toMatch(/`q` and `Ctrl-C` Quit Client.*playback and downloads running/s);
    expect(readme).toMatch(/no legacy single-process mode or public daemon-start command/i);

    const notes = await readFile("RELEASE_NOTES.md", "utf8");
    expect(notes).toMatch(/close every pre-0\.4\.0 TMU process/i);
    expect(notes).toContain("last-playlists.json.pre-0.4.0");
    expect(notes).toMatch(/does not provide automatic downgrade/i);
    expect(notes).toMatch(/downgrade manually/i);
    expect(notes).toMatch(/Linux.*macOS.*WSL/s);
  });

  test("documents daemon/client terminal behavior in the TUI experience", async () => {
    const spec = await readFile("docs/tui-experience-spec.md", "utf8");
    for (const phrase of ["TMU Daemon", "TUI Clients", "Quit Client", "Shutdown Daemon", "Playing Playlist", "Viewed Playlist", "Ctrl-Q", "Ctrl-C"]) {
      expect(spec).toContain(phrase);
    }
  });
});
