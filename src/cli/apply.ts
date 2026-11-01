import pc from "picocolors";
import type { HostConfig } from "../core/config";
import { type Op, isMutation, opText } from "../core/plan";
import type { AppState } from "../shell/app";
import { backupHost } from "../shell/backup";
import { agentDirsRel, agentsOn, backupPathsFor, runnerFor } from "../shell/hosts";
import { nowStamp } from "../shell/paths";
import { hostErrorText } from "../shell/probe";
import { executePlan } from "../shell/sync";
import { out } from "./common";

/**
 * What a long-running command reports. `--events` prints each as one JSON line (for the desktop app);
 * otherwise `humanSink` renders them as the familiar coloured text.
 */
export type ApplyEvent =
  | { readonly type: "host-start"; readonly host: string; readonly ops: number }
  | { readonly type: "backup"; readonly host: string; readonly ts: string; readonly dir: string; readonly hubCopy: string | null }
  | { readonly type: "log"; readonly host: string; readonly line: string }
  | { readonly type: "warn"; readonly host: string; readonly line: string }
  | { readonly type: "host-done"; readonly host: string; readonly ok: boolean; readonly rsynced: number; readonly applied: number; readonly commandsOk: number; readonly commandsFailed: number; readonly failures: readonly string[]; readonly error: string | null }
  | { readonly type: "verified"; readonly pending: readonly string[] };

export type Sink = (e: ApplyEvent) => void;

export const jsonSink: Sink = (e) => out(JSON.stringify(e));

export const humanSink: Sink = (e) => {
  switch (e.type) {
    case "host-start":
      return;
    case "backup":
      return out(`${e.host}: backup ${e.dir}${e.hubCopy ? pc.dim(`  (copy: ${e.hubCopy})`) : ""}  restore: ${pc.cyan(`skm restore ${e.host} ${e.ts}`)}`);
    case "log":
      return out(pc.dim(`  ${e.line}`));
    case "warn":
      return out(pc.yellow(`  ${e.host}: ${e.line}`));
    case "host-done": {
      if (e.error !== null) return out(`${pc.bold(e.host)}: ${pc.red(e.error)}`);
      const cmds = e.commandsOk + e.commandsFailed;
      return out(`${pc.bold(e.host)}: ${e.commandsFailed > 0 ? pc.yellow("done with failures") : pc.green("done")}  rsynced ${e.rsynced}, applied ${e.applied}${cmds > 0 ? `, commands ${e.commandsOk} ok${e.commandsFailed > 0 ? pc.red(` / ${e.commandsFailed} failed`) : ""}` : ""}`);
    }
    case "verified":
      return out(e.pending.length === 0 ? pc.green("\nverified: all reachable hosts are in sync") : pc.yellow(`\nstill pending on: ${e.pending.join(", ")} (run \`skm plan\`)`));
  }
};

export type ApplyJob = { readonly host: HostConfig; readonly ops: readonly Op[] };

/** Back up (when configured) and execute each host's ops in parallel. One host failing never stops the others. */
export const applyJobs = async (
  app: AppState, jobs: readonly ApplyJob[], o: { readonly backup: boolean; readonly replaceConflicts: boolean }, sink: Sink,
): Promise<void> => {
  const ts = nowStamp();
  await Promise.all(
    jobs.map(async ({ host, ops }) => {
      sink({ type: "host-start", host: host.id, ops: ops.filter(isMutation).length });
      const runner = runnerFor(host);
      const agents = agentsOn(app.config, host);
      const fail = (error: string) => sink({ type: "host-done", host: host.id, ok: false, rsynced: 0, applied: 0, commandsOk: 0, commandsFailed: 0, failures: [], error });
      if (o.backup && app.config.backupBeforeApply) {
        const b = await backupHost(host, runner, backupPathsFor(host, agents), app.skmHome, ts);
        if (!b.ok) return fail(`${hostErrorText(b.error)} — not applied`);
        sink({ type: "backup", host: host.id, ts, dir: b.value.dir, hubCopy: b.value.hubCopy ?? null });
      }
      const report = await executePlan({
        host,
        ops,
        runner,
        hubStore: app.storeDir,
        agentDirs: agentDirsRel(agents),
        replaceConflictsInto: o.replaceConflicts ? `${host.skm}/backups/${ts}/conflicts` : undefined,
        log: (line) => sink({ type: "log", host: host.id, line }),
      });
      report.skipped.forEach((line) => sink({ type: "warn", host: host.id, line }));
      if (report.error) return fail(hostErrorText(report.error));
      const failed = report.commands.filter((c) => !c.ok);
      sink({
        type: "host-done", host: host.id, ok: failed.length === 0,
        rsynced: report.rsynced.length, applied: report.applied.length,
        commandsOk: report.commands.length - failed.length, commandsFailed: failed.length,
        failures: failed.map((c) => `${c.label} — ${c.detail}`), error: null,
      });
    }),
  );
};

/** Plan lines as JSON for `plan --json` / the desktop review drawer. */
export const opJson = (op: Op) => ({
  op: op.op,
  text: opText(op),
  agent: "agent" in op ? op.agent : null,
  skill: "skill" in op ? op.skill : null,
  plugin: "plugin" in op ? op.plugin : "marketplace" in op ? op.marketplace : null,
  mutation: isMutation(op),
});
