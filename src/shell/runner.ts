import { type Result, err, ok } from "../lib/result";

export type RunOut = { readonly stdout: string; readonly stderr: string };
export type RunError =
  | { readonly kind: "spawn"; readonly message: string }
  | { readonly kind: "exit"; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "timeout"; readonly ms: number };

export type Runner = {
  readonly id: string;
  readonly kind: "local" | "ssh";
  /** Pipe a script into `sh -s` on the host. */
  readonly sh: (script: string, opts?: { readonly timeoutMs?: number }) => Promise<Result<RunOut, RunError>>;
  /** rsync-style path for a home-relative path on this host: local ⇒ absolute, ssh ⇒ alias:rel */
  readonly rsyncPath: (homeRel: string) => string;
};

export const runError = (e: RunError): string => {
  switch (e.kind) {
    case "spawn":
      return `could not start process: ${e.message}`;
    case "exit":
      return `exit ${e.code}: ${(e.stderr || e.stdout).trim().split("\n").slice(-3).join(" | ")}`;
    case "timeout":
      return `timed out after ${e.ms}ms`;
  }
};

/** Spawn argv with optional stdin; captures stdout/stderr; non-zero exit is an Err. */
export const exec = async (
  argv: readonly string[],
  opts: { readonly stdin?: string; readonly timeoutMs?: number; readonly env?: Record<string, string> } = {},
): Promise<Result<RunOut, RunError>> => {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...argv], {
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...(opts.env ?? {}) },
    });
  } catch (e) {
    return err({ kind: "spawn", message: e instanceof Error ? e.message : String(e) });
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (proc.signalCode === "SIGTERM" || proc.signalCode === "SIGKILL") return err({ kind: "timeout", ms: timeoutMs });
  return code === 0 ? ok({ stdout, stderr }) : err({ kind: "exit", code, stdout, stderr });
};

/** The hub machine itself. `home` override exists for tests. */
export const localRunner = (home: string = process.env["HOME"] ?? "", id = "local"): Runner => ({
  id,
  kind: "local",
  sh: (script, opts) => exec(["sh", "-s"], { stdin: script, env: { HOME: home }, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) }),
  rsyncPath: (rel) => `${home}/${rel}`,
});

export const SSH_BASE = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new"] as const;

export const sshRunner = (id: string, alias: string): Runner => ({
  id,
  kind: "ssh",
  sh: (script, opts) => exec([...SSH_BASE, alias, "sh", "-s"], { stdin: script, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) }),
  rsyncPath: (rel) => `${alias}:${rel}`,
});

/** rsync one directory (trailing slashes added) as an exact mirror. Runs on the hub. */
export const rsyncMirror = (src: string, dest: string, timeoutMs = 300_000): Promise<Result<RunOut, RunError>> =>
  exec(["rsync", "-a", "--delete", "--exclude", ".DS_Store", "-e", SSH_BASE.join(" "), `${src.replace(/\/$/, "")}/`, `${dest.replace(/\/$/, "")}/`], { timeoutMs });
