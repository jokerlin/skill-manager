import type { Config, HostConfig } from "../core/config";
import type { Inventory } from "../core/inventory";
import type { Op } from "../core/plan";
import type { Skill } from "../core/skill";
import type { Result } from "../lib/result";
import { type AppState } from "../shell/app";
import { agentDirsRel, agentsOn, backupPathsFor, planFor, runnerFor } from "../shell/hosts";
import { nowStamp } from "../shell/paths";
import { type HostError, probeHost } from "../shell/probe";
import { backupHost } from "../shell/backup";
import { type SyncReport, executePlan } from "../shell/sync";
import { serializeConfig } from "../core/config";
import { writeFile } from "node:fs/promises";
import { none } from "../lib/result";
import { loadStore } from "../shell/store";
import { type HarnessHost, readHarnessCache, runHarnessHost, toolsOf, writeHarnessCache } from "../shell/harness";
import { type UpdateEvent, type UpdateRun, type UpstreamResult, checkUpstreams, planUpdate, runUpdate } from "../shell/upstreamOps";

/** Every side effect the TUI needs, behind one interface so tests can stub it. */
export type TuiIo = {
  readonly probe: (host: HostConfig) => Promise<Result<Inventory, HostError>>;
  readonly plan: (config: Config, skills: readonly Skill[], host: HostConfig, inv: Inventory) => Op[];
  readonly saveConfig: (config: Config) => Promise<void>;
  readonly backup: (host: HostConfig, ts: string) => Promise<Result<string, HostError>>;
  readonly apply: (host: HostConfig, ops: readonly Op[], replaceConflicts: boolean, ts: string, log: (l: string) => void) => Promise<SyncReport>;
  readonly now: () => string;
  /** Every configured upstream against the lock; `offline` reads the local mirrors without fetching. */
  readonly upstreams: (offline: boolean) => Promise<Result<readonly UpstreamResult[], string>>;
  /** Write skills from their upstream mirror (no fetch, so what lands is what the TUI showed), backup first. */
  readonly upstreamUpdate: (skills: readonly string[], force: boolean, onEvent: (e: UpdateEvent) => void) => Promise<Result<UpdateRun, string>>;
  /** Agent CLI and app versions per host: the cached result of the last run, or a live check over ssh (then cached). */
  readonly harness: (cached: boolean) => Promise<readonly HarnessHost[]>;
  /** Run every agent CLI's own self-update on one host (CLIs only, as `skm harness update`); returns the cached result after it. */
  readonly harnessUpdate: (host: HostConfig, onLine: (line: string) => void) => Promise<HarnessHost>;
  /** Re-read the store, after something wrote into it. */
  readonly loadSkills: () => Promise<Result<readonly Skill[], string>>;
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
  now: nowStamp,
  upstreams: (offline) => checkUpstreams(app, { offline, ref: none }),
  upstreamUpdate: async (skills, force, onEvent) => {
    const plan = await planUpdate(app, { kind: "named", names: skills }, { offline: true, ref: none, force });
    return plan.ok ? runUpdate(app, plan.value, { backup: true, onEvent }) : plan;
  },
  harness: (cached) =>
    Promise.all(app.config.hosts.map(async (h): Promise<HarnessHost> => {
      if (cached) return (await readHarnessCache(app.skmHome, h.id)) ?? { host: h.id, at: "", error: null, results: [] };
      return writeHarnessCache(app.skmHome, await runHarnessHost(h, toolsOf(app, h, undefined, "check"), "check", () => undefined));
    })),
  harnessUpdate: async (host, onLine) => writeHarnessCache(app.skmHome, await runHarnessHost(host, toolsOf(app, host, undefined, "update"), "update", onLine)),
  loadSkills: async () => {
    const r = await loadStore(app.storeDir);
    return r.ok ? { ok: true, value: r.value.skills } : { ok: false, error: `cannot read store ${r.error.dir}: ${r.error.message}` };
  },
});
