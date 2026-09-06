import type { Agent } from "./agents";
import { type Skill, listingOf } from "./skill";

export type BudgetEntry = {
  readonly name: string;
  readonly chars: number;        // raw description + when_to_use length
  readonly cappedChars: number;  // after the agent's per-skill cap
  readonly kept: boolean;        // description survives the budget (name is always listed)
};

export type BudgetReport = {
  readonly agentId: string;
  readonly budgetChars: number;
  readonly usedChars: number;    // sum of capped chars before dropping
  readonly perSkill: readonly BudgetEntry[];
  readonly droppedCount: number;
  readonly overBy: number;       // usedChars - budgetChars, min 0
  readonly note: string;
};

export type BudgetOverrides = { readonly fraction?: number; readonly maxDescChars?: number };

const budgetFor = (agent: Agent, contextTokens: number, o: BudgetOverrides): { budget: number; cap: number; note: string } => {
  switch (agent.listing.kind) {
    case "claude": {
      const fraction = o.fraction ?? agent.listing.budgetFraction;
      const cap = o.maxDescChars ?? agent.listing.maxDescChars;
      return {
        budget: Math.floor(contextTokens * fraction),
        cap,
        note: `Claude Code: listing budget = context × ${fraction} chars; per-skill cap ${cap} chars; least-used descriptions dropped first`,
      };
    }
    case "codex": {
      const fraction = o.fraction ?? agent.listing.budgetFraction;
      return {
        budget: Math.floor(contextTokens * fraction),
        cap: Number.POSITIVE_INFINITY,
        note: `Codex: listing budget = context × ${fraction} chars (${agent.listing.fallbackChars} when unknown); descriptions shortened first`,
      };
    }
    case "plain":
      return { budget: Number.POSITIVE_INFINITY, cap: Number.POSITIVE_INFINITY, note: `${agent.name}: no documented listing budget` };
  }
};

export type ListingItem = { readonly name: string; readonly listing: string };

/** Store skills as listing items. */
export const listingItems = (skills: readonly Skill[]): ListingItem[] => skills.map((s) => ({ name: s.name, listing: listingOf(s) }));

/** Convenience over `simulateListingOf` for store skills. */
export const simulateListing = (agent: Agent, skills: readonly Skill[], contextTokens: number, overrides: BudgetOverrides = {}): BudgetReport =>
  simulateListingOf(agent, listingItems(skills), contextTokens, overrides);

/**
 * Simulate what an agent keeps at startup from any set of (name, listing text) items — store skills,
 * plugin skills, builtins alike. We do not know invocation frequency, so we drop the largest
 * descriptions first — a conservative stand-in for "least used".
 */
export const simulateListingOf = (
  agent: Agent,
  items: readonly ListingItem[],
  contextTokens: number,
  overrides: BudgetOverrides = {},
): BudgetReport => {
  const { budget, cap, note } = budgetFor(agent, contextTokens, overrides);
  const entries = items.map((s) => {
    const chars = s.listing.length;
    return { name: s.name, chars, cappedChars: Math.min(chars, cap) };
  });
  const used = entries.reduce((n, e) => n + e.cappedChars, 0);
  // drop largest first until under budget
  const dropOrder = [...entries].sort((a, b) => b.cappedChars - a.cappedChars || b.name.localeCompare(a.name));
  const dropped = dropOrder.reduce<{ remaining: number; names: Set<string> }>(
    (acc, e) => (acc.remaining > budget ? { remaining: acc.remaining - e.cappedChars, names: new Set([...acc.names, e.name]) } : acc),
    { remaining: used, names: new Set() },
  ).names;
  return {
    agentId: agent.id,
    budgetChars: budget,
    usedChars: used,
    perSkill: entries.map((e) => ({ ...e, kept: !dropped.has(e.name) })),
    droppedCount: dropped.size,
    overBy: Math.max(0, used - budget),
    note,
  };
};
