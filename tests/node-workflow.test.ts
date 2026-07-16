import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("supported Node and npm workflow", () => {
  test("exposes every supported development and verification command", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      engines: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(pkg.engines).toEqual({ node: ">=24.0.0" });
    expect(pkg.scripts).toMatchObject({
      start: expect.any(String),
      build: expect.any(String),
      typecheck: expect.any(String),
      test: expect.any(String),
      "smoke:package": expect.any(String),
      "test:integration": expect.any(String),
      "test:unit": expect.any(String),
      "benchmark:playback": expect.any(String),
    });
  });

  test("documents installation, platforms, External Tools, and contributor commands", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).toContain("Node.js 24 or newer");
    expect(readme).toContain("npx @txchen/tmu");
    expect(readme).toContain("npm install --global @txchen/tmu");
    expect(readme).toMatch(/Linux.*macOS.*WSL/s);
    expect(readme).toMatch(/native Windows.*not supported/i);
    expect(readme).toMatch(/Node\.js and npm.*runtime/i);
    expect(readme).toMatch(/mpv.*yt-dlp.*External Tools/s);
    for (const command of ["npm run start", "npm run build", "npm run typecheck", "npm test", "npm run smoke:package", "npm run benchmark:playback"]) {
      expect(readme).toContain(command);
    }
  });

  test("contains no Bun artifact or active workflow reference", async () => {
    const files = [
      "package.json",
      "package-lock.json",
      "README.md",
      "AGENTS.md",
      "CONTEXT.md",
      "tsconfig.json",
      "tsdown.config.ts",
      ...await filesUnder("docs"),
      ...await filesUnder(".github"),
      ...await filesUnder("src"),
      ...await filesUnder("tests"),
      ...await filesUnder("scripts"),
    ];

    for (const file of files) {
      if ([
        "tests/node-workflow.test.ts",
        "tests/packaging-smoke.test.ts",
        "docs/adr/0002-use-node-for-runtime-and-distribution.md",
        "docs/research/bun-vs-node-efficiency.md",
      ].includes(file)) continue;
      expect(await readFile(file, "utf8"), file).not.toMatch(/\bbun(?:x)?\b|@types\/bun|bun\.lock|bunfig/i);
    }

    const comparison = await readFile("docs/research/bun-vs-node-efficiency.md", "utf8");
    expect(comparison).toContain("Historical note:");
    expect(comparison).not.toMatch(/TMU currently uses|Production source uses/);
  });

  test("verifies every supported platform and Node runtime in CI", async () => {
    const workflow = await readFile(".github/workflows/verify.yml", "utf8");

    expect(workflow).toMatch(/- os: ubuntu-latest\s+node-version: 24/);
    expect(workflow).toMatch(/- os: ubuntu-latest\s+node-version: latest/);
    expect(workflow).toMatch(/- os: macos-latest\s+node-version: 24/);
    for (const command of [
      "npm ci",
      "npm run typecheck",
      "npm run test:unit",
      "npm run test:integration",
      "npm run build",
      "npm run smoke:package",
    ]) {
      expect(workflow).toContain(`run: ${command}`);
    }
  });
});

async function filesUnder(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? await filesUnder(path) : [path];
  }));
  return nested.flat();
}
