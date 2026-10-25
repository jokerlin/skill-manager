import type { Config, HostConfig } from "../core/config";
import type { EvalCacheEntry } from "../shell/cache";
import type { Inventory } from "../core/inventory";
import type { Op } from "../core/plan";
import type { Skill } from "../core/skill";
import type { Result } from "../lib/result";
import { type AppState } from "../shell/app";
import { readEvalCache, writeEvalCache } from "../shell/cache";
import { evaluators } from "../shell/evaluators";
import { agentDirsRel, agentsOn, backupPathsFor, planFor, runnerFor } from "../shell/hosts";
import { nowStamp } from "../shell/paths";
import { type HostError, probeHost } from "../shell/probe";
import { backupHost } from "../shell/backup";
import { type SyncReport, executePlan } from "../shell/sync";
import { buildEvalPrompt, parseEvalResponse, evalErrorText } from "../core/evalPrompt";
import { serializeConfig } from "../core/config";
import { writeFile } from "node:fs/promises";

/** Every side effect the TUI needs, behind one interface so tests can stub it. */
export type TuiIo = {
  readonly probe: (host: HostConfig) => Promise<Result<Inventory, HostError>>;
  readonly plan: (config: Config, skills: readonly Skill[], host: HostConfig, inv: Inventory) => Op[];
  readonly saveConfig: (config: Config) => Promise<void>;
  readonly backup: (host: HostConfig, ts: string) => Promise<Result<string, HostError>>;
  readonly apply: (host: HostConfig, ops: readonly Op[], replaceConflicts: boolean, ts: string, log: (l: string) => void) => Promise<SyncReport>;
  readonly evaluate: (skills: readonly Skill[], allSkills: readonly Skill[]) => Promise<Result<Record<string, EvalCacheEntry>, string>>;
  readonly now: () => string;
};

export const realIo = (app: AppState): TuiIo => ({
  probe: (host) => probeHost(host, agentsOn(app.config, host), app.config.owned, runnerFor(host)),
  plan: (config, skills, host, inv) => planFor(config, skills, host, inv, app.hubMarketplaces),
  saveConfig: (config) => writeFile(app.configPath, serializeConfig(config), "utf8"),
  backup: async (host, ts) => {
    const r = await backupHost(host, runnerFor(host), backupPathsFor(host, agentsOn(app.config, host)), app.skmHome, ts);
    return r.ok ? { ok: true, value: r.value.dir } : r;
  },
  apply: (host, ops, replaceConflicts, ts, log) =>
    executePlan({
      host,
      ops,
      runner: runnerFor(host),
      hubStore: app.storeDir,
      agentDirs: agentDirsRel(agentsOn(app.config, host)),
      replaceConflictsInto: replaceConflicts ? `${host.skm}/backups/${ts}/conflicts` : undefined,
      log,
    }),
  evaluate: async (skills, allSkills) => {
    const id = app.config.eval.agent;
    const model = app.config.eval.model.some ? app.config.eval.model.value : undefined;
    const roster = allSkills.map((s) => `${s.name}: ${(s.parsed.ok && s.parsed.value.frontmatter.description.some ? s.parsed.value.frontmatter.description.value : "").slice(0, 120)}`).join("\n");
    const r = await evaluators[id](`${buildEvalPrompt(skills)}\n\n=== ALL SKILL NAMES IN THE LIBRARY ===\n${roster}\n`, model);
    if (!r.ok) return { ok: false, error: evalErrorText(r.error) };
    const items = parseEvalResponse(r.value);
    if (!items.ok) return { ok: false, error: evalErrorText(items.error) };
    const cache = await readEvalCache(app.skmHome);
    items.value.forEach((item) => {
      const s = skills.find((x) => x.name === item.name);
      if (s) cache[s.name] = { hash: s.contentHash, evaluator: id, at: new Date().toISOString(), item };
    });
    await writeEvalCache(app.skmHome, cache);
    return { ok: true, value: cache };
  },
  now: nowStamp,
});
