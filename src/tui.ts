import {
  NAVIGATION_TARGETS,
  type AppIntent,
  type NavigationTargetId,
} from "./domain";
import { renderShellText } from "./renderer";
import type { AppCoordinator } from "./coordinator";

export type RuntimeApp = {
  coordinator: AppCoordinator;
};

export class TerminalTui {
  constructor(
    private readonly app: RuntimeApp,
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {}

  run(): void {
    if (!this.input.isTTY || !this.output.isTTY) {
      this.output.write(renderShellText(this.app.coordinator.appState, this.app.coordinator.uiState));
      return;
    }

    this.input.setRawMode(true);
    this.input.resume();
    this.output.write("\x1b[?25l");
    this.draw();

    this.input.on("data", async (data) => {
      for (const key of splitKeys(data)) {
        const intent = intentFromKey(key);
        if (!intent) continue;
        await this.app.coordinator.dispatch(intent);
        if (intent.type === "quit") {
          this.output.write("\x1b[?25h\x1b[2J\x1b[H");
          this.input.setRawMode(false);
          process.exit(0);
        }
      }
      this.draw();
    });
  }

  private draw(): void {
    this.output.write(`\x1b[2J\x1b[H${renderShellText(this.app.coordinator.appState, this.app.coordinator.uiState)}`);
  }
}

export function intentFromKey(key: string): AppIntent | null {
  if (key === "q" || key === "\u0003") return { type: "quit" };
  if (key === "\t") return { type: "cycleFocus" };
  if (key === "\x1b[A" || key === "\x1b[D") return { type: "moveSelection", delta: -1 };
  if (key === "\x1b[B" || key === "\x1b[C") return { type: "moveSelection", delta: 1 };
  if (key === "\r" || key === "a") return { type: "enqueueSelectedTrack" };
  if (/^[1-5]$/.test(key)) {
    const target = NAVIGATION_TARGETS[Number(key) - 1];
    if (target) return { type: "selectNavigationTarget", targetId: target.id as NavigationTargetId };
  }
  return null;
}

function splitKeys(data: string | Buffer): string[] {
  const raw = data.toString();
  if (raw.startsWith("\x1b[")) return [raw];
  return [...raw];
}
