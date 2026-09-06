import type { HostConfig } from "../core/config";
import { type Op, isCommandOp, opText } from "../core/plan";
import { type CommandResult, applyScript, commandsScript, parseCommandOutput, shPath } from "../core/scripts";
import { shQuote } from "../lib/sh";
import type { HostError } from "./probe";
import { type Runner, rsyncMirror, runError } from "./runner";

export type SyncReport = {
  readonly host: string;
  readonly rsynced: readonly string[];
  readonly applied: readonly string[];   // lines echoed by apply.sh
  readonly skipped: readonly string[];   // stderr lines from apply.sh
  readonly conflicts: readonly string[];
  readonly commands: readonly CommandResult[]; // plugin / owned-skill commands run through their own CLIs
  readonly error: HostError | undefined; // first fatal error; later steps were not run
};

export type ExecuteArgs = {
  readonly host: HostConfig;
  readonly ops: readonly Op[];
  readonly runner: Runner;
  readonly hubStore: string;                               // absolute hub store dir
  readonly agentDirs: Readonly<Record<string, string>>;    // agent → ~/... on the host
  readonly replaceConflictsInto: string | undefined;       // ~/.skm/backups/<ts>/conflicts
  readonly log: (line: string) => void;
};

const rel = (p: string): string => (p.startsWith("~/") ? p.slice(2) : p);

/** rsync (hub → host) for every rsync-skill op, then one apply.sh for the rest. Stops at the first failure. */
export const executePlan = async (a: ExecuteArgs): Promise<SyncReport> => {
  const { host, ops, runner, log } = a;
  const toSync = ops.flatMap((o) => (o.op === "rsync-skill" ? [o.skill] : []));
  const conflicts = ops.flatMap((o) => (o.op === "conflict" ? [opText(o)] : []));
  const base: SyncReport = { host: host.id, rsynced: [], applied: [], skipped: [], conflicts, commands: [], error: undefined };

  if (toSync.length > 0) {
    const storeRel = `${rel(host.skm)}/skills`;
    const mk = await runner.sh(`mkdir -p ${toSync.map((s) => `${shPath(`${host.skm}/skills`)}/${shQuote(s)}`).join(" ")}\n`);
    if (!mk.ok) return { ...base, error: { kind: "step-failed", host: host.id, step: "mkdir store", detail: runError(mk.error) } };
    const synced = await toSync.reduce<Promise<{ done: string[]; failed: HostError | undefined }>>(async (accP, skill) => {
      const acc = await accP;
      if (acc.failed) return acc;
      log(`rsync ${skill} → ${host.id}`);
      const r = await rsyncMirror(`${a.hubStore}/${skill}`, runner.rsyncPath(`${storeRel}/${skill}`));
      return r.ok
        ? { done: [...acc.done, skill], failed: undefined }
        : { done: acc.done, failed: { kind: "step-failed", host: host.id, step: `rsync ${skill}`, detail: runError(r.error) } };
    }, Promise.resolve({ done: [], failed: undefined }));
    if (synced.failed) return { ...base, rsynced: synced.done, error: synced.failed };
    return applyOps({ ...base, rsynced: synced.done });
  }
  return applyOps(base);

  async function applyOps(base: SyncReport): Promise<SyncReport> {

    const script = applyScript({ skm: host.skm, ops, agentDirs: a.agentDirs, replaceConflictsInto: a.replaceConflictsInto });
    const r = await runner.sh(script, { timeoutMs: 120_000 });
    if (!r.ok) return { ...base, error: { kind: "step-failed", host: host.id, step: "apply", detail: runError(r.error) } };
    const applied = r.value.stdout.split("\n").filter((l) => l.length > 0);
    const skipped = r.value.stderr.split("\n").filter((l) => l.length > 0);
    applied.forEach((l) => log(`${host.id}: ${l}`));
    return runCommands({ ...base, applied, skipped });
  }

  /** Plugin / owned-skill ops go through `claude plugin`, `codex plugin`, config.toml edits or the owning tool. */
  async function runCommands(base: SyncReport): Promise<SyncReport> {
    const cmds = ops.filter(isCommandOp);
    if (cmds.length === 0) return base;
    cmds.forEach((o) => log(`${host.id}: ${opText(o)}`));
    const r = await runner.sh(commandsScript(cmds), { timeoutMs: 600_000 });
    if (!r.ok) return { ...base, error: { kind: "step-failed", host: host.id, step: "commands", detail: runError(r.error) } };
    const commands = parseCommandOutput(r.value.stdout);
    commands.forEach((c) => log(`${host.id}: ${c.ok ? "ok" : "FAILED"} ${c.label}${c.ok ? "" : ` — ${c.detail}`}`));
    return { ...base, commands };
  }
};
