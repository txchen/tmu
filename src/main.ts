#!/usr/bin/env bun
import { createTmuRuntime } from "./app";
import { renderShellText } from "./renderer";
import { TerminalTui } from "./tui";

type RuntimeArgs = {
  snapshot: boolean;
  cliFileArgs: string[];
};

export function parseRuntimeArgs(args: readonly string[]): RuntimeArgs {
  const snapshot = args.includes("--snapshot");
  const cliFileArgs = args.filter((arg) => arg !== "--snapshot" && !arg.startsWith("--"));
  return { snapshot, cliFileArgs };
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const runtime = parseRuntimeArgs(args);
  const app = await createTmuRuntime();
  app.coordinator.start(runtime.cliFileArgs);

  if (runtime.snapshot || !process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`${renderShellText(app.coordinator.appState, app.coordinator.uiState)}\n`);
    return;
  }

  new TerminalTui(app).run();
}

if (import.meta.main) {
  await main();
}
