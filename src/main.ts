#!/usr/bin/env bun
import { createTmuRuntime } from "./app";
import { NAVIGATION_TARGETS, type NavigationTargetId } from "./domain";
import { renderShellText } from "./renderer";
import { TerminalTui } from "./tui";

type RuntimeArgs = {
  snapshot: boolean;
  snapshotTargetId?: NavigationTargetId;
  cliFileArgs: string[];
};

export function parseRuntimeArgs(args: readonly string[]): RuntimeArgs {
  let snapshot = false;
  let snapshotTargetId: NavigationTargetId | undefined;
  const cliFileArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--snapshot") {
      snapshot = true;
      continue;
    }

    if (arg === "--snapshot-target") {
      const value = args[index + 1];
      if (!value) throw new Error("--snapshot-target requires a navigation target id");
      snapshotTargetId = navigationTargetIdFromArg(value);
      index += 1;
      continue;
    }

    if (arg.startsWith("--snapshot-target=")) {
      snapshotTargetId = navigationTargetIdFromArg(arg.slice("--snapshot-target=".length));
      continue;
    }

    if (arg.startsWith("--")) continue;
    cliFileArgs.push(arg);
  }

  return { snapshot, snapshotTargetId, cliFileArgs };
}

export async function main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const runtime = parseRuntimeArgs(args);
  const snapshotMode = runtime.snapshot || !process.stdin.isTTY || !process.stdout.isTTY;
  const app = await createTmuRuntime({ startPlayer: !snapshotMode });
  await app.coordinator.start(runtime.cliFileArgs);
  if (runtime.snapshotTargetId) {
    await app.coordinator.dispatch({ type: "selectNavigationTarget", targetId: runtime.snapshotTargetId });
  }

  if (snapshotMode) {
    try {
      process.stdout.write(`${renderShellText(app.coordinator.appState, app.coordinator.uiState)}\n`);
    } finally {
      await app.coordinator.teardown();
    }
    return;
  }

  new TerminalTui(app).run();
}

if (import.meta.main) {
  await main();
}

function navigationTargetIdFromArg(value: string): NavigationTargetId {
  const targetId = NAVIGATION_TARGETS.find((target) => target.id === value)?.id;
  if (!targetId) throw new Error(`Unknown snapshot target: ${value}`);
  return targetId;
}
