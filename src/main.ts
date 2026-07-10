#!/usr/bin/env bun
import { createApp } from "@vue-tui/runtime";
import { createTmuRuntime } from "./app";
import { createTmuRoot } from "./vue-tui/component";
import { dispatchTerminalResize } from "./vue-tui/resize";
import type { AppCoordinator } from "./coordinator";

export async function main(): Promise<void> {
  const { coordinator } = await createTmuRuntime();
  await runTmu(coordinator);
}

export async function runTmu(coordinator: AppCoordinator): Promise<void> {
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
  const terminateFromFatal = (error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`Fatal error: ${message}\n`);
    terminateFromSignal(1);
  };
  const handleUncaughtException = (error: Error) => terminateFromFatal(error);
  const handleUnhandledRejection = (reason: unknown) => terminateFromFatal(reason);
  const installSignalHandlers = () => {
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    process.off("SIGHUP", handleSighup);
    process.off("uncaughtException", handleUncaughtException);
    process.off("unhandledRejection", handleUnhandledRejection);
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
    process.once("SIGHUP", handleSighup);
    process.once("uncaughtException", handleUncaughtException);
    process.once("unhandledRejection", handleUnhandledRejection);
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
    process.off("uncaughtException", handleUncaughtException);
    process.off("unhandledRejection", handleUnhandledRejection);
    app.unmount();
    await coordinator.teardown();
  }
}

if (import.meta.main) await main();
