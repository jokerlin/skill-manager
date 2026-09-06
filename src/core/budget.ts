import type { Agent } from "./agents";
import { type Skill, listingOf } from "./skill";

export type BudgetEntry = {
  readonly name: string;
  readonly chars: number;        // raw description + when_to_use length
  readonly cappedChars: number;  // after the agent's per-skill cap
  readonly entryChars: number;   // what the listing line costs (Claude: `- name: desc`)
  readonly kept: boolean;        // description survives the budget (name is always listed)
};

/** The context window an agent budgets against. `bytesPerToken` only matters for Claude (tokens × chars/token × fraction). */
export type ListingContext = { readonly contextTokens: number; readonly bytesPerToken: number; readonly reason: string };

export type BudgetReport = {
  readonly agentId: string;
  readonly context: ListingContext;
  readonly budgetChars: number;
  readonly usedChars: number;    // sum of entry chars (+ separators) before dropping
  readonly perSkill: readonly BudgetEntry[];
  readonly droppedCount: number;
  readonly overBy: number;       // usedChars - budgetChars, min 0
  readonly note: string;
};

/** Claude: skillListingBudgetFraction / skillListingMaxDescChars from settings.json, SLASH_COMMAND_TOOL_CHAR_BUDGET from its env block. */
export type BudgetOverrides = { readonly fraction?: number; readonly maxDescChars?: number; readonly fixedChars?: number };

type Rules = {
  readonly budget: number;
  readonly cap: number;
  readonly note: string;
  readonly entryChars: (name: string, cappedChars: number) => number;
  readonly separator: number;
  /** Chars freed when this entry loses its description (Claude keeps `- name`). */
  readonly dropSaves: (name: string, entryChars: number) => number;
};

const BUNDLED_NOTE = "Claude Code's own bundled skills are listed too but not counted here (see /context in Claude Code)";

const budgetFor = (agent: Agent, ctx: ListingContext, o: BudgetOverrides): Rules => {
  switch (agent.listing.kind) {
    case "claude": {
      const fraction = o.fraction ?? agent.listing.budgetFraction;
      const cap = o.maxDescChars ?? agent.listing.maxDescChars;
      const fixed = o.fixedChars !== undefined && o.fixedChars > 0 ? o.fixedChars : undefined;
      const budget = fixed ?? Math.max(1, Math.floor(ctx.contextTokens * ctx.bytesPerToken * fraction));
      const formula = fixed !== undefined
        ? `listing budget fixed at ${budget} chars by SLASH_COMMAND_TOOL_CHAR_BUDGET`
        : `listing budget = ${ctx.contextTokens} tokens × ${ctx.bytesPerToken} chars/token × ${fraction} = ${budget} chars (${ctx.reason})`;
      return {
        budget,
        cap,
        note: `Claude Code: ${formula}; per-skill cap ${cap} chars; least-used descriptions dropped first; ${BUNDLED_NOTE}`,
        entryChars: (name, capped) => name.length + 4 + capped,
        separator: 1,
        dropSaves: (name, entry) => entry - (name.length + 2),
      };
    }
    case "codex": {
      const fraction = o.fraction ?? agent.listing.budgetFraction;
      return {
        budget: Math.floor(ctx.contextTokens * fraction),
        cap: Number.POSITIVE_INFINITY,
        note: `Codex: listing budget = context × ${fraction} chars (${agent.listing.fallbackChars} when unknown); descriptions shortened first`,
        entryChars: (_name, capped) => capped,
        separator: 0,
        dropSaves: (_name, entry) => entry,
      };
    }
    case "plain":
      return {
        budget: Number.POSITIVE_INFINITY,
        cap: Number.POSITIVE_INFINITY,
        note: `${agent.name}: no documented listing budget`,
        entryChars: (_name, capped) => capped,
        separator: 0,
        dropSaves: (_name, entry) => entry,
      };
  }
};

export type ListingItem = { readonly name: string; readonly listing: string };

/** Store skills as listing items. */
export const listingItems = (skills: readonly Skill[]): ListingItem[] => skills.map((s) => ({ name: s.name, listing: listingOf(s) }));

/** Convenience over `simulateListingOf` for store skills. */
export const simulateListing = (agent: Agent, skills: readonly Skill[], ctx: ListingContext, overrides: BudgetOverrides = {}): BudgetReport =>
  simulateListingOf(agent, listingItems(skills), ctx, overrides);

/**
 * Simulate what an agent keeps at startup from any set of (name, listing text) items — store skills,
 * plugin skills, builtins alike. We do not know invocation frequency, so we drop the largest
 * descriptions first — a conservative stand-in for "least used".
 */
export const simulateListingOf = (
  agent: Agent,
  items: readonly ListingItem[],
  ctx: ListingContext,
  overrides: BudgetOverrides = {},
): BudgetReport => {
  const rules = budgetFor(agent, ctx, overrides);
  const entries = items.map((s) => {
    const chars = s.listing.length;
    const cappedChars = Math.min(chars, rules.cap);
    return { name: s.name, chars, cappedChars, entryChars: rules.entryChars(s.name, cappedChars) };
  });
  const used = entries.reduce((n, e) => n + e.entryChars, 0) + rules.separator * Math.max(0, entries.length - 1);
  // drop largest first until under budget
  const dropOrder = [...entries].sort((a, b) => b.entryChars - a.entryChars || b.name.localeCompare(a.name));
  const dropped = dropOrder.reduce<{ remaining: number; names: Set<string> }>(
    (acc, e) => (acc.remaining > rules.budget ? { remaining: acc.remaining - rules.dropSaves(e.name, e.entryChars), names: new Set([...acc.names, e.name]) } : acc),
    { remaining: used, names: new Set() },
  ).names;
  return {
    agentId: agent.id,
    context: ctx,
    budgetChars: rules.budget,
    usedChars: used,
    perSkill: entries.map((e) => ({ ...e, kept: !dropped.has(e.name) })),
    droppedCount: dropped.size,
    overBy: Math.max(0, used - rules.budget),
    note: rules.note,
  };
};
