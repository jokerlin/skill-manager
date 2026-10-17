import { type Agent, agentById } from "../core/agents";
import { type Config, type HostConfig, PLUGIN_AGENTS, defaultEnsure, defaultOwnedAgents, hostAgents, marketplaceFor } from "../core/config";
import { type HostFacts, type PluginState, effectiveFor, hostFacts, pluginStates } from "../core/effective";
import { type Inventory, entryHash } from "../core/inventory";
import { type ExcludeCell, type Op, type OwnedRule, type PluginCell, planHost } from "../core/plan";
import { desiredFor, selects } from "../core/scope";
import type { Skill } from "../core/skill";
import { type Runner, localRunner, sshRunner } from "./runner";
import { homeDir } from "./paths";

export const runnerFor = (h: HostConfig): Runner => (h.ssh.some ? sshRunner(h.id, h.ssh.value) : localRunner(homeDir()));

/** Agents enabled on this host, resolved to registry entries (unknown ids are dropped). */
export const agentsOn = (c: Config, h: HostConfig): readonly Agent[] =>
  hostAgents(c, h).flatMap((id) => { const a = agentById(id); return a.some ? [a.value] : []; });

/** agent id → home-relative user dir (`~/.claude/skills`) */
export const agentDirsRel = (agents: readonly Agent[]): Record<string, string> =>
  Object.fromEntries(agents.map((a) => [a.id, a.userDir("~")]));

export const alsoReadsRel = (agents: readonly Agent[]): Record<string, string[]> =>
  Object.fromEntries(agents.filter((a) => a.alsoReads.length > 0).map((a) => [a.id, a.alsoReads.map((f) => f("~"))]));

/** agent id → home-relative plugin cache root, for agents with a plugin system */
export const pluginCachesRel = (agents: readonly Agent[]): Record<string, string> =>
  Object.fromEntries(agents.flatMap((a) => (a.plugins ? [[a.id, a.plugins.cache("~")] as const] : [])));

export const builtinDirsRel = (agents: readonly Agent[]): Record<string, string> =>
  Object.fromEntries(agents.flatMap((a) => (a.builtinDir ? [[a.id, a.builtinDir("~")] as const] : [])));

/** agent id → sorted skills wanted on this host (store skills plus CLI-owned skill names, so owned skills without a store copy still get ensured) */
export const desiredOn = (c: Config, skills: readonly Skill[], h: HostConfig): Record<string, string[]> => {
  const names = [...new Set([...skills.map((s) => s.name), ...c.owned.map((o) => o.skill)])];
  return Object.fromEntries(agentsOn(c, h).map((a) => [a.id, desiredFor(c, names, h.id, a.id)]));
};

/** agent id → plugin states on this host (agents with a plugin system only). */
export const pluginStatesOn = (c: Config, h: HostConfig, inv: Inventory, facts: HostFacts = hostFacts(inv)): Record<string, PluginState[]> =>
  Object.fromEntries(agentsOn(c, h).filter((a) => PLUGIN_AGENTS.includes(a.id)).map((a) => [a.id, pluginStates(inv, facts, a.id)]));

/** Desired plugin cells for this host; marketplace from the policy, else whatever marketplace the host already has the plugin from. `enabled: false` makes every cell unwanted. */
export const pluginCellsFor = (c: Config, h: HostConfig, states: Readonly<Record<string, readonly PluginState[]>>): PluginCell[] =>
  c.plugins.flatMap((p) =>
    agentsOn(c, h).filter((a) => PLUGIN_AGENTS.includes(a.id)).map((a): PluginCell => {
      const mk = marketplaceFor(p, a.id);
      const marketplace = mk.some ? mk.value : (states[a.id] ?? []).find((s) => s.name === p.name)?.marketplace ?? "";
      return { agent: a.id, name: p.name, marketplace, wanted: p.enabled && selects(p.hosts, h.id) && selects(p.agents, a.id) };
    }),
  );

export const ownedRules = (c: Config): OwnedRule[] =>
  c.owned.map((o) => ({ skill: o.skill, tool: o.tool, command: o.ensure.some ? o.ensure : defaultEnsure(o.tool, o.skill), fallback: o.fallback, agents: o.agents.some ? o.agents : defaultOwnedAgents(o.tool) }));

/** agent id → marketplaces configured on the host, from the files the probe shipped. */
export const marketplacesOn = (facts: HostFacts): Record<string, Readonly<Record<string, string>>> => ({ claude: facts.claudeMarketplaces, codex: facts.codex.marketplaces });

/**
 * Agents that read another agent's user dir (pi ← ~/.agents/skills, Codex's dir) load whatever lands there.
 * A managed skill that will sit there after this sync, and is not wanted for the reader, gets excluded in the reader's settings;
 * a skm-form exclusion of a managed skill that no longer applies is removed. Exclusions of other names are the user's and stay untouched.
 */
export const excludeCellsFor = (
  agents: readonly Agent[], desired: Readonly<Record<string, readonly string[]>>, inv: Inventory, facts: HostFacts, hubNames: ReadonlySet<string>, managed: readonly string[],
): ExcludeCell[] =>
  agents.flatMap((a) => {
    if (a.excludes === undefined) return [];
    const now = facts.excluded[a.id] ?? new Set<string>();
    const shared = a.alsoReads.map((f) => f(inv.home));
    const writers = agents.filter((w) => w.id !== a.id && shared.includes(w.userDir(inv.home)));
    const writerDir = (dir: string): boolean => writers.some((w) => w.userDir(inv.home) === dir);
    // an entry stays unless it is a store link skm is about to unlink from a writer's dir; entries without SKILL.md never load
    const stays = (name: string): boolean =>
      (inv.alsoReads[a.id] ?? []).some((e) => e.name === name && entryHash(e) !== ""
        && !(e.kind === "managed" && hubNames.has(name) && writerDir(inv.alsoDirs[a.id]?.[name] ?? shared[0] ?? "") && !writers.some((w) => (desired[w.id] ?? []).includes(name))));
    const lands = (name: string): boolean => writers.some((w) => (desired[w.id] ?? []).includes(name)) || stays(name);
    return [...new Set(managed)].sort().flatMap((skill): ExcludeCell[] => {
      const wanted = !(desired[a.id] ?? []).includes(skill) && lands(skill);
      const present = now.has(skill);
      return wanted || present ? [{ agent: a.id, skill, wanted, present }] : [];
    });
  });

export const planFor = (c: Config, skills: readonly Skill[], h: HostConfig, inv: Inventory, hubMarketplaces: Readonly<Record<string, string>> = {}): Op[] => {
  const facts = hostFacts(inv);
  const states = pluginStatesOn(c, h, inv, facts);
  const agents = agentsOn(c, h);
  const owned = ownedRules(c);
  const desired = desiredOn(c, skills, h);
  // A CLI-owned skill can already reach a reader through a writer's shared directory.
  // Keep the target wanted, but do not install a second store copy over that CLI version.
  const toInstall = Object.fromEntries(agents.map((a) => {
    const provided = new Set(effectiveFor(inv, facts, a).filter((e) => {
      if (e.source.kind !== "legacy" || e.storage.kind !== "real-dir") return false;
      if (inv.agentDirs[a.id]?.entries.some((entry) => entry.name === e.name)) return false;
      const dir = e.source.dir;
      return owned.some((o) => o.skill === e.name && inv.tools[o.tool] !== undefined && o.agents.some
        && !o.agents.value.includes(a.id) && o.agents.value.some((id) => {
          const writer = agentById(id);
          return writer.some && writer.value.userDir(inv.home) === dir;
        }));
    }).map((e) => e.name));
    return [a.id, (desired[a.id] ?? []).filter((name) => !provided.has(name))];
  }));
  return planHost({
    hostId: h.id,
    isLocal: !h.ssh.some,
    desired: toInstall,
    inventory: inv,
    hubSkills: skills.map((s) => ({ name: s.name, hash: s.contentHash })),
    agentDirs: agentDirsRel(agents),
    plugins: pluginCellsFor(c, h, states),
    pluginStates: states,
    marketplaces: marketplacesOn(facts),
    hubMarketplaces,
    owned,
    tools: inv.tools,
    excludes: excludeCellsFor(agents, desired, inv, facts, new Set(skills.map((s) => s.name)), [...skills.map((s) => s.name), ...c.owned.map((o) => o.skill)]),
  });
};

/** Every home-relative path a backup should capture on this host. */
export const backupPathsFor = (h: HostConfig, agents: readonly Agent[]): string[] => [
  `${h.skm}/skills`,
  ...agents.map((a) => a.userDir("~")),
  ...agents.flatMap((a) => a.alsoReads.map((f) => f("~"))),
  // v2: the plugin switches sync may flip
  ...(agents.some((a) => a.id === "claude") ? ["~/.claude/settings.json", "~/.claude/plugins/installed_plugins.json"] : []),
  ...(agents.some((a) => a.id === "codex") ? ["~/.codex/config.toml"] : []),
  ...agents.flatMap((a) => (a.excludes ? [a.excludes.file("~")] : [])),
];
