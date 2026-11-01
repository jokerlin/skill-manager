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

/** Every side effect the TUI needs, behind one interface so tests can stub it. */
export type TuiIo = {
  readonly probe: (host: HostConfig) => Promise<Result<Inventory, HostError>>;
  readonly plan: (config: Config, skills: readonly Skill[], host: HostConfig, inv: Inventory) => Op[];
  readonly saveConfig: (config: Config) => Promise<void>;
  readonly backup: (host: HostConfig, ts: string) => Promise<Result<string, HostError>>;
  readonly apply: (host: HostConfig, ops: readonly Op[], replaceConflicts: boolean, ts: string, log: (l: string) => void) => Promise<SyncReport>;
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
  now: nowStamp,
});
