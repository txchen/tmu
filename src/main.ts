#!/usr/bin/env bun
import { createApp } from "@vue-tui/runtime";
import { createTmuRuntime } from "./app";
import { createTmuRoot } from "./vue-tui/component";

export async function main(): Promise<void> {
  const runtime = await createTmuRuntime();
  const { coordinator } = runtime;
  await coordinator.start();

  const app = createApp(createTmuRoot({ coordinator }));
  const handleBunPtyResize = () => {
    coordinator.dispatchUi({
      type: "resize",
      columns: process.stdout.columns ?? coordinator.uiState.terminal.columns,
      rows: process.stdout.rows ?? coordinator.uiState.terminal.rows,
      queueIdentities: coordinator.queueTrackIdentities(),
      visibleQueueRows: Math.max(1, (process.stdout.rows ?? 24) - 5),
    });
  };
  process.on("SIGWINCH", handleBunPtyResize);
  app.mount({
    alternateScreen: true,
    interactive: true,
    patchConsole: false,
  });

  let terminating = false;
  const terminateFromSignal = (exitCode: number) => {
    if (terminating) return;
    terminating = true;
    app.unmount();
    void coordinator.teardown().finally(() => process.exit(exitCode));
  };
  const handleSigint = () => terminateFromSignal(130);
  const handleSigterm = () => terminateFromSignal(143);
  const handleSighup = () => terminateFromSignal(129);
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);
  process.once("SIGHUP", handleSighup);

  try {
    await app.waitUntilExit();
  } finally {
    process.off("SIGWINCH", handleBunPtyResize);
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    process.off("SIGHUP", handleSighup);
    app.unmount();
    await coordinator.teardown();
  }
}

if (import.meta.main) await main();
