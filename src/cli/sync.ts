import pc from "picocolors";
import { isMutation, opText } from "../core/plan";
import { hostErrorText } from "../shell/probe";
import { applyJobs, humanSink, jsonSink, opJson } from "./apply";
import { confirm, out, withApp } from "./common";
import { snapshotHosts } from "./status";

export type SyncOpts = { host?: string; dryRun: boolean; replaceConflicts: boolean; yes: boolean; backup: boolean; events?: boolean };

export const runPlan = async (o: { host?: string; json?: boolean; cached?: boolean }): Promise<void> =>
  withApp(async (app) => {
    const snaps = await snapshotHosts(app, o.host, { cached: o.cached === true });
    if (o.json) return out(JSON.stringify(snaps.map((s) => (s.result.ok ? { host: s.host.id, reachable: true, probedAt: s.probedAt || null, ops: s.result.ops.map(opJson) } : { host: s.host.id, reachable: false, error: hostErrorText(s.result.error), ops: [] })), null, 2));
    snaps.forEach((s) => {
      if (!s.result.ok) return out(`${pc.bold(s.host.id)}: ${pc.red(hostErrorText(s.result.error))}`);
      out(pc.bold(`${s.host.id}: ${s.result.ops.filter(isMutation).length} mutations`));
      s.result.ops.forEach((op) => out(`  ${op.op === "conflict" ? pc.red(opText(op)) : op.op === "remote-only" ? pc.magenta(opText(op)) : op.op === "blocked" ? pc.yellow(opText(op)) : opText(op)}`));
    });
  });

export const runSync = async (o: SyncOpts): Promise<void> =>
  withApp(async (app) => {
    // --events (desktop app) prints only JSON lines; the human summary below is skipped
    const sink = o.events ? jsonSink : humanSink;
    const say = o.events ? () => undefined : out;
    const snaps = await snapshotHosts(app, o.host);
    const todo = snaps.filter((s) => s.result.ok && s.result.ops.some((op) => isMutation(op) || (o.replaceConflicts && op.op === "conflict")));
    snaps.forEach((s) => {
      if (!s.result.ok) {
        if (o.events) sink({ type: "host-done", host: s.host.id, ok: false, rsynced: 0, applied: 0, commandsOk: 0, commandsFailed: 0, failures: [], error: `${hostErrorText(s.result.error)} — skipped` });
        return say(`${pc.bold(s.host.id)}: ${pc.red(hostErrorText(s.result.error))} — skipped`);
      }
      const muts = s.result.ops.filter(isMutation);
      const conflicts = s.result.ops.filter((op) => op.op === "conflict");
      say(pc.bold(`${s.host.id}: ${muts.length} mutations${conflicts.length > 0 ? `, ${conflicts.length} conflicts${o.replaceConflicts ? " (will replace)" : " (left alone)"}` : ""}`));
      s.result.ops.filter((op) => op.op !== "remote-only").forEach((op) => say(`  ${op.op === "conflict" ? pc.red(opText(op)) : op.op === "blocked" ? pc.yellow(opText(op)) : opText(op)}`));
    });
    if (todo.length === 0) {
      if (o.events) sink({ type: "verified", pending: [] });
      return say(pc.green("\nnothing to do"));
    }
    if (o.dryRun) return say(pc.dim("\n(dry run — nothing changed)"));
    // --events cannot prompt: without -y it only reports
    if (!o.yes && (o.events || !confirm(`\napply to ${todo.map((s) => s.host.id).join(", ")}?`))) return say("aborted");

    await applyJobs(app, todo.flatMap((s) => (s.result.ok ? [{ host: s.host, ops: s.result.ops }] : [])), { backup: o.backup, replaceConflicts: o.replaceConflicts }, sink);
    const after = await snapshotHosts(app, o.host);
    sink({ type: "verified", pending: after.filter((s) => s.result.ok && s.result.ops.some(isMutation)).map((s) => s.host.id) });
  });
