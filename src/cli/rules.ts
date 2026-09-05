import pc from "picocolors";
import { type Config, type Rule, serializeConfig } from "../core/config";
import { none, some } from "../lib/result";
import { out, saveConfig, withApp } from "./common";
import { snapshotHosts } from "./status";

/**
 * Infer host-level rules from what each reachable host holds today, so that after `skm sync`
 * every host keeps exactly the skills it already had. Skills present on every reachable host get
 * no rule (so a host that is offline now inherits the common core when it comes back).
 */
export const inferRules = (hubSkills: readonly string[], presence: ReadonlyMap<string, ReadonlySet<string>>, reachable: readonly string[]): Rule[] => {
  const everywhere = new Set(reachable);
  const groups = hubSkills.reduce<Map<string, string[]>>((acc, name) => {
    const hosts = [...(presence.get(name) ?? new Set<string>())].filter((h) => everywhere.has(h)).sort();
    if (hosts.length === reachable.length) return acc; // common core → no rule
    const key = hosts.join(",");
    return acc.set(key, [...(acc.get(key) ?? []), name]);
  }, new Map());
  return [...groups.entries()].map(([key, names]) => ({
    skills: compressGlobs(names, hubSkills),
    hosts: some(key.length === 0 ? { kind: "only" as const, globs: ["__nowhere__"] } : { kind: "only" as const, globs: key.split(",") }),
    agents: none,
    on: [],
    off: [],
  }));
};

/** Replace `p-a, p-b, …` with `p-*` when every hub skill with prefix `p-` is in the group. */
export const compressGlobs = (names: readonly string[], all: readonly string[]): string[] => {
  const set = new Set(names);
  const prefixes = [...new Set(names.filter((n) => n.includes("-")).map((n) => n.slice(0, n.indexOf("-"))))];
  const globbed = prefixes.filter((p) => all.filter((n) => n.startsWith(`${p}-`)).every((n) => set.has(n)) && all.filter((n) => n.startsWith(`${p}-`)).length >= 3);
  const covered = new Set(names.filter((n) => globbed.some((p) => n.startsWith(`${p}-`))));
  return [...globbed.map((p) => `${p}-*`), ...names.filter((n) => !covered.has(n))].sort();
};

export const runRulesInfer = async (write: boolean): Promise<void> =>
  withApp(async (app) => {
    const snaps = await snapshotHosts(app);
    const reachable = snaps.filter((s) => s.result.ok).map((s) => s.host.id);
    const presence = new Map<string, Set<string>>();
    snaps.forEach((s) => {
      if (!s.result.ok) return;
      const inv = s.result.inventory;
      const names = [
        ...inv.storeSkills.map((x) => x.name),
        ...Object.values(inv.agentDirs).flatMap((d) => d.entries.filter((e) => e.kind !== "file").map((e) => e.name)),
      ];
      names.forEach((n) => presence.set(n, new Set([...(presence.get(n) ?? []), s.host.id])));
    });
    const rules = inferRules(app.skills.map((s) => s.name), presence, reachable);
    const next: Config = { ...app.config, rules };
    out(pc.bold(`reachable: ${reachable.join(", ")}${snaps.length > reachable.length ? pc.dim(`  (unreachable: ${snaps.filter((s) => !s.result.ok).map((s) => s.host.id).join(", ")} — they will receive the common core)`) : ""}`));
    out(pc.bold(`${rules.length} rules inferred; ${app.skills.length - rules.reduce((n, r) => n + r.skills.length, 0)} skills go everywhere`));
    out(serializeConfig({ ...next, hosts: [] }).split("\n").filter((l) => !/^(store|agents|hosts|defaults|eval|contextTokens|backupBeforeApply):/.test(l) && l.trim() !== "hosts: {}").join("\n"));
    if (!write) return out(pc.dim("\n(dry run — pass --write to replace rules in config.yaml)"));
    await saveConfig(app.configPath, next);
    out(pc.green(`\nwrote ${app.configPath}`));
  });
