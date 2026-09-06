import pc from "picocolors";
import { isMutation, opText } from "../core/plan";
import { agentDirsRel, agentsOn, backupPathsFor, runnerFor } from "../shell/hosts";
import { hostErrorText } from "../shell/probe";
import { backupHost } from "../shell/backup";
import { executePlan } from "../shell/sync";
import { nowStamp } from "../shell/paths";
import { confirm, out, withApp } from "./common";
import { snapshotHosts } from "./status";

export type SyncOpts = { host?: string; dryRun: boolean; replaceConflicts: boolean; yes: boolean; backup: boolean };

export const runPlan = async (o: { host?: string; json?: boolean }): Promise<void> =>
  withApp(async (app) => {
    const snaps = await snapshotHosts(app, o.host);
    if (o.json) return out(JSON.stringify(snaps.map((s) => (s.result.ok ? { host: s.host.id, reachable: true, ops: s.result.ops.map((op) => ({ op: op.op, text: opText(op) })) } : { host: s.host.id, reachable: false, error: hostErrorText(s.result.error), ops: [] })), null, 2));
    snaps.forEach((s) => {
      if (!s.result.ok) return out(`${pc.bold(s.host.id)}: ${pc.red(hostErrorText(s.result.error))}`);
      out(pc.bold(`${s.host.id}: ${s.result.ops.filter(isMutation).length} mutations`));
      s.result.ops.forEach((op) => out(`  ${op.op === "conflict" ? pc.red(opText(op)) : op.op === "remote-only" ? pc.magenta(opText(op)) : op.op === "blocked" ? pc.yellow(opText(op)) : opText(op)}`));
    });
  });

export const runSync = async (o: SyncOpts): Promise<void> =>
  withApp(async (app) => {
    const snaps = await snapshotHosts(app, o.host);
    const todo = snaps.filter((s) => s.result.ok && s.result.ops.some((op) => isMutation(op) || (o.replaceConflicts && op.op === "conflict")));
    snaps.forEach((s) => {
      if (!s.result.ok) return out(`${pc.bold(s.host.id)}: ${pc.red(hostErrorText(s.result.error))} — skipped`);
      const muts = s.result.ops.filter(isMutation);
      const conflicts = s.result.ops.filter((op) => op.op === "conflict");
      out(pc.bold(`${s.host.id}: ${muts.length} mutations${conflicts.length > 0 ? `, ${conflicts.length} conflicts${o.replaceConflicts ? " (will replace)" : " (left alone)"}` : ""}`));
      s.result.ops.filter((op) => op.op !== "remote-only").forEach((op) => out(`  ${op.op === "conflict" ? pc.red(opText(op)) : op.op === "blocked" ? pc.yellow(opText(op)) : opText(op)}`));
    });
    if (todo.length === 0) return out(pc.green("\nnothing to do"));
    if (o.dryRun) return out(pc.dim("\n(dry run — nothing changed)"));
    if (!o.yes && !confirm(`\napply to ${todo.map((s) => s.host.id).join(", ")}?`)) return out("aborted");

    const ts = nowStamp();
    const results = await Promise.all(
      todo.map(async (s) => {
        if (!s.result.ok) return;
        const runner = runnerFor(s.host);
        const agents = agentsOn(app.config, s.host);
        if (o.backup && app.config.backupBeforeApply) {
          const b = await backupHost(s.host, runner, backupPathsFor(s.host, agents), app.skmHome, ts);
          if (!b.ok) return out(`${pc.bold(s.host.id)}: ${pc.red(hostErrorText(b.error))} — not applied`);
          out(`${s.host.id}: backup ${b.value.dir}${b.value.hubCopy ? pc.dim(`  (copy: ${b.value.hubCopy})`) : ""}  restore: ${pc.cyan(`skm restore ${s.host.id} ${ts}`)}`);
        }
        const report = await executePlan({
          host: s.host,
          ops: s.result.ops,
          runner,
          hubStore: app.storeDir,
          agentDirs: agentDirsRel(agents),
          replaceConflictsInto: o.replaceConflicts ? `${s.host.skm}/backups/${ts}/conflicts` : undefined,
          log: (l) => out(pc.dim(`  ${l}`)),
        });
        report.skipped.forEach((l) => out(pc.yellow(`  ${s.host.id}: ${l}`)));
        if (report.error) return out(`${pc.bold(s.host.id)}: ${pc.red(hostErrorText(report.error))}`);
        const failed = report.commands.filter((c) => !c.ok);
        out(`${pc.bold(s.host.id)}: ${failed.length > 0 ? pc.yellow("done with failures") : pc.green("done")}  rsynced ${report.rsynced.length}, applied ${report.applied.length}${report.commands.length > 0 ? `, commands ${report.commands.length - failed.length} ok${failed.length > 0 ? pc.red(` / ${failed.length} failed`) : ""}` : ""}`);
      }),
    );
    void results;
    const after = await snapshotHosts(app, o.host);
    const dirty = after.filter((s) => s.result.ok && s.result.ops.some(isMutation));
    out(dirty.length === 0 ? pc.green("\nverified: all reachable hosts are in sync") : pc.yellow(`\nstill pending on: ${dirty.map((s) => s.host.id).join(", ")} (run \`skm plan\`)`));
  });
