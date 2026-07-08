export const LINUX_X64_ARTIFACT = "dist/tmu-linux-x64";

export const LINUX_X64_BUILD_ARGS = [
  "build",
  "--compile",
  "--target=bun-linux-x64-baseline",
  `--outfile=${LINUX_X64_ARTIFACT}`,
  "src/main.ts",
] as const;

export const LINUX_X64_SMOKE_SCRIPT = `bun run build:linux-x64 && bun scripts/smoke-linux-x64.ts ${LINUX_X64_ARTIFACT}`;

export type LinuxX64SmokeOutput = {
  startup: string;
  localSeed: string;
  navidrome: string;
  offlineCache: string;
  missingYtDlp: string;
};

export function assertLinuxX64SmokeOutput(output: LinuxX64SmokeOutput): void {
  assertContains(output.startup, [
    "TMU",
    "Local",
    "Queue / Player Strip",
    "Dependency Health",
    "mpv: present",
    "ffprobe: present",
    "yt-dlp: present",
  ], "startup");

  assertContains(output.localSeed, [
    "Expanded Queue",
    "seed.mp3 - Local - queued",
  ], "local seed");

  assertContains(output.navidrome, [
    "Navidrome",
    "Navidrome: connected",
    "Smoke Artist",
  ], "Navidrome fake");

  assertContains(output.offlineCache, [
    "Offline YouTube Cache",
    "Cached Smoke Track",
  ], "Offline YouTube Cache");

  assertContains(output.missingYtDlp, [
    "YouTube URL Download",
    "yt-dlp: missing",
    "YouTube URL Download disabled",
    "! YouTube URL Download disabled:",
  ], "missing yt-dlp");
}

function assertContains(text: string, snippets: readonly string[], label: string): void {
  for (const snippet of snippets) {
    if (text.includes(snippet)) continue;
    throw new Error(`Linux x64 smoke ${label} output did not include ${JSON.stringify(snippet)}`);
  }
}
