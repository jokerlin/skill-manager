import type { Agent } from "./agents";
import { type BudgetOverrides, type BudgetReport, type ListingContext, type ListingItem, fallbackContext, simulateListingOf } from "./budget";
import { resolveClaudeWindow } from "./claude-model";
import { resolveCodexWindow } from "./codex-model";
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
const overridesFor = (agent: Agent, facts: HostFacts, hub: BudgetOverrides): BudgetOverrides => {
  if (agent.id === "claude") return Object.keys(facts.claudeOverrides).length > 0 ? facts.claudeOverrides : hub;
  if (agent.id === "codex") return facts.codex.skillsMaxContextTokens.some ? { fixedTokens: facts.codex.skillsMaxContextTokens.value } : {};
  return {};
};

/** What the agent prints per skill: plugin skills as `plugin:skill`; Codex lists the frontmatter description alone, Claude adds when_to_use. */
export const listingItemFor = (agent: Agent, e: Effective): ListingItem => ({
  name: e.name,
  label: e.source.kind === "plugin" ? `${e.source.plugin}:${e.name}` : e.name,
  listing: agent.id === "codex" ? e.description : e.listing,
  locator: `${e.path}/SKILL.md`,
});

/** Claude budgets against its model's window (settings.json `model`, env DISABLE_1M); config `contextTokens` is the fallback for unknown models and for other agents. */
export const contextFor = (agent: Agent, facts: HostFacts, fallbackTokens: number): ListingContext => {
  if (agent.id === "codex") {
    const w = resolveCodexWindow(facts.codex.model, facts.codex.modelContextWindow, facts.codexModels);
    if (w.some) return fallbackContext(agent, w.value.contextTokens, w.value.reason);
    const why = facts.codex.model.some ? `model "${facts.codex.model.value}" not in ~/.codex/models_cache.json` : "no model in config.toml";
    return fallbackContext(agent, fallbackTokens, `${why} → config contextTokens`);
  }
  if (agent.id !== "claude") return fallbackContext(agent, fallbackTokens, "config contextTokens");
  const w = resolveClaudeWindow(facts.claudeModel, facts.claudeDisable1m);
  if (w.some) return w.value;
  const why = facts.claudeModel.some ? `model "${facts.claudeModel.value}" not recognised` : "no model in settings.json";
  return { contextTokens: fallbackTokens, bytesPerToken: 3, reason: `${why} → config contextTokens, 3 chars/token` };
};

export const buildHostView = (hostId: string, agents: readonly Agent[], inv: Inventory, contextTokens: number, hubOverrides: BudgetOverrides = {}): HostView => {
  const facts = hostFacts(inv);
  const states = Object.fromEntries(agents.filter((a) => a.plugins !== undefined).map((a) => [a.id, pluginStates(inv, facts, a.id)]));
  const effective = Object.fromEntries(agents.map((a) => [a.id, effectiveFor(inv, facts, a)]));
  const budget = Object.fromEntries(agents.map((a) => [a.id, simulateListingOf(a, (effective[a.id] ?? []).map((e) => listingItemFor(a, e)), contextFor(a, facts, contextTokens), overridesFor(a, facts, hubOverrides))]));
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
