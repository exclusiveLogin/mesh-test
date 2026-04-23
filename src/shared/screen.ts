import fs from "node:fs";
import path from "node:path";

/**
 * Event-driven fullscreen renderer.
 *
 * - Switches terminal into alt-screen buffer (like vim/less) so after exit
 *   the original history is restored and nothing from the app pollutes it.
 * - Hides cursor. Redraws ONLY on explicit redraw() calls, so there is no
 *   idle CPU cost and the screen is stable between events.
 * - Micro-throttles consecutive redraws into a single frame via microtask
 *   to avoid flicker when many events arrive in the same tick.
 * - Restores the terminal on SIGINT / SIGTERM / exit / uncaughtException.
 */
export interface ScreenOptions {
  /** Force alt-screen even when stdout is not a TTY (noop-safe). */
  force?: boolean;
}

export class Screen {
  private active = false;
  private pending = false;
  private readonly isTTY: boolean;
  private readonly render: () => string[];
  private readonly cleanupBound: () => void;

  constructor(render: () => string[], opts: ScreenOptions = {}) {
    this.render = render;
    this.isTTY = Boolean(process.stdout.isTTY) || Boolean(opts.force);
    this.cleanupBound = () => this.stop();
  }

  start(): void {
    if (this.active) return;
    this.active = true;

    if (this.isTTY) {
      // Enter alt screen + hide cursor.
      process.stdout.write("\x1b[?1049h\x1b[?25l");
    }

    this.paint();

    process.once("SIGINT", this.onSignal(130));
    process.once("SIGTERM", this.onSignal(143));
    process.once("exit", this.cleanupBound);
    process.once("uncaughtException", (err) => {
      this.stop();
      console.error(err);
      process.exit(1);
    });
  }

  /**
   * Request a redraw. Multiple redraw() calls within the same microtask are
   * merged into a single frame (coalescing). Safe to call from any event.
   */
  redraw(): void {
    if (!this.active || this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      if (this.active) this.paint();
    });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.isTTY) {
      // Show cursor + leave alt screen.
      process.stdout.write("\x1b[?25h\x1b[?1049l");
    }
  }

  private paint(): void {
    const frame = this.render();
    if (this.isTTY) {
      process.stdout.write("\x1b[H\x1b[2J" + frame.join("\n"));
    } else {
      process.stdout.write(frame.join("\n") + "\n");
    }
  }

  private onSignal(code: number): () => void {
    return () => {
      this.stop();
      process.exit(code);
    };
  }
}

/**
 * File logger — pipes verbose lines into a log file instead of stderr.
 * Needed when the Screen is active, otherwise stderr breaks alt-screen.
 */
export class FileLogger {
  private readonly stream: fs.WriteStream | null = null;

  constructor(filePath: string | null) {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.stream = fs.createWriteStream(filePath, { flags: "a" });
  }

  log(line: string): void {
    if (!this.stream) return;
    this.stream.write(`${new Date().toISOString()} ${stripAnsi(line)}\n`);
  }

  close(): void {
    this.stream?.end();
  }
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");
