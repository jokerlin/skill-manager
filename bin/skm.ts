#!/usr/bin/env bun
import { Command } from "commander";
import { runInit } from "../src/cli/init";
import { runAdopt } from "../src/cli/adopt";
import { runLs } from "../src/cli/ls";
import { runShow } from "../src/cli/show";
import { runStatus } from "../src/cli/status";
import { runPlan, runSync } from "../src/cli/sync";
import { runBackup, runBackups, runRestore } from "../src/cli/backup";
import { runPull } from "../src/cli/pull";
import { runDoctor } from "../src/cli/doctor";
import { runEval } from "../src/cli/eval";
import { runRulesInfer } from "../src/cli/rules";
import { runConfigShow, runScope } from "../src/cli/scope";

const program = new Command();
program
  .name("skm")
  .description("skill manager: one store, symlinks into every agent, rsync across machines")
  .version("0.1.0")
  .action(async () => {
    const { runTui } = await import("../src/tui/main");
    await runTui();
  });

program.command("init").description("create ~/.skm/config.yaml and the store; list unmanaged skills").action(runInit);
program
  .command("adopt [paths...]")
  .description("move real skill dirs into the store and leave symlinks behind")
  .option("--from <agent...>", "adopt everything in an agent's user dir")
  .action((paths: string[], o: { from?: string[] }) => runAdopt(paths, o.from ?? []));
program
  .command("ls")
  .alias("list")
  .description("list store skills with context cost")
  .option("--json", "machine-readable", false)
  .option("--host <id>", "only skills wanted on this host")
  .option("--agent <id>", "only skills wanted by this agent")
  .option("--sort <key>", "name | cost", "name")
  .action((o: { json: boolean; host?: string; agent?: string; sort: string }) =>
    runLs({ json: o.json, sort: o.sort === "cost" ? "cost" : "name", ...(o.host !== undefined ? { host: o.host } : {}), ...(o.agent !== undefined ? { agent: o.agent } : {}) }),
  );
program.command("show <skill>").description("details, cost, targets matrix, insights").action(runShow);
program
  .command("status")
  .description("probe hosts: what each agent actually consumes, drift, conflicts, remote-only")
  .option("--host <id>")
  .option("--json", "machine-readable", false)
  .action((o: { host?: string; json: boolean }) => runStatus({ json: o.json, ...(o.host !== undefined ? { host: o.host } : {}) }));
program.command("plan").description("show the operations sync would perform").option("--host <id>").option("--json", "machine-readable", false).action((o: { host?: string; json: boolean }) => runPlan({ json: o.json, ...(o.host !== undefined ? { host: o.host } : {}) }));
program
  .command("sync")
  .description("backup → rsync store → apply symlinks on every host")
  .option("--host <id>")
  .option("--dry-run", "plan only", false)
  .option("--replace-conflicts", "move real dirs / foreign links aside (into the backup) and link", false)
  .option("-y, --yes", "no confirmation", false)
  .option("--no-backup", "skip the automatic backup")
  .action((o: { host?: string; dryRun: boolean; replaceConflicts: boolean; yes: boolean; backup: boolean }) =>
    runSync({ dryRun: o.dryRun, replaceConflicts: o.replaceConflicts, yes: o.yes, backup: o.backup, ...(o.host !== undefined ? { host: o.host } : {}) }),
  );
program.command("pull <host> [skills...]").description("copy remote-only skills from a host's store into the hub").option("--all", "every remote-only skill", false).option("--force", "overwrite hub copy", false).action((host: string, skills: string[], o: { all: boolean; force: boolean }) => runPull(host, skills, o.all, o.force));
program.command("backup [hosts...]").description("snapshot store + agent dirs on hosts; writes restore.sh").action(runBackup);
program.command("backups [host]").description("list backups").action(runBackups);
program.command("restore <host> <ts>").description("one-shot restore of a backup on a host").option("-y, --yes", "no confirmation", false).action((host: string, ts: string, o: { yes: boolean }) => runRestore(host, ts, o.yes));
program.command("doctor").description("spec violations, lint, and startup-context budget per host × agent").option("--json", "machine-readable", false).action((o: { json: boolean }) => runDoctor({ json: o.json }));
program.command("scope <skill> <cell> <state>").description("toggle one host/agent cell for a skill: skm scope kb-doc mini/claude off").action(runScope);
program.command("config").description("print config.yaml").option("--json", "hosts/agents/store summary", false).action((o: { json: boolean }) => runConfigShow(o.json));
const rules = program.command("rules").description("scope rules helpers");
rules
  .command("infer")
  .description("derive host-level rules from what each reachable host holds today (dry run unless --write)")
  .option("--write", "replace rules in config.yaml", false)
  .action((o: { write: boolean }) => runRulesInfer(o.write));
program
  .command("eval [skills...]")
  .description("ask claude -p / codex exec to rate usefulness, description quality, overlap")
  .option("--agent <id>", "claude | codex")
  .option("--model <name>")
  .option("--fresh", "ignore cache", false)
  .option("--json", "machine-readable", false)
  .option("--batch <n>", "skills per request", "12")
  .option("--cached", "only print cached results, never call an LLM", false)
  .action((skills: string[], o: { agent?: string; model?: string; fresh: boolean; json: boolean; batch: string; cached: boolean }) =>
    runEval(skills, {
      fresh: o.fresh, json: o.json, batch: Math.max(1, Number(o.batch) || 12), cached: o.cached,
      ...(o.agent === "claude" || o.agent === "codex" ? { agent: o.agent } : {}),
      ...(o.model !== undefined ? { model: o.model } : {}),
    }),
  );

await program.parseAsync(process.argv);
