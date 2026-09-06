import { describe, expect, test } from "bun:test";
import { agentById } from "../src/core/agents";
import { type Inventory, emptyInventory } from "../src/core/inventory";
import { buildHostView, listingItemFor } from "../src/core/view";
import type { Effective } from "../src/core/effective";
import { none } from "../src/lib/result";

const agent = (id: string) => { const a = agentById(id); if (!a.some) throw new Error(id); return a.value; };
const md = (n: string, desc: string) => `---\nname: ${n}\ndescription: ${desc}\n---\nbody\n`;

const base: Inventory = {
  ...emptyInventory("/h"),
  agentDirs: { claude: { exists: true, entries: [{ kind: "dir", name: "alpha", hash: "H-a" }] }, codex: { exists: true, entries: [{ kind: "dir", name: "alpha", hash: "H-a" }] } },
  docs: { "H-a": md("alpha", "x".repeat(100)) },
};
const withSettings = (settings: unknown): Inventory => ({ ...base, files: { "claude-settings": JSON.stringify(settings) } });

describe("listingItemFor", () => {
  const eff: Effective = { agent: "codex", name: "brainstorming", source: { kind: "plugin", marketplace: "mk", plugin: "superpowers", version: "6.3.0" }, storage: { kind: "plugin-cache" }, owner: "codex-plugins", path: "/h/.codex/plugins/cache/mk/superpowers/6.3.0/skills/brainstorming", version: none, enabled: "on", listing: "desc. when to use", description: "desc.", listingChars: 17, bodyTokens: 10, hash: "H" };
  test("plugin skills are labelled plugin:skill; Codex lists the description alone, Claude the full listing", () => {
    expect(listingItemFor(agent("codex"), eff)).toEqual({ name: "brainstorming", label: "superpowers:brainstorming", listing: "desc.", locator: "/h/.codex/plugins/cache/mk/superpowers/6.3.0/skills/brainstorming/SKILL.md" });
    expect(listingItemFor(agent("claude"), { ...eff, agent: "claude" }).listing).toBe("desc. when to use");
    expect(listingItemFor(agent("claude"), { ...eff, source: { kind: "user" } }).label).toBe("brainstorming");
  });
});

describe("buildHostView budget", () => {
  test("claude budget follows the host's model: fable → 1M × 3 × 1% = 30,000 chars", () => {
    const v = buildHostView("h", [agent("claude"), agent("codex")], withSettings({ model: "fable" }), 200_000);
    expect(v.budget["claude"]?.budgetChars).toBe(30_000);
    expect(v.budget["claude"]?.note).toContain("1M");
    expect(v.budget["codex"]).toMatchObject({ budgetChars: 4_000, unit: "tokens", trim: "shortened" });
  });
  test("codex budgets in tokens: 2% of config contextTokens, or [skills] max_context_tokens from config.toml; the model is named in the reason", () => {
    const inv: Inventory = { ...base, files: { "codex-config": 'model = "gpt-6-astra"\n[skills]\nmax_context_tokens = 3000\n' } };
    const v = buildHostView("h", [agent("codex")], inv, 200_000);
    expect(v.budget["codex"]).toMatchObject({ budgetChars: 3000, unit: "tokens" });
    expect(v.budget["codex"]?.context.reason).toContain("gpt-6-astra");
    expect(v.budget["codex"]?.context.bytesPerToken).toBe(4);
    const cached: Inventory = { ...base, files: { "codex-config": 'model = "gpt-6-astra"\n', "codex-models": JSON.stringify({ models: [{ slug: "gpt-6-astra", context_window: 272000, max_context_window: 872000 }] }) } };
    const real = buildHostView("h", [agent("codex")], cached, 200_000);
    expect(real.budget["codex"]).toMatchObject({ budgetChars: 5440, unit: "tokens" });
    expect(real.budget["codex"]?.context).toMatchObject({ contextTokens: 272_000, bytesPerToken: 4 });
    expect(real.budget["codex"]?.context.reason).toContain("models_cache.json");
    const plain = buildHostView("h", [agent("codex")], base, 200_000);
    // one skill under ~/.agents/skills → aliased as r0 (the shorter aliased intro absorbs the one-line roots table)
    expect(plain.budget["codex"]?.usedChars).toBe(Math.ceil(new TextEncoder().encode(`- alpha: ${"x".repeat(100)} (file: r0/alpha/SKILL.md)\n`).length / 4));
  });
  test("no model in settings.json → config contextTokens as the fallback window, 3 chars per token", () => {
    const v = buildHostView("h", [agent("claude")], withSettings({}), 200_000);
    expect(v.budget["claude"]?.budgetChars).toBe(6_000);
    expect(v.budget["claude"]?.note).toContain("contextTokens");
  });
  test("host env SLASH_COMMAND_TOOL_CHAR_BUDGET fixes the budget; DISABLE_1M holds the window", () => {
    const fixed = buildHostView("h", [agent("claude")], withSettings({ model: "fable", env: { SLASH_COMMAND_TOOL_CHAR_BUDGET: "2000" } }), 200_000);
    expect(fixed.budget["claude"]?.budgetChars).toBe(2000);
    const held = buildHostView("h", [agent("claude")], withSettings({ model: "fable", env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" } }), 200_000);
    expect(held.budget["claude"]?.budgetChars).toBe(6_000);
  });
  test("listing chars count Claude Code's `- name: description` entry format", () => {
    const v = buildHostView("h", [agent("claude")], withSettings({ model: "fable" }), 200_000);
    expect(v.budget["claude"]?.usedChars).toBe("alpha".length + 4 + 100);
  });
});
