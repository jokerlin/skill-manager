#!/usr/bin/env bun
import { Command } from "commander";
import { runInit } from "../src/cli/init";
import { runAdopt } from "../src/cli/adopt";
import { runLs } from "../src/cli/ls";
import { runShow } from "../src/cli/show";
import { runStatus } from "../src/cli/status";
import { runInventory } from "../src/cli/inventory";
import { runPlan, runSync } from "../src/cli/sync";
import { runBackup, runBackups, runRestore } from "../src/cli/backup";
import { runPull } from "../src/cli/pull";
import { runDoctor } from "../src/cli/doctor";
import { runEval } from "../src/cli/eval";
import { runRulesInfer } from "../src/cli/rules";
import { runConfigPatch, runConfigShow, runScope, runExtensions } from "../src/cli/scope";
import { runPluginUpdate, runPlugins } from "../src/cli/plugins";
import { runHarness, runHarnessUpdate } from "../src/cli/harness";
import pkg from "../package.json";

const program = new Command();
program
  .name("skm")
  .description("skill manager for Claude Code, Codex, and Pi: one store, symlinks, rsync across machines")
  .version(pkg.version)
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
  .option("--cached", "use the last probe from ~/.skm/cache/inventory instead of ssh", false)
  .action((o: { host?: string; json: boolean; cached: boolean }) => runStatus({ json: o.json, cached: o.cached, ...(o.host !== undefined ? { host: o.host } : {}) }));
program
  .command("inventory")
  .alias("inv")
  .description("per host × agent: every skill the agent loads (user dir, legacy dir, builtins, plugins) with source, storage, owner, version, context cost")
  .option("--host <id>")
  .option("--agent <id>")
  .option("--json", "machine-readable", false)
  .action((o: { host?: string; agent?: string; json: boolean }) => runInventory({ json: o.json, ...(o.host !== undefined ? { host: o.host } : {}), ...(o.agent !== undefined ? { agent: o.agent } : {}) }));
program
  .command("plan")
  .description("show the operations sync would perform")
  .option("--host <id>")
  .option("--json", "machine-readable", false)
  .option("--cached", "plan against the last probe (no ssh)", false)
  .action((o: { host?: string; json: boolean; cached: boolean }) => runPlan({ json: o.json, cached: o.cached, ...(o.host !== undefined ? { host: o.host } : {}) }));
program
  .command("sync")
  .description("backup → rsync store → apply symlinks on every host")
  .option("--host <id>")
  .option("--dry-run", "plan only", false)
  .option("--replace-conflicts", "move real dirs / foreign links aside (into the backup) and link", false)
  .option("-y, --yes", "no confirmation", false)
  .option("--no-backup", "skip the automatic backup")
  .option("--events", "print progress as JSON lines (for the desktop app; needs -y)", false)
  .action((o: { host?: string; dryRun: boolean; replaceConflicts: boolean; yes: boolean; backup: boolean; events: boolean }) =>
    runSync({ dryRun: o.dryRun, replaceConflicts: o.replaceConflicts, yes: o.yes, backup: o.backup, events: o.events, ...(o.host !== undefined ? { host: o.host } : {}) }),
  );
program
  .command("plugins")
  .description("every configured plugin across hosts × agents: versions, drift, config policy")
  .option("--json", "machine-readable", false)
  .option("--cached", "use the last probe (no ssh)", false)
  .option("--host <id>")
  .action((o: { json: boolean; cached: boolean; host?: string }) => runPlugins({ json: o.json, cached: o.cached, ...(o.host !== undefined ? { host: o.host } : {}) }));
const plugin = program.command("plugin").description("plugin helpers");
plugin
  .command("update [plugins...]")
  .description("refresh marketplaces and update plugins (name or name@marketplace; none = every enabled plugin) on every host")
  .option("--host <id>")
  .option("--agent <id>", "claude | codex")
  .option("--dry-run", "list the commands only", false)
  .option("-y, --yes", "no confirmation", false)
  .option("--no-backup", "skip the automatic backup")
  .option("--events", "print progress as JSON lines (needs -y)", false)
  .action((names: string[], o: { host?: string; agent?: string; dryRun: boolean; yes: boolean; backup: boolean; events: boolean }) =>
    runPluginUpdate(names, { yes: o.yes, events: o.events, backup: o.backup, dryRun: o.dryRun, ...(o.host !== undefined ? { host: o.host } : {}), ...(o.agent !== undefined ? { agent: o.agent } : {}) }),
  );
const harness = program
  .command("harness")
  .description("agent CLI, desktop app and extension tool versions on every host")
  .option("--json", "machine-readable", false)
  .option("--cached", "show the last result instead of checking over ssh", false)
  .option("--host <id>")
  .option("--agent <id>")
  .action((o: { json: boolean; cached: boolean; host?: string; agent?: string }) =>
    runHarness({ json: o.json, cached: o.cached, ...(o.host !== undefined ? { host: o.host } : {}), ...(o.agent !== undefined ? { agent: o.agent } : {}) }));
harness
  .command("update")
  .description("run each agent CLI's own self-update (claude update, codex update, pi update --all; override with agentOverrides.<id>.update) on every host")
  // --host/--agent are declared on `harness` too; Commander hands them to the parent, so read them with optsWithGlobals()
  .option("--host <id>")
  .option("--agent <id>")
  .option("--dry-run", "list the commands only", false)
  .option("-y, --yes", "no confirmation", false)
  .option("--events", "print progress as JSON lines (needs -y)", false)
  .action((_o: unknown, cmd: Command) => {
    const o = cmd.optsWithGlobals<{ host?: string; agent?: string; dryRun: boolean; yes: boolean; events: boolean }>();
    return runHarnessUpdate({ yes: o.yes, events: o.events, dryRun: o.dryRun, ...(o.host !== undefined ? { host: o.host } : {}), ...(o.agent !== undefined ? { agent: o.agent } : {}) });
  });
program.command("extensions").description("extensions in ~/.skm/extensions: extra agents, desktop apps and harness tools").option("--json", "machine-readable", false).action((o: { json: boolean }) => runExtensions(o.json));
program.command("pull <host> [skills...]").description("copy remote-only skills from a host's store into the hub").option("--all", "every remote-only skill", false).option("--force", "overwrite hub copy", false).action((host: string, skills: string[], o: { all: boolean; force: boolean }) => runPull(host, skills, o.all, o.force));
program.command("backup [hosts...]").description("snapshot store + agent dirs on hosts; writes restore.sh").action(runBackup);
program.command("backups [host]").description("list backups").action(runBackups);
program.command("restore <host> <ts>").description("one-shot restore of a backup on a host").option("-y, --yes", "no confirmation", false).action((host: string, ts: string, o: { yes: boolean }) => runRestore(host, ts, o.yes));
program
  .command("doctor")
  .description("startup-context budget per host × agent over everything each agent loads, cross-source findings, store lint")
  .option("--json", "machine-readable", false)
  .option("--cached", "use the last probe from ~/.skm/cache/inventory instead of ssh", false)
  .option("--host <id>")
  .action((o: { json: boolean; cached: boolean; host?: string }) => runDoctor({ json: o.json, cached: o.cached, ...(o.host !== undefined ? { host: o.host } : {}) }));
program
  .command("scope <name> <cell> <state>")
  .description("toggle one host/agent cell for a skill (or --plugin): skm scope kb-doc mini/claude off")
  .option("--plugin", "name is a plugin (name, or name@marketplace when config.yaml does not list it yet)", false)
  .action((name: string, cell: string, state: string, o: { plugin: boolean }) => runScope(name, cell, state, { plugin: o.plugin }));
const config = program.command("config").description("print config.yaml").option("--json", "hosts/agents/store summary", false).action((o: { json: boolean }) => runConfigShow(o.json));
config.command("patch").description("apply a JSON patch from stdin: { hosts, agents, backupBeforeApply, contextTokens }").action(runConfigPatch);
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
  .option("--all", "also evaluate skills the local agents load from plugins / real dirs (named plugin:skill)", false)
  .action((skills: string[], o: { agent?: string; model?: string; fresh: boolean; json: boolean; batch: string; cached: boolean; all: boolean }) =>
    runEval(skills, {
      fresh: o.fresh, json: o.json, batch: Math.max(1, Number(o.batch) || 12), cached: o.cached, all: o.all,
      ...(o.agent === "claude" || o.agent === "codex" ? { agent: o.agent } : {}),
      ...(o.model !== undefined ? { model: o.model } : {}),
    }),
  );

await program.parseAsync(process.argv);
