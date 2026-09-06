import type { Agent, ListingRule } from "./agents";
import { type Skill, listingOf } from "./skill";

export type BudgetEntry = {
  readonly name: string;
  readonly chars: number;        // raw description + when_to_use length
  readonly cappedChars: number;  // after the agent's per-skill cap
  /** What the listing line costs, in the report's `unit` (Claude: chars of `- name: desc`; Codex: ⌈bytes/4⌉ tokens of `- name: desc (file: path)`). */
  readonly entryChars: number;
  /** Claude: the description survives (the name is always listed). Codex: the skill is not omitted (its description may still be shortened). */
  readonly kept: boolean;
};

/** The context window an agent budgets against. Claude: tokens × chars/token × fraction = chars. Codex: tokens × fraction = tokens, bytes/token converts line bytes to tokens. */
export type ListingContext = { readonly contextTokens: number; readonly bytesPerToken: number; readonly reason: string };

/** Unit of `budgetChars` / `usedChars` / `overBy`: Claude budgets in chars, Codex in tokens (unless its window is unknown). */
export type BudgetUnit = "chars" | "tokens";
/** What `droppedCount` counts: Claude drops whole descriptions; Codex shortens every description first and omits whole skills only as a last resort. */
export type TrimKind = "dropped" | "shortened" | "omitted";

export type BudgetReport = {
  readonly agentId: string;
  readonly context: ListingContext;
  readonly unit: BudgetUnit;
  readonly budgetChars: number;  // in `unit` (field name kept for the JSON consumers)
  readonly usedChars: number;    // in `unit`: what the untrimmed listing costs
  readonly perSkill: readonly BudgetEntry[];
  readonly trim: TrimKind;
  readonly droppedCount: number; // how many `trim` events the simulation predicts
  readonly overBy: number;       // usedChars - budgetChars, min 0, in `unit`
  readonly note: string;
};

/**
 * Claude: skillListingBudgetFraction / skillListingMaxDescChars from settings.json, SLASH_COMMAND_TOOL_CHAR_BUDGET from its env block.
 * Codex: `[skills] max_context_tokens` from config.toml (`fixedTokens`).
 */
export type BudgetOverrides = { readonly fraction?: number; readonly maxDescChars?: number; readonly fixedChars?: number; readonly fixedTokens?: number };

export type ListingItem = {
  readonly name: string;
  /** how the agent prints the name in its catalog — plugin skills appear as `plugin:skill` (defaults to `name`) */
  readonly label?: string;
  readonly listing: string;
  /** path Codex prints after the description, e.g. `<dir>/SKILL.md` */
  readonly locator?: string;
};

/** Store skills as listing items. */
export const listingItems = (skills: readonly Skill[]): ListingItem[] => skills.map((s) => ({ name: s.name, listing: listingOf(s), locator: `${s.dir}/SKILL.md` }));

/** The window to budget against when nothing better is known (hosts not probed, agents without a model setting). */
export const fallbackContext = (agent: Agent, contextTokens: number, reason: string): ListingContext => {
  switch (agent.listing.kind) {
    case "claude": return { contextTokens, bytesPerToken: 3, reason };
    case "codex": return { contextTokens, bytesPerToken: agent.listing.bytesPerToken, reason };
    case "plain": return { contextTokens, bytesPerToken: 1, reason };
  }
};

export const unitSuffix = (b: { readonly unit: BudgetUnit }): "c" | "t" => (b.unit === "tokens" ? "t" : "c");

export const trimText = (b: { readonly trim: TrimKind; readonly droppedCount: number }): string => {
  switch (b.trim) {
    case "dropped": return `~${b.droppedCount} descriptions dropped`;
    case "shortened": return `${b.droppedCount} descriptions shortened`;
    case "omitted": return `${b.droppedCount} skills omitted entirely`;
  }
};

// ---------- Claude Code / plain agents: a char budget over `- name: desc` lines ----------

type CharRule = Extract<ListingRule, { kind: "claude" | "plain" }>;
type CodexRule = Extract<ListingRule, { kind: "codex" }>;

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

const budgetFor = (agent: Agent, rule: CharRule, ctx: ListingContext, o: BudgetOverrides): Rules => {
  switch (rule.kind) {
    case "claude": {
      const fraction = o.fraction ?? rule.budgetFraction;
      const cap = o.maxDescChars ?? rule.maxDescChars;
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

/** We do not know invocation frequency, so we drop the largest descriptions first — a conservative stand-in for "least used". */
const simulateChars = (agent: Agent, rule: CharRule, items: readonly ListingItem[], ctx: ListingContext, overrides: BudgetOverrides): BudgetReport => {
  const rules = budgetFor(agent, rule, ctx, overrides);
  const entries = items.map((s) => {
    const chars = s.listing.length;
    const cappedChars = Math.min(chars, rules.cap);
    return { name: s.name, chars, cappedChars, entryChars: rules.entryChars(s.label ?? s.name, cappedChars) };
  });
  const used = entries.reduce((n, e) => n + e.entryChars, 0) + rules.separator * Math.max(0, entries.length - 1);
  const dropOrder = [...entries].sort((a, b) => b.entryChars - a.entryChars || b.name.localeCompare(a.name));
  const dropped = dropOrder.reduce<{ remaining: number; names: Set<string> }>(
    (acc, e) => (acc.remaining > rules.budget ? { remaining: acc.remaining - rules.dropSaves(items.find((i) => i.name === e.name)?.label ?? e.name, e.entryChars), names: new Set([...acc.names, e.name]) } : acc),
    { remaining: used, names: new Set() },
  ).names;
  return {
    agentId: agent.id,
    context: ctx,
    unit: "chars",
    budgetChars: rules.budget,
    usedChars: used,
    perSkill: entries.map((e) => ({ ...e, kept: !dropped.has(e.name) })),
    trim: "dropped",
    droppedCount: dropped.size,
    overBy: Math.max(0, used - rules.budget),
    note: rules.note,
  };
};

// ---------- Codex: a token budget over `- name: desc (file: path)` lines (codex-rs/ext/skills/src/render.rs) ----------

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;
const charCount = (s: string): number => [...s].length;
const dirname = (p: string): string => { const i = p.lastIndexOf("/"); return i <= 0 ? "" : p.slice(0, i); };

/** MAX_CATALOG_SKILL_DESCRIPTION_CHARS: longer descriptions are cut and end in "...". */
const capDescription = (desc: string, max: number): string => (charCount(desc) <= max ? desc : `${[...desc].slice(0, Math.max(0, max - 3)).join("")}...`);

/** SkillLine::render_with_description, plus the newline metadata_line_cost adds. */
const codexLine = (name: string, desc: string, locator: string): string => (desc === "" ? `- ${name}: (file: ${locator})\n` : `- ${name}: ${desc} (file: ${locator})\n`);

/** Byte lengths of catalog_prompt.rs SKILLS_INTRO_WITH_HOST_ALIASES / SKILLS_INTRO_WITH_SOURCE_LOCATORS — the aliased catalog swaps the intro and adds a `### Skill roots` table. */
const CODEX_INTRO_BYTES = { aliased: 261, unaliased: 425 } as const;

// host_aliases.rs: plugin skills share one alias root per plugin version, or per marketplace when that version holds a single skill.
const pluginMarketplaceBase = (root: string): string | undefined => {
  const segs = root.split("/");
  const i = segs.reduce<number>((found, _s, k) => (k >= 2 && segs[k - 1] === "cache" && segs[k - 2] === "plugins" ? k : found), -1);
  return i < 0 ? undefined : segs.slice(0, i + 1).join("/");
};
const pluginVersionBase = (root: string): string | undefined => {
  const mk = pluginMarketplaceBase(root);
  if (mk === undefined) return undefined;
  const [plugin, version] = root.slice(mk.length + 1).split("/");
  return plugin !== undefined && plugin !== "" && version !== undefined && version !== "" ? `${mk}/${plugin}/${version}` : undefined;
};
/** shared_host_alias_roots: the alias root Codex advertises for each skill root, in order. */
export const sharedAliasRoots = (roots: readonly string[]): string[] => {
  const counts = roots.reduce<ReadonlyMap<string, number>>((m, r) => {
    const v = pluginVersionBase(r);
    return v === undefined ? m : new Map(m).set(v, (m.get(v) ?? 0) + 1);
  }, new Map());
  return roots.map((r) => {
    const v = pluginVersionBase(r);
    return v !== undefined && (counts.get(v) ?? 0) <= 1 ? (pluginMarketplaceBase(r) ?? r) : r;
  });
};

type AliasRoot = { readonly name: string; readonly value: string };
/** AliasPlan::build — first occurrence order, `r0`, `r1`, … */
const aliasPlan = (roots: readonly string[]): AliasRoot[] =>
  roots.filter((r) => r !== "").reduce<AliasRoot[]>((acc, r) => (acc.some((a) => a.value === r) ? acc : [...acc, { name: `r${acc.length}`, value: r }]), []);
/** AliasPlan::shorten — the longest root that prefixes the locator wins. */
const shorten = (plan: readonly AliasRoot[], locator: string): string => {
  const hit = plan
    .filter((a) => locator.startsWith(`${a.value.replace(/\/+$/, "")}/`))
    .reduce<AliasRoot | undefined>((best, a) => (best === undefined || a.value.length > best.value.length ? a : best), undefined);
  return hit === undefined ? locator : `${hit.name}/${locator.slice(hit.value.replace(/\/+$/, "").length + 1)}`;
};

type CodexBudget = { readonly unit: BudgetUnit; readonly limit: number; readonly how: string };

/** skill_metadata_budget: configured tokens (capped) > 2% of the window in tokens > 8,000 chars when the window is unknown. */
const codexBudget = (rule: CodexRule, ctx: ListingContext, o: BudgetOverrides): CodexBudget => {
  const fraction = o.fraction ?? rule.budgetFraction;
  if (o.fixedTokens !== undefined && o.fixedTokens > 0) {
    const limit = Math.min(o.fixedTokens, rule.maxConfiguredTokens);
    return { unit: "tokens", limit, how: `[skills] max_context_tokens = ${o.fixedTokens}${limit < o.fixedTokens ? ` capped at ${rule.maxConfiguredTokens}` : ""}` };
  }
  if (ctx.contextTokens > 0) return { unit: "tokens", limit: Math.max(1, Math.floor(ctx.contextTokens * fraction)), how: `${ctx.contextTokens} tokens × ${fraction} (${ctx.reason})` };
  return { unit: "chars", limit: rule.fallbackChars, how: "context window unknown → fixed char budget" };
};

/** Codex's round-robin share-out of the leftover description budget, as a water-fill: how many descriptions end up shorter than written. */
const shortenedByWaterFill = (descCosts: readonly number[], remaining: number): number =>
  [...descCosts].sort((a, b) => a - b).reduce<{ left: number; n: number; shortened: number }>((acc, cost) => {
    const share = Math.floor(acc.left / acc.n);
    return cost <= share
      ? { left: acc.left - cost, n: acc.n - 1, shortened: acc.shortened }
      : { left: acc.left - share, n: acc.n - 1, shortened: acc.shortened + 1 };
  }, { left: remaining, n: descCosts.length, shortened: 0 }).shortened;

type CodexLine = { readonly name: string; readonly chars: number; readonly cappedChars: number; readonly entryChars: number; readonly minCost: number };
type Variant = { readonly overhead: number; readonly lines: readonly CodexLine[]; readonly rootsText: string };
type Outcome = { readonly perSkill: readonly BudgetEntry[]; readonly trim: TrimKind; readonly droppedCount: number; readonly used: number };

/** allocate_skill_lines against `limit - overhead`: phase 1 everything fits; phase 2 keep every skill, shorten descriptions; phase 3 omit skills whose empty-description line no longer fits. */
const allocate = (v: Variant, limit: number): Outcome => {
  const budget = limit - v.overhead;
  const used = v.overhead + v.lines.reduce((n, l) => n + l.entryChars, 0);
  const minimum = v.lines.reduce((n, l) => n + l.minCost, 0);
  const entry = (l: CodexLine, kept: boolean): BudgetEntry => ({ name: l.name, chars: l.chars, cappedChars: l.cappedChars, entryChars: l.entryChars, kept });
  if (used <= limit) return { perSkill: v.lines.map((l) => entry(l, true)), trim: "shortened", droppedCount: 0, used };
  if (minimum <= budget) return { perSkill: v.lines.map((l) => entry(l, true)), trim: "shortened", droppedCount: shortenedByWaterFill(v.lines.map((l) => l.entryChars - l.minCost), budget - minimum), used };
  const kept = v.lines.reduce<{ used: number; names: Set<string> }>(
    (acc, l) => (acc.used + l.minCost <= budget ? { used: acc.used + l.minCost, names: new Set([...acc.names, l.name]) } : acc),
    { used: 0, names: new Set() },
  ).names;
  return { perSkill: v.lines.map((l) => entry(l, kept.has(l.name))), trim: "omitted", droppedCount: v.lines.length - kept.size, used };
};

/** aliased_render_is_better: more skills included, then fewer shortened, then cheaper. */
const better = (a: Outcome, b: Outcome): boolean => {
  const omitted = (o: Outcome) => o.perSkill.filter((e) => !e.kept).length;
  if (omitted(a) !== omitted(b)) return omitted(a) < omitted(b);
  if (a.droppedCount !== b.droppedCount) return a.droppedCount < b.droppedCount;
  return a.used < b.used;
};

const simulateCodex = (agent: Agent, rule: CodexRule, items: readonly ListingItem[], ctx: ListingContext, overrides: BudgetOverrides): BudgetReport => {
  const b = codexBudget(rule, ctx, overrides);
  const cost = (text: string): number => (b.unit === "tokens" ? Math.ceil(utf8Bytes(text) / rule.bytesPerToken) : charCount(text));
  const locators = items.map((s) => s.locator ?? `${s.name}/SKILL.md`);
  const lines = (render: (locator: string) => string): CodexLine[] =>
    items.map((s, i) => {
      const desc = capDescription(s.listing, rule.maxDescChars);
      const loc = render(locators[i] ?? "");
      const label = s.label ?? s.name;
      return { name: s.name, chars: charCount(s.listing), cappedChars: charCount(desc), entryChars: cost(codexLine(label, desc, loc)), minCost: cost(codexLine(label, "", loc)) };
    });
  const absolute: Variant = { overhead: 0, lines: lines((l) => l), rootsText: "" };
  // aliased variant: `### Skill roots` table + `rN/...` locators, kept only when it beats the absolute rendering
  const plan = aliasPlan(sharedAliasRoots(locators.map((l) => dirname(dirname(l)))));
  const rootLines = plan.map((a) => `- \`${a.name}\` = \`${a.value}\`\n`).join("");
  const overhead = Math.max(0, cost(`${"x".repeat(CODEX_INTRO_BYTES.aliased)}\n### Skill roots\n${rootLines}`) - cost(`${"x".repeat(CODEX_INTRO_BYTES.unaliased)}\n`));
  const aliased: Variant | undefined = plan.length === 0 || overhead >= b.limit ? undefined : { overhead, lines: lines((l) => shorten(plan, l)), rootsText: `${plan.length} skill root${plan.length === 1 ? "" : "s"} aliased (${plan.map((a) => a.name).join(" ")})` };
  const abs = allocate(absolute, b.limit);
  const ali = aliased === undefined ? undefined : allocate(aliased, b.limit);
  const [chosen, variant] = ali !== undefined && aliased !== undefined && better(ali, abs) ? [ali, aliased] : [abs, absolute];
  const costText = b.unit === "tokens" ? `⌈bytes/${rule.bytesPerToken}⌉ tokens` : "its chars";
  const note = `Codex: listing budget = ${b.how} = ${b.limit} ${b.unit}; each line "- name: description (file: path)" costs ${costText}${variant.rootsText === "" ? "" : `; ${variant.rootsText}, roots table costs ${variant.overhead} ${b.unit}`}; descriptions capped at ${rule.maxDescChars} chars; over budget → every description is shortened round-robin (all skills stay listed); skills are omitted only when even empty descriptions do not fit`;
  return {
    agentId: agent.id,
    context: ctx,
    unit: b.unit,
    budgetChars: b.limit,
    usedChars: chosen.used,
    perSkill: chosen.perSkill,
    trim: chosen.trim,
    droppedCount: chosen.droppedCount,
    overBy: Math.max(0, chosen.used - b.limit),
    note,
  };
};

// ---------- entry points ----------

/** Convenience over `simulateListingOf` for store skills. */
export const simulateListing = (agent: Agent, skills: readonly Skill[], ctx: ListingContext, overrides: BudgetOverrides = {}): BudgetReport =>
  simulateListingOf(agent, listingItems(skills), ctx, overrides);

/** Simulate what an agent keeps at startup from any set of (name, listing text[, locator]) items — store skills, plugin skills, builtins alike. */
export const simulateListingOf = (agent: Agent, items: readonly ListingItem[], ctx: ListingContext, overrides: BudgetOverrides = {}): BudgetReport => {
  const rule = agent.listing;
  return rule.kind === "codex" ? simulateCodex(agent, rule, items, ctx, overrides) : simulateChars(agent, rule, items, ctx, overrides);
};
