import { describe, expect, test } from "bun:test";
import { AGENTS, agentById } from "../src/core/agents";
import { sharedAliasRoots, simulateListing, simulateListingOf } from "../src/core/budget";
import { buildSkill } from "../src/core/skill";
import { estimateTokens } from "../src/lib/tokens";

const mk = (name: string, descLen: number) =>
  buildSkill(name, `/s/${name}`, `---\nname: ${name}\ndescription: ${"d".repeat(descLen)}\n---\nbody`, [{ rel: "SKILL.md", bytes: 10 }]);

describe("agents registry", () => {
  test("known dirs", () => {
    const claude = agentById("claude");
    const codex = agentById("codex");
    expect(claude.some && claude.value.userDir("/home/u")).toBe("/home/u/.claude/skills");
    expect(codex.some && codex.value.userDir("/home/u")).toBe("/home/u/.agents/skills");
    expect(agentById("nope").some).toBe(false);
    expect(AGENTS.length).toBeGreaterThan(5);
  });
});

describe("simulateListing", () => {
  const claude = (() => { const a = agentById("claude"); if (!a.some) throw new Error(); return a.value; })();
  const codex = (() => { const a = agentById("codex"); if (!a.some) throw new Error(); return a.value; })();
  const ctx = (contextTokens: number, bytesPerToken: number) => ({ contextTokens, bytesPerToken, reason: "test" });
  test("claude budget = context tokens × 1%, reported in tokens (Claude Code counts it as chars at the model's chars/token)", () => {
    const small = simulateListing(claude, [mk("a", 100)], ctx(200_000, 4));
    expect(small.budgetTokens).toBe(2000);
    expect(small.note).toContain("8000 chars at 4 chars/token");
    const big = simulateListing(claude, [mk("a", 100)], ctx(1_000_000, 3));
    expect(big.budgetTokens).toBe(10_000);
    expect(big.note).toContain("30000 chars at 3 chars/token");
  });
  test("claude listing cost = chars of `- name: desc` per entry, newline-separated, ÷ chars/token", () => {
    const r = simulateListing(claude, [mk("a", 100)], ctx(200_000, 4));
    expect(r.usedTokens).toBe(Math.ceil((1 + 4 + 100) / 4));
    expect(r.perSkill[0]?.entryTokens).toBe(Math.ceil((1 + 4 + 100) / 4));
    expect(r.droppedCount).toBe(0);
    expect(r.overBy).toBe(0);
    expect(simulateListing(claude, [mk("a", 100), mk("bb", 50)], ctx(200_000, 4)).usedTokens).toBe(Math.ceil(((1 + 4 + 100) + 1 + (2 + 4 + 50)) / 4));
    expect(simulateListing(claude, [mk("a", 100)], ctx(1_000_000, 3)).usedTokens).toBe(Math.ceil((1 + 4 + 100) / 3));
  });
  test("fixedChars (SLASH_COMMAND_TOOL_CHAR_BUDGET) overrides the formula", () => {
    const r = simulateListing(claude, [mk("a", 100)], ctx(1_000_000, 3), { fixedChars: 2000 });
    expect(r.budgetTokens).toBe(Math.ceil(2000 / 3));
    expect(r.note).toContain("fixed at 2000 chars");
  });
  test("claude drops largest descriptions when over budget; overBy is in tokens", () => {
    const r = simulateListing(claude, [mk("a", 900), mk("b", 900), mk("c", 900)], ctx(200_000, 4), { fixedChars: 2000 });
    expect(r.usedTokens).toBeGreaterThan(r.budgetTokens);
    expect(r.overBy).toBe(Math.ceil((3 * (1 + 4 + 900) + 2 - 2000) / 4));
    expect(r.droppedCount).toBe(1);
    expect(r.perSkill.filter((p) => p.kept).map((p) => p.name).sort()).toEqual(["a", "b"]);
  });
  test("claude per-skill cap 1536", () => {
    const r = simulateListing(claude, [mk("big", 2000)], ctx(1_000_000, 3));
    expect(r.perSkill[0]?.cappedChars).toBe(1536);
    expect(r.perSkill[0]?.chars).toBe(2000);
    expect(r.usedTokens).toBe(Math.ceil((3 + 4 + 1536) / 3));
  });
  test("overrides from settings", () => {
    const r = simulateListing(claude, [mk("a", 100)], ctx(200_000, 4), { fraction: 0.02, maxDescChars: 50 });
    expect(r.budgetTokens).toBe(4000);
    expect(r.perSkill[0]?.cappedChars).toBe(50);
    expect(r.usedTokens).toBe(Math.ceil((1 + 4 + 50) / 4));
  });
  test("agents without a documented budget: no limit, tokens are an o200k estimate of each description", () => {
    const pi = (() => { const a = agentById("pi"); if (!a.some) throw new Error(); return a.value; })();
    const r = simulateListingOf(pi, [{ name: "a", listing: "Does demo things. Use when demoing." }, { name: "b", listing: "" }], ctx(1_000_000, 1));
    expect(r.budgetTokens).toBe(Number.POSITIVE_INFINITY);
    expect(r.perSkill.map((e) => e.entryTokens)).toEqual([estimateTokens("Does demo things. Use when demoing."), 0]);
    expect(r.usedTokens).toBe(estimateTokens("Does demo things. Use when demoing."));
    expect(r.overBy).toBe(0);
    expect(r.note).toContain("no documented listing budget");
  });
  describe("codex (codex-rs/ext/skills/src/render.rs)", () => {
    const line = (name: string, desc: string, path: string) => `- ${name}: ${desc} (file: ${path})\n`;
    const tok = (text: string) => Math.ceil(new TextEncoder().encode(text).length / 4);
    test("budget = 2% of the context window in tokens; a line costs ⌈bytes/4⌉ including its locator", () => {
      const r = simulateListingOf(codex, [{ name: "a", listing: "x".repeat(100), locator: "a-SKILL.md" }], ctx(200_000, 4));
      expect(r.budgetTokens).toBe(4000);
      expect(r.usedTokens).toBe(tok(line("a", "x".repeat(100), "a-SKILL.md")));
      expect(r.perSkill[0]?.entryTokens).toBe(tok(line("a", "x".repeat(100), "a-SKILL.md")));
      expect(r.trim).toBe("shortened");
      expect(r.droppedCount).toBe(0);
      expect(r.overBy).toBe(0);
    });
    test("[skills] max_context_tokens fixes the budget, capped at 10,000", () => {
      expect(simulateListingOf(codex, [], ctx(200_000, 4), { fixedTokens: 3000 }).budgetTokens).toBe(3000);
      const capped = simulateListingOf(codex, [], ctx(200_000, 4), { fixedTokens: 50_000 });
      expect(capped.budgetTokens).toBe(10_000);
      expect(capped.note).toContain("capped at 10000");
    });
    test("unknown window → 8,000 chars counted in chars, reported ≈ tokens at 4 chars/token", () => {
      const r = simulateListingOf(codex, [{ name: "a", listing: "héllo", locator: "/p" }], ctx(0, 4));
      expect(r.budgetTokens).toBe(2000);
      expect(r.usedTokens).toBe(Math.ceil([...line("a", "héllo", "/p")].length / 4));
      expect(r.note).toContain("8000 chars ≈ 2000 tokens");
    });
    test("descriptions are cut at 1,024 chars with an ellipsis", () => {
      const r = simulateListingOf(codex, [{ name: "a", listing: "x".repeat(2000), locator: "/p" }], ctx(200_000, 4));
      expect(r.perSkill[0]?.chars).toBe(2000);
      expect(r.perSkill[0]?.cappedChars).toBe(1024);
    });
    test("over budget: every skill stays listed and descriptions are shortened", () => {
      const items = ["a", "b", "c"].map((n) => ({ name: n, listing: "x".repeat(400), locator: "/p" }));
      const r = simulateListingOf(codex, items, ctx(200_000, 4), { fixedTokens: 150 });
      expect(r.overBy).toBeGreaterThan(0);
      expect(r.trim).toBe("shortened");
      expect(r.perSkill.every((e) => e.kept)).toBe(true);
      expect(r.droppedCount).toBe(3);
    });
    test("a short description keeps its full text while long ones are shortened", () => {
      const items = [{ name: "s", listing: "x".repeat(8), locator: "/p" }, { name: "l1", listing: "x".repeat(400), locator: "/p" }, { name: "l2", listing: "x".repeat(400), locator: "/p" }];
      const r = simulateListingOf(codex, items, ctx(200_000, 4), { fixedTokens: 100 });
      expect(r.trim).toBe("shortened");
      expect(r.droppedCount).toBe(2);
    });
    test("whole skills are omitted, in listing order, only when even empty descriptions do not fit", () => {
      const locator = "some-long-locator-without-slashes-so-no-alias-root-SKILL.md";
      const items = ["a", "b", "c"].map((n) => ({ name: n, listing: "x".repeat(40), locator }));
      const min = tok(`- a: (file: ${locator})\n`);
      const r = simulateListingOf(codex, items, ctx(200_000, 4), { fixedTokens: min * 2 });
      expect(r.trim).toBe("omitted");
      expect(r.droppedCount).toBe(1);
      expect(r.perSkill.map((e) => e.kept)).toEqual([true, true, false]);
    });
    test("shared alias roots: one per plugin version, the marketplace when a version holds a single skill, user dirs as-is", () => {
      const roots = ["/h/.agents/skills", "/h/.codex/plugins/cache/mk/solo/1.0.0/skills", "/h/.codex/plugins/cache/mk/sp/6.3.0/skills", "/h/.codex/plugins/cache/mk/sp/6.3.0/skills", "/h/.codex/skills/.system"];
      expect(sharedAliasRoots(roots)).toEqual(["/h/.agents/skills", "/h/.codex/plugins/cache/mk", "/h/.codex/plugins/cache/mk/sp/6.3.0/skills", "/h/.codex/plugins/cache/mk/sp/6.3.0/skills", "/h/.codex/skills/.system"]);
    });
    test("locators are shortened to rN/… against a `### Skill roots` table when that is cheaper (as seen in real Codex transcripts)", () => {
      const desc = "d".repeat(60);
      const items = [
        { name: "alpha", listing: desc, locator: "/h/.agents/skills/alpha/SKILL.md" },
        { name: "solo", listing: desc, locator: "/h/.codex/plugins/cache/mk/solo/1.0.0/skills/solo/SKILL.md" },
        { name: "brainstorming", listing: desc, locator: "/h/.codex/plugins/cache/mk/sp/6.3.0/skills/brainstorming/SKILL.md" },
        { name: "writing-plans", listing: desc, locator: "/h/.codex/plugins/cache/mk/sp/6.3.0/skills/writing-plans/SKILL.md" },
      ];
      const r = simulateListingOf(codex, items, ctx(200_000, 4));
      const aliasedLines = [line("alpha", desc, "r0/alpha/SKILL.md"), line("solo", desc, "r1/solo/1.0.0/skills/solo/SKILL.md"), line("brainstorming", desc, "r2/brainstorming/SKILL.md"), line("writing-plans", desc, "r2/writing-plans/SKILL.md")];
      const roots = "- `r0` = `/h/.agents/skills`\n- `r1` = `/h/.codex/plugins/cache/mk`\n- `r2` = `/h/.codex/plugins/cache/mk/sp/6.3.0/skills`\n";
      const overhead = Math.max(0, tok(`${"x".repeat(261)}\n### Skill roots\n${roots}`) - tok(`${"x".repeat(425)}\n`));
      expect(r.usedTokens).toBe(overhead + aliasedLines.reduce((n, l) => n + tok(l), 0));
      expect(r.usedTokens).toBeLessThan(items.reduce((n, i) => n + tok(line(i.name, desc, i.locator)), 0));
      expect(r.note).toContain("3 skill roots aliased (r0 r1 r2)");
    });
  });
});
