#!/usr/bin/env bun
import { createApp } from "@vue-tui/runtime";
import { createTmuRuntime } from "./app";
import { createTmuRoot } from "./vue-tui/component";
import { dispatchTerminalResize } from "./vue-tui/resize";

export async function main(): Promise<void> {
  const runtime = await createTmuRuntime();
  const { coordinator } = runtime;
  await coordinator.start();

  const app = createApp(createTmuRoot({ coordinator }));
  const handleBunPtyResize = () => {
    dispatchTerminalResize(
      coordinator,
      process.stdout.columns ?? coordinator.uiState.terminal.columns,
      process.stdout.rows ?? coordinator.uiState.terminal.rows,
    );
  };
  process.on("SIGWINCH", handleBunPtyResize);

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
  const handleSigusr2 = () => {
    process.stderr.write("Fatal error: received SIGUSR2\n");
    terminateFromSignal(1);
  };
  const installSignalHandlers = () => {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    process.off("SIGHUP", handleSighup);
    process.off("SIGUSR2", handleSigusr2);
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
    process.once("SIGHUP", handleSighup);
    process.once("SIGUSR2", handleSigusr2);
  };
  installSignalHandlers();
  app.mount({
    alternateScreen: true,
    interactive: true,
    patchConsole: false,
  });
  installSignalHandlers();

  try {
    await app.waitUntilExit();
  } finally {
    process.off("SIGWINCH", handleBunPtyResize);
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    process.off("SIGHUP", handleSighup);
    process.off("SIGUSR2", handleSigusr2);
    app.unmount();
    await coordinator.teardown();
  }
}

if (import.meta.main) await main();
