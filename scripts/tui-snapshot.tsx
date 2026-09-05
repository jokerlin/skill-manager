#!/usr/bin/env bun
// Render the real TUI headlessly (real config, real ssh probes) and dump one plain-text frame per view.
// Usage: bun scripts/tui-snapshot.tsx [out.txt] [waitMs]
import React from "react";
import { render } from "ink-testing-library";
import { appErrorText, loadApp } from "../src/shell/app";
import { readEvalCache } from "../src/shell/cache";
import { App } from "../src/tui/App";
import { realIo } from "../src/tui/io";

const VIEWS = [["1", "skills"], ["2", "hosts"], ["3", "sync"], ["4", "insights"]] as const;
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const out = process.argv[2] ?? "tui-frames.txt";
const waitMs = Number(process.argv[3] ?? 30000);
const app = await loadApp();
if (!app.ok) { console.error(appErrorText(app.error)); process.exit(1); }
const evals = await readEvalCache(app.value.skmHome);
const r = render(<App app={app.value} io={realIo(app.value)} evals={evals} />);
await wait(waitMs);
const frames = await VIEWS.reduce(async (acc, [key, name]) => {
  const prev = await acc;
  r.stdin.write(key);
  await wait(300);
  return [...prev, `══════ view ${key}: ${name} ══════\n${stripAnsi(r.lastFrame() ?? "")}\n`];
}, Promise.resolve<string[]>([]));
r.unmount();
await Bun.write(out, frames.join("\n"));
console.log(`wrote ${out}`);
process.exit(0);
