import { matchesAny } from "../lib/glob";
import { none } from "../lib/result";
import { ALL, type Cell, type Config, PLUGIN_AGENTS, type PluginPolicy, type Rule, type Selector, cellEq, hostAgents, hostById } from "./config";

export const selects = (sel: Selector, id: string): boolean => {
  switch (sel.kind) {
    case "all":
      return true;
    case "only":
      return matchesAny(sel.globs, id);
    case "except":
      return !matchesAny(sel.globs, id);
  }
};

export type EffectiveScope = {
  readonly hosts: Selector;
  readonly agents: Selector;
  /** cell overrides in rule order; the last matching one wins */
  readonly overrides: readonly { readonly cell: Cell; readonly on: boolean }[];
};

const rulesFor = (c: Config, skill: string): readonly Rule[] => c.rules.filter((r) => matchesAny(r.skills, skill));

/** defaults ⊕ every matching rule, later rules override earlier ones per field. */
export const scopeOf = (c: Config, skill: string): EffectiveScope =>
  rulesFor(c, skill).reduce<EffectiveScope>(
    (acc, r) => ({
      hosts: r.hosts.some ? r.hosts.value : acc.hosts,
      agents: r.agents.some ? r.agents.value : acc.agents,
      overrides: [
        ...acc.overrides,
        ...r.off.map((cell) => ({ cell, on: false })),
        ...r.on.map((cell) => ({ cell, on: true })),
      ],
    }),
    { hosts: c.defaults.hosts, agents: c.defaults.agents, overrides: [] },
  );

/** Is `skill` wanted in the (host, agent) cell? Pure. */
export const isDesired = (c: Config, skill: string, hostId: string, agentId: string): boolean => {
  const host = hostById(c, hostId);
  if (!host.some || !hostAgents(c, host.value).includes(agentId)) return false;
  const s = scopeOf(c, skill);
  const cell: Cell = { host: hostId, agent: agentId };
  return s.overrides.reduce(
    (acc, o) => (cellEq(o.cell, cell) ? o.on : acc),
    selects(s.hosts, hostId) && selects(s.agents, agentId),
  );
};

/** Sorted skill names wanted in one cell. */
export const desiredFor = (c: Config, skills: readonly string[], hostId: string, agentId: string): string[] =>
  skills.filter((s) => isDesired(c, s, hostId, agentId)).sort();

const isExactRuleFor = (r: Rule, skill: string): boolean =>
  r.skills.length === 1 && r.skills[0] === skill && !r.hosts.some && !r.agents.some;

/**
 * Toggle one cell for one skill by rewriting rules. Idempotent: returns the same config
 * when the cell already has the requested state. Appends (or extends a trailing) exact-name rule.
 */
export const setScope = (c: Config, skill: string, hostId: string, agentId: string, on: boolean): Config => {
  if (isDesired(c, skill, hostId, agentId) === on) return c;
  const cell: Cell = { host: hostId, agent: agentId };
  const last = c.rules[c.rules.length - 1];
  const without = (cells: readonly Cell[]) => cells.filter((x) => !cellEq(x, cell));
  if (last && isExactRuleFor(last, skill)) {
    // drop this cell's override first; if the earlier rules already give the wanted state, stop there
    const cleared: Rule = { ...last, on: without(last.on), off: without(last.off) };
    const empty = cleared.on.length === 0 && cleared.off.length === 0;
    const base: Config = { ...c, rules: empty ? c.rules.slice(0, -1) : [...c.rules.slice(0, -1), cleared] };
    if (isDesired(base, skill, hostId, agentId) === on) return base;
    const updated: Rule = { ...cleared, on: on ? [...cleared.on, cell] : cleared.on, off: on ? cleared.off : [...cleared.off, cell] };
    return { ...c, rules: [...c.rules.slice(0, -1), updated] };
  }
  const fresh: Rule = { skills: [skill], hosts: none, agents: none, on: on ? [cell] : [], off: on ? [] : [cell] };
  return { ...c, rules: [...c.rules, fresh] };
};


// ---------- plugins ----------

/** Is a plugin policy wanted in one (host, agent) cell? `enabled: false` wins; then cell overrides (off before on, as in rules); then the selectors. Pure. */
export const pluginWanted = (p: PluginPolicy, hostId: string, agentId: string): boolean => {
  if (!p.enabled) return false;
  const cell: Cell = { host: hostId, agent: agentId };
  if (p.on.some((x) => cellEq(x, cell))) return true;
  if (p.off.some((x) => cellEq(x, cell))) return false;
  return selects(p.hosts, hostId) && selects(p.agents, agentId);
};

/** `name@marketplace` → { name, marketplace } (marketplace "" when the id has no @). */
export const splitPluginId = (id: string): { readonly name: string; readonly marketplace: string } => {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: "" };
};

/**
 * Toggle one plugin cell. `plugin` is a name or `name@marketplace`. Idempotent.
 * A plugin the config does not know yet gets a policy that keeps today's state everywhere else:
 * `hosts: { only: [] }` plus an `on` cell for every cell in `activeCells` (where it is enabled now), then the toggle.
 * Without that, a fresh policy would default to all hosts × all agents and install the plugin everywhere on the next sync.
 */
export const setPluginScope = (
  c: Config, plugin: string, hostId: string, agentId: string, on: boolean, activeCells: readonly Cell[] = [],
): Config => {
  const { name, marketplace } = splitPluginId(plugin);
  const cell: Cell = { host: hostId, agent: agentId };
  const without = (cells: readonly Cell[]) => cells.filter((x) => !cellEq(x, cell));
  const existing = c.plugins.find((p) => p.name === name);
  const base: PluginPolicy = existing ?? {
    name,
    marketplace: marketplace.length > 0 ? Object.fromEntries(PLUGIN_AGENTS.map((a) => [a, marketplace])) : {},
    hosts: { kind: "only", globs: [] },
    agents: ALL,
    enabled: true,
    on: activeCells.filter((x, i) => activeCells.findIndex((y) => cellEq(x, y)) === i),
    off: [],
  };
  if (pluginWanted(base, hostId, agentId) === on && existing !== undefined) return c;
  // every cell of a policy switched off with `enabled: false` is off today; turning one on keeps the others off
  const enabled: PluginPolicy = base.enabled ? base : { ...base, enabled: true, hosts: { kind: "only", globs: [] }, on: [], off: [] };
  const bySelectors = selects(enabled.hosts, hostId) && selects(enabled.agents, agentId);
  // drop the cell from both lists, then add an override only when the selectors disagree with the wanted state
  const cleared: PluginPolicy = { ...enabled, on: without(enabled.on), off: without(enabled.off) };
  const next: PluginPolicy = bySelectors === on ? cleared : on ? { ...cleared, on: [...cleared.on, cell] } : { ...cleared, off: [...cleared.off, cell] };
  return existing === undefined
    ? { ...c, plugins: [...c.plugins, next] }
    : { ...c, plugins: c.plugins.map((p) => (p.name === name ? next : p)) };
};
