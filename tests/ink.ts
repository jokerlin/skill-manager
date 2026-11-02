import { EventEmitter } from "node:events";
import { render as inkRender } from "ink";
import type { ReactNode } from "react";

/**
 * ink-testing-library's render, with a terminal of a fixed size.
 *
 * Its fake stdout has `columns` but no `rows`. Ink then asks the `terminal-size` package, which (without a /dev/tty,
 * as under CI or a piped `bun test`) runs `tput cols` and `tput lines` with execFileSync on every layout: about 340
 * blocking spawns for tests/tui.test.tsx. A spawn that stalled pushed a test past its timeout, and after such a timeout
 * bun sometimes hung at 100% CPU next to the unreaped `tput`. With a tty, the tests rendered at the real window's height.
 */
export const COLUMNS = 100;
export const ROWS = 24;

class Stdout extends EventEmitter {
  readonly columns = COLUMNS;
  readonly rows = ROWS;
  readonly frames: string[] = [];
  private last: string | undefined;
  write = (frame: string): void => { this.frames.push(frame); this.last = frame; };
  lastFrame = (): string | undefined => this.last;
}

class Stdin extends EventEmitter {
  readonly isTTY = true;
  private data: string | null = null;
  write = (data: string): void => { this.data = data; this.emit("readable"); this.emit("data", data); };
  read = (): string | null => { const d = this.data; this.data = null; return d; };
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

const mounted = new Set<() => void>();

export const render = (tree: ReactNode) => {
  const stdout = new Stdout();
  const stderr = new Stdout();
  const stdin = new Stdin();
  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const unmount = (): void => { mounted.delete(unmount); instance.unmount(); };
  mounted.add(unmount);
  return { rerender: instance.rerender, unmount, stdout, stdin, frames: stdout.frames, lastFrame: stdout.lastFrame };
};

/** Unmount whatever a test left mounted (a test that timed out never reaches its own unmount). */
export const cleanup = (): void => { [...mounted].forEach((u) => u()); };
