import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "../shared/types";

const home = homedir();
const expand = (p: string): string => (p === "~" ? home : p.startsWith("~/") ? `${home}/${p.slice(2)}` : p);

/** GUI apps start with launchd's short PATH; add where bun, brew, mise and ~/.local/bin put things (ssh ProxyCommands such as cloudflared live there too). */
export const childPath = (): string =>
  [process.env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin", `${home}/.local/bin`, `${home}/.bun/bin`, `${home}/.local/share/mise/shims`, "/opt/homebrew/bin", "/usr/local/bin"].join(":");

const executable = (p: string): boolean => {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
};

const which = (cmd: string): string | undefined =>
  cmd.includes("/") ? (executable(expand(cmd)) ? expand(cmd) : undefined) : childPath().split(":").map((d) => `${d}/${cmd}`).find(executable);

/** argv prefix for the CLI: the user's setting, else SKM_COMMAND, else the usual install places, else the bundled copy. undefined = not found. */
export const resolveCommand = (custom: string): readonly string[] | undefined => {
  const text = custom.trim() || (process.env["SKM_COMMAND"] ?? "").trim();
  if (text.length > 0) {
    const [first, ...rest] = text.split(/\s+/);
    const bin = first === undefined ? undefined : which(first);
    return bin === undefined ? undefined : [bin, ...rest.map(expand)];
  }
  // an installed CLI wins (it may be newer); otherwise the copy shipped inside the app bundle
  const bundled = process.resourcesPath ? join(process.resourcesPath, "bin", "skm") : "";
  const found = [`${home}/.local/bin/skm`, "/opt/homebrew/bin/skm", "/usr/local/bin/skm", bundled].find((p) => p !== "" && executable(p));
  return found === undefined ? undefined : [found];
};

const env = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: childPath(), NO_COLOR: "1", FORCE_COLOR: "0" });

/** Run `skm <args>` to completion. Never throws. */
export const runSkm = (cmd: readonly string[] | undefined, args: readonly string[], stdin?: string): Promise<RunResult> =>
  new Promise((resolve) => {
    if (cmd === undefined || cmd[0] === undefined) return resolve({ ok: false, code: null, stderr: "skm CLI not found", notFound: true });
    const p = spawn(cmd[0], [...cmd.slice(1), ...args], { env: env(), stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => err.push(d));
    p.on("error", (e) => resolve({ ok: false, code: null, stderr: e.message, notFound: (e as NodeJS.ErrnoException).code === "ENOENT" }));
    p.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      resolve(code === 0 ? { ok: true, stdout } : { ok: false, code, stderr: stderr || stdout, notFound: false });
    });
    p.stdin.end(stdin ?? "");
  });

/** Stream stdout lines of a long-running command; `onEnd` gets the exit code and the tail of stderr. */
export const streamSkm = (cmd: readonly string[] | undefined, args: readonly string[], onLine: (l: string) => void, onEnd: (code: number | null, stderr: string) => void): void => {
  if (cmd === undefined || cmd[0] === undefined) return onEnd(null, "skm CLI not found");
  const p = spawn(cmd[0], [...cmd.slice(1), ...args], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  let err = "";
  p.stdout.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    lines.filter((l) => l.length > 0).forEach(onLine);
  });
  p.stderr.on("data", (d: Buffer) => { err = (err + d.toString("utf8")).slice(-4000); });
  p.on("error", (e) => onEnd(null, e.message));
  p.on("close", (code) => {
    if (buf.length > 0) onLine(buf);
    onEnd(code, err);
  });
};
