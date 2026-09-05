import { matchesAny } from "../lib/glob";
import { none } from "../lib/result";
import { type Cell, type Config, type Rule, type Selector, cellEq, hostAgents, hostById } from "./config";

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
    const updated: Rule = {
      ...last,
      on: on ? [...without(last.on), cell] : without(last.on),
      off: on ? without(last.off) : [...without(last.off), cell],
    };
    return { ...c, rules: [...c.rules.slice(0, -1), updated] };
  }
  const fresh: Rule = { skills: [skill], hosts: none, agents: none, on: on ? [cell] : [], off: on ? [] : [cell] };
  return { ...c, rules: [...c.rules, fresh] };
};

