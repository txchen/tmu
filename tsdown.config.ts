import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "playback-benchmark": "src/playback-benchmark-cli.ts",
    "background-sounds": "src/background-sounds.ts",
  },
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  fixedExtension: false,
  deps: { neverBundle: ["@vue-tui/runtime", "vue"] },
  codeSplitting: false,
});
