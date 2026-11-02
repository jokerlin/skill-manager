import { EventEmitter } from "node:events";
import { expect, mock, test } from "bun:test";
import React from "react";
import { Text, render as inkRender, useWindowSize } from "ink";

// Ink falls back to terminal-size when stdout has no rows; without a tty that runs `tput` synchronously on every layout
let asked = 0;
mock.module("terminal-size", () => ({ default: () => { asked += 1; return { columns: 80, rows: 24 }; } }));

const Size = () => { const { columns, rows } = useWindowSize(); return <Text>{`${columns}x${rows}`}</Text>; };
const tick = () => new Promise((r) => setTimeout(r, 30));

test("the TUI test render has a fixed terminal size, so Ink never asks terminal-size", async () => {
  const { render, COLUMNS, ROWS } = await import("./ink");
  asked = 0;
  const r = render(<Size />); await tick();
  expect(r.lastFrame()).toBe(`${COLUMNS}x${ROWS}`);
  expect(asked).toBe(0);
  r.unmount();
});

test("a stdout without rows makes Ink ask terminal-size (the case above guards against)", async () => {
  const stdout = Object.assign(new EventEmitter(), { columns: 100, write: () => true });
  asked = 0;
  const r = inkRender(<Size />, { stdout: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false });
  await tick();
  expect(asked).toBeGreaterThan(0);
  r.unmount();
});
