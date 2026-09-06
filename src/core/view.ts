import type { Agent } from "./agents";
import { type BudgetOverrides, type BudgetReport, simulateListingOf } from "./budget";
import { type Effective, type Finding, type HostFacts, type PluginState, effectiveFor, hostFacts, hostFindings, pluginStates, sourceCounts } from "./effective";
import type { Inventory } from "./inventory";
import type { Source } from "./sources";

/** Everything the UIs show about one probed host, derived purely from its inventory. */
export type HostView = {
  readonly facts: HostFacts;
  readonly states: Readonly<Record<string, readonly PluginState[]>>;
  readonly effective: Readonly<Record<string, readonly Effective[]>>;
  readonly budget: Readonly<Record<string, BudgetReport>>;
  readonly counts: Readonly<Record<string, Record<Source["kind"], number>>>;
  readonly findings: readonly Finding[];
};

/** Claude's listing budget overrides come from the host's own settings.json; the hub's are the fallback. */
const overridesFor = (agent: Agent, facts: HostFacts, hub: BudgetOverrides): BudgetOverrides =>
  agent.id === "claude" ? (Object.keys(facts.claudeOverrides).length > 0 ? facts.claudeOverrides : hub) : {};

export const buildHostView = (hostId: string, agents: readonly Agent[], inv: Inventory, contextTokens: number, hubOverrides: BudgetOverrides = {}): HostView => {
  const facts = hostFacts(inv);
  const states = Object.fromEntries(agents.filter((a) => a.plugins !== undefined).map((a) => [a.id, pluginStates(inv, facts, a.id)]));
  const effective = Object.fromEntries(agents.map((a) => [a.id, effectiveFor(inv, facts, a)]));
  const budget = Object.fromEntries(agents.map((a) => [a.id, simulateListingOf(a, (effective[a.id] ?? []).map((e) => ({ name: e.name, listing: e.listing })), contextTokens, overridesFor(a, facts, hubOverrides))]));
  const counts = Object.fromEntries(agents.map((a) => [a.id, sourceCounts(effective[a.id] ?? [])]));
  return { facts, states, effective, budget, counts, findings: hostFindings(hostId, effective, states) };
};

/** Plugins that contribute skills for an agent (enabled or implicit, with an active version). */
export const activePlugins = (states: readonly PluginState[]): PluginState[] =>
  states.filter((p) => p.enabled !== "off" && p.active.some && p.active.value.skills.length > 0);

/** Short human summary of the plugins active for an agent: "superpowers 6.3.0 · linear-cli 2.0.0 +3". `max` caps the names shown. */
export const activePluginsText = (states: readonly PluginState[], max = Number.POSITIVE_INFINITY): string => {
  const ps = activePlugins(states);
  const shown = ps.slice(0, max).map((p) => `${p.name} ${p.active.some ? p.active.value.version.slice(0, 12) : ""}`.trim());
  return ps.length > shown.length ? `${shown.join(" · ")} +${ps.length - shown.length}` : shown.join(" · ");
};
