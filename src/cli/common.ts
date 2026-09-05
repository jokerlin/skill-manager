import pc from "picocolors";
import { type AppState, appErrorText, loadApp } from "../shell/app";
import { serializeConfig, type Config } from "../core/config";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export const die = (msg: string, code = 1): never => {
  process.stderr.write(`${pc.red("error:")} ${msg}\n`);
  process.exit(code);
};

export const withApp = async <T>(f: (app: AppState) => Promise<T>): Promise<T> => {
  const app = await loadApp();
  if (!app.ok) return die(appErrorText(app.error));
  if (app.value.unknownAgents.length > 0) process.stderr.write(pc.yellow(`warning: unknown agents in config: ${app.value.unknownAgents.join(", ")}\n`));
  return f(app.value);
};

export const saveConfig = async (path: string, c: Config): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeConfig(c), "utf8");
};

export const fmtK = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
export const fmtBytes = (n: number): string => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}M` : n >= 1024 ? `${(n / 1024).toFixed(0)}K` : `${n}B`);

/** Left-aligned text table; numbers right-aligned when the column is all-numeric-looking. */
export const table = (header: readonly string[], rows: readonly (readonly string[])[]): string => {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => visibleLen(r[i] ?? ""))));
  const line = (r: readonly string[], bold: boolean) =>
    r.map((c, i) => c + " ".repeat(Math.max(0, (widths[i] ?? 0) - visibleLen(c)))).join("  ").replace(/\s+$/, "") + (bold ? "" : "");
  return [pc.bold(line(header, true)), ...rows.map((r) => line(r, false))].join("\n");
};

const visibleLen = (s: string): number =>
  [...s.replace(/\x1b\[[0-9;]*m/g, "")].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1), 0);

export const out = (s: string): void => { process.stdout.write(s + "\n"); };
export const warnIf = (cond: boolean, s: string): string => (cond ? pc.yellow(s) : s);

export const confirm = (question: string): boolean => {
  const a = prompt(`${question} [y/N]`);
  return a !== null && /^y(es)?$/i.test(a.trim());
};
