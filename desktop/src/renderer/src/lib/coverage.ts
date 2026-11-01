/**
 * One sentence for "where is this enabled" that stays short however many hosts and agents there are.
 * Input: every known (host, agent) cell and whether the thing is wanted there after the next apply.
 */

export type CoverageCell = { readonly host: string; readonly agent: string; readonly on: boolean };

export type CoverageSummary =
  | { readonly kind: "everywhere" }
  | { readonly kind: "nowhere" }
  | { readonly kind: "only-hosts"; readonly hosts: readonly string[] }
  | { readonly kind: "except-hosts"; readonly hosts: readonly string[] }
  | { readonly kind: "only-agents"; readonly agents: readonly string[] }
  | { readonly kind: "except-agents"; readonly agents: readonly string[] }
  | { readonly kind: "partial"; readonly on: number; readonly total: number };

const uniq = <T,>(xs: readonly T[]): T[] => [...new Set(xs)];

/** Split groups (hosts or agents) into all-on / all-off; null when some group is mixed. */
const splitBy = (cells: readonly CoverageCell[], key: (c: CoverageCell) => string): { readonly on: string[]; readonly off: string[] } | null => {
  const groups = uniq(cells.map(key));
  const state = groups.map((g) => {
    const xs = cells.filter((c) => key(c) === g);
    return xs.every((c) => c.on) ? "on" : xs.every((c) => !c.on) ? "off" : "mixed";
  });
  if (state.includes("mixed")) return null;
  return { on: groups.filter((_, i) => state[i] === "on"), off: groups.filter((_, i) => state[i] === "off") };
};

/** Pure. Prefers the shorter of "only X" and "all but Y"; hosts before agents; a count when neither axis splits cleanly. */
export const summarize = (cells: readonly CoverageCell[]): CoverageSummary => {
  const on = cells.filter((c) => c.on).length;
  if (on === 0) return { kind: "nowhere" };
  if (on === cells.length) return { kind: "everywhere" };
  const byHost = splitBy(cells, (c) => c.host);
  if (byHost !== null) return byHost.on.length <= byHost.off.length ? { kind: "only-hosts", hosts: byHost.on } : { kind: "except-hosts", hosts: byHost.off };
  const byAgent = splitBy(cells, (c) => c.agent);
  if (byAgent !== null) return byAgent.on.length <= byAgent.off.length ? { kind: "only-agents", agents: byAgent.on } : { kind: "except-agents", agents: byAgent.off };
  return { kind: "partial", on, total: cells.length };
};

/** One coloured share of the coverage bar. */
export type Segment = { readonly key: string; readonly count: number; readonly className: string };
