import { type Skill, bodyOf, descriptionOf, listingOf } from "./skill";

export type Insight = {
  readonly skill: string;
  readonly kind: "duplicate" | "short-description" | "no-trigger" | "oversize-body" | "desc-over-cap" | "spec-violation" | "empty-body";
  readonly detail: string;
  readonly related: readonly string[];
};

const TRIGGER_RE = /\b(use when|when (the )?user|trigger|invoke|使用|当用户|适用|用于|时使用)/i;

export const lintSkill = (s: Skill): Insight[] => {
  const desc = descriptionOf(s);
  return [
    ...s.violations.map((v): Insight => ({ skill: s.name, kind: "spec-violation", detail: `${v.field} ${v.kind}: ${v.detail}`, related: [] })),
    ...(desc.length > 0 && desc.length < 40 ? [{ skill: s.name, kind: "short-description", detail: `description is ${desc.length} chars; agents pick skills by description`, related: [] } as const] : []),
    ...(desc.length >= 40 && !TRIGGER_RE.test(desc) ? [{ skill: s.name, kind: "no-trigger", detail: "description says what, not when — add a 'Use when …' clause", related: [] } as const] : []),
    ...(s.cost.bodyTokens > 5000 || s.cost.bodyLines > 500 ? [{ skill: s.name, kind: "oversize-body", detail: `body ${s.cost.bodyTokens} tokens / ${s.cost.bodyLines} lines; spec suggests <5000 tokens, <500 lines — move detail to references/`, related: [] } as const] : []),
    ...(listingOf(s).length > 1536 ? [{ skill: s.name, kind: "desc-over-cap", detail: `listing text ${listingOf(s).length} chars > Claude's 1536 cap — the tail is never shown`, related: [] } as const] : []),
    ...(s.parsed.ok && bodyOf(s).trim().length === 0 ? [{ skill: s.name, kind: "empty-body", detail: "SKILL.md has no instructions after the frontmatter", related: [] } as const] : []),
  ];
};

/** Word tokens for Latin text plus character bigrams for CJK, lowercased. */
export const shingles = (text: string): Set<string> => {
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z0-9_-]{2,}/g) ?? [];
  const cjk = lower.match(/[㐀-鿿]/g) ?? [];
  const bigrams = cjk.slice(0, -1).map((c, i) => c + cjk[i + 1]);
  return new Set([...words, ...bigrams]);
};

export const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 0;
  const inter = [...a].filter((x) => b.has(x)).length;
  return inter / (a.size + b.size - inter);
};

/** Pairs of skills whose descriptions overlap heavily. One insight per skill listing its lookalikes. */
export const findDuplicates = (skills: readonly Skill[], threshold = 0.5): Insight[] => {
  const sets = skills.map((s) => ({ name: s.name, set: shingles(descriptionOf(s)) }));
  return sets.flatMap((a) => {
    const near = sets
      .filter((b) => b.name !== a.name)
      .map((b) => ({ name: b.name, sim: jaccard(a.set, b.set) }))
      .filter((x) => x.sim >= threshold)
      .sort((x, y) => y.sim - x.sim);
    return near.length === 0
      ? []
      : [{ skill: a.name, kind: "duplicate" as const, detail: `description overlaps ${near.map((n) => `${n.name} (${Math.round(n.sim * 100)}%)`).join(", ")}`, related: near.map((n) => n.name) }];
  });
};

export const allInsights = (skills: readonly Skill[]): Insight[] => [...skills.flatMap(lintSkill), ...findDuplicates(skills)];
