import { createApp } from "@vue-tui/runtime";
import { createTmuRuntime } from "./app";
import { createTmuRoot } from "./vue-tui/component";
import { dispatchTerminalResize } from "./vue-tui/resize";
import { InProcessDaemonApplication, type TuiDaemonClient } from "./daemon-client";

export async function main(): Promise<void> {
  const { coordinator } = await createTmuRuntime();
  const daemon = new InProcessDaemonApplication(coordinator);
  await daemon.start();
  const client = await daemon.connectTui();
  await runTmu(client, () => daemon.teardown());
}

export async function runTmu(client: TuiDaemonClient, teardown: () => Promise<void> = async () => undefined): Promise<void> {
  const app = createApp(createTmuRoot({ client }));
  const handlePtyResize = () => {
    dispatchTerminalResize(
      client,
      process.stdout.columns ?? client.uiState.terminal.columns,
      process.stdout.rows ?? client.uiState.terminal.rows,
    );
  };
  process.on("SIGWINCH", handlePtyResize);

  let terminating = false;
  const terminateFromSignal = (exitCode: number) => {
    if (terminating) return;
    terminating = true;
    app.unmount();
    void teardown().finally(() => process.exit(exitCode));
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
    process.off("SIGWINCH", handlePtyResize);
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
    process.off("SIGHUP", handleSighup);
    process.off("uncaughtException", handleUncaughtException);
    process.off("unhandledRejection", handleUnhandledRejection);
    app.unmount();
    await teardown();
  }
}
