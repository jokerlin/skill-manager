import { describe, expect, test } from "bun:test";
import { AGENTS, agentById } from "../src/core/agents";
import { simulateListing } from "../src/core/budget";
import { buildSkill } from "../src/core/skill";

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
  test("claude budget = context tokens × chars-per-token × 1% (Claude Code formula)", () => {
    expect(simulateListing(claude, [mk("a", 100)], ctx(200_000, 4)).budgetChars).toBe(8000);
    expect(simulateListing(claude, [mk("a", 100)], ctx(1_000_000, 3)).budgetChars).toBe(30_000);
  });
  test("claude listing chars = `- name: desc` per entry, newline-separated", () => {
    const r = simulateListing(claude, [mk("a", 100)], ctx(200_000, 4));
    expect(r.usedChars).toBe(1 + 4 + 100);
    expect(r.droppedCount).toBe(0);
    expect(r.overBy).toBe(0);
    expect(simulateListing(claude, [mk("a", 100), mk("bb", 50)], ctx(200_000, 4)).usedChars).toBe((1 + 4 + 100) + 1 + (2 + 4 + 50));
  });
  test("fixedChars (SLASH_COMMAND_TOOL_CHAR_BUDGET) overrides the formula", () => {
    expect(simulateListing(claude, [mk("a", 100)], ctx(1_000_000, 3), { fixedChars: 2000 }).budgetChars).toBe(2000);
  });
  test("claude drops largest descriptions when over budget", () => {
    const r = simulateListing(claude, [mk("a", 900), mk("b", 900), mk("c", 900)], ctx(200_000, 4), { fixedChars: 2000 });
    expect(r.usedChars).toBeGreaterThan(2000);
    expect(r.droppedCount).toBe(1);
    expect(r.perSkill.filter((p) => p.kept).map((p) => p.name).sort()).toEqual(["a", "b"]);
  });
  test("claude per-skill cap 1536", () => {
    const r = simulateListing(claude, [mk("big", 2000)], ctx(1_000_000, 3));
    expect(r.perSkill[0]?.cappedChars).toBe(1536);
    expect(r.perSkill[0]?.chars).toBe(2000);
    expect(r.usedChars).toBe(3 + 4 + 1536);
  });
  test("overrides from settings", () => {
    const r = simulateListing(claude, [mk("a", 100)], ctx(200_000, 4), { fraction: 0.02, maxDescChars: 50 });
    expect(r.budgetChars).toBe(16_000);
    expect(r.perSkill[0]?.cappedChars).toBe(50);
    expect(r.usedChars).toBe(1 + 4 + 50);
  });
  test("codex budget 2% of context as chars, chars-per-token ignored", () => {
    const r = simulateListing(codex, [mk("a", 100)], ctx(200_000, 4));
    expect(r.budgetChars).toBe(4000);
    expect(r.usedChars).toBe(100);
  });
});
