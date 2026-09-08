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
  const eff: Effective = { agent: "codex", name: "brainstorming", source: { kind: "plugin", marketplace: "mk", plugin: "superpowers", version: "6.3.0" }, storage: { kind: "plugin-cache" }, owner: "codex-plugins", path: "/h/.codex/plugins/cache/mk/superpowers/6.3.0/skills/brainstorming", version: none, enabled: "on", promptVisible: true, listing: "desc. when to use", description: "desc.", listingChars: 17, listingTokens: 5, bodyTokens: 10, hash: "H" };
  test("plugin skills are labelled plugin:skill; Codex lists the description alone, Claude the full listing", () => {
    expect(listingItemFor(agent("codex"), eff)).toEqual({ name: "brainstorming", label: "superpowers:brainstorming", listing: "desc.", locator: "/h/.codex/plugins/cache/mk/superpowers/6.3.0/skills/brainstorming/SKILL.md" });
    expect(listingItemFor(agent("claude"), { ...eff, agent: "claude" }).listing).toBe("desc. when to use");
    expect(listingItemFor(agent("claude"), { ...eff, source: { kind: "user" } }).label).toBe("brainstorming");
  });
});

describe("buildHostView budget", () => {
  test("claude budget follows the host's model: fable → 1M × 1% = 10,000 tokens (30,000 chars at 3 chars/token)", () => {
    const v = buildHostView("h", [agent("claude"), agent("codex")], withSettings({ model: "fable" }), 200_000);
    expect(v.budget["claude"]?.budgetTokens).toBe(10_000);
    expect(v.budget["claude"]?.note).toContain("1M");
    expect(v.budget["claude"]?.note).toContain("30000 chars at 3 chars/token");
    expect(v.budget["codex"]).toMatchObject({ budgetTokens: 4_000, trim: "shortened" });
  });
  test("codex budgets in tokens: 2% of config contextTokens, or [skills] max_context_tokens from config.toml; the model is named in the reason", () => {
    const inv: Inventory = { ...base, files: { "codex-config": 'model = "gpt-6-astra"\n[skills]\nmax_context_tokens = 3000\n' } };
    const v = buildHostView("h", [agent("codex")], inv, 200_000);
    expect(v.budget["codex"]).toMatchObject({ budgetTokens: 3000 });
    expect(v.budget["codex"]?.context.reason).toContain("gpt-6-astra");
    expect(v.budget["codex"]?.context.bytesPerToken).toBe(4);
    const cached: Inventory = { ...base, files: { "codex-config": 'model = "gpt-6-astra"\n', "codex-models": JSON.stringify({ models: [{ slug: "gpt-6-astra", context_window: 272000, max_context_window: 872000 }] }) } };
    const real = buildHostView("h", [agent("codex")], cached, 200_000);
    expect(real.budget["codex"]).toMatchObject({ budgetTokens: 5440 });
    expect(real.budget["codex"]?.context).toMatchObject({ contextTokens: 272_000, bytesPerToken: 4 });
    expect(real.budget["codex"]?.context.reason).toContain("Codex model catalog");
    // no `model` in config.toml (home-mini): Codex runs the catalog's first listed preset, so skm budgets against that window instead of the config fallback
    const defaulted: Inventory = { ...base, files: { "codex-config": "", "codex-models": JSON.stringify({ models: [{ slug: "gpt-6-astra", context_window: 272000, max_context_window: 872000, priority: 1, visibility: "list" }, { slug: "gpt-5.5", context_window: 272000, max_context_window: 272000, priority: 12, visibility: "list" }] }) } };
    const byDefault = buildHostView("h", [agent("codex")], defaulted, 1_000_000);
    expect(byDefault.budget["codex"]).toMatchObject({ budgetTokens: 5440 });
    expect(byDefault.budget["codex"]?.context.reason).toContain("no model in config.toml → Codex default gpt-6-astra");
    const plain = buildHostView("h", [agent("codex")], base, 200_000);
    // one skill under ~/.agents/skills → aliased as r0 (the shorter aliased intro absorbs the one-line roots table)
    expect(plain.budget["codex"]?.usedTokens).toBe(Math.ceil(new TextEncoder().encode(`- alpha: ${"x".repeat(100)} (file: r0/alpha/SKILL.md)\n`).length / 4));
  });
  test("no model in settings.json → config contextTokens as the fallback window, 3 chars per token", () => {
    const v = buildHostView("h", [agent("claude")], withSettings({}), 200_000);
    expect(v.budget["claude"]?.budgetTokens).toBe(2_000);
    expect(v.budget["claude"]?.note).toContain("6000 chars at 3 chars/token");
    expect(v.budget["claude"]?.note).toContain("contextTokens");
  });
  test("host env SLASH_COMMAND_TOOL_CHAR_BUDGET fixes the budget; DISABLE_1M holds the window", () => {
    const fixed = buildHostView("h", [agent("claude")], withSettings({ model: "fable", env: { SLASH_COMMAND_TOOL_CHAR_BUDGET: "2000" } }), 200_000);
    expect(fixed.budget["claude"]?.budgetTokens).toBe(Math.ceil(2000 / 3));
    const held = buildHostView("h", [agent("claude")], withSettings({ model: "fable", env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" } }), 200_000);
    expect(held.budget["claude"]?.budgetTokens).toBe(2_000);
  });
  test("skills Codex hides via agents/openai.yaml stay in the effective list but cost nothing", () => {
    const hidden: Inventory = { ...base, hidden: [{ agent: "codex", dir: "/h/.agents/skills/alpha" }] };
    const v = buildHostView("h", [agent("codex"), agent("claude")], hidden, 200_000);
    expect(v.effective["codex"]?.map((e) => [e.name, e.promptVisible])).toEqual([["alpha", false]]);
    expect(v.budget["codex"]?.usedTokens).toBe(0);
    expect(v.budget["claude"]?.usedTokens).toBeGreaterThan(0);
  });
  test("listing tokens count Claude Code's `- name: description` entry format at 3 chars/token", () => {
    const v = buildHostView("h", [agent("claude")], withSettings({ model: "fable" }), 200_000);
    expect(v.budget["claude"]?.usedTokens).toBe(Math.ceil(("alpha".length + 4 + 100) / 3));
  });
  test("pi: a ~/.agents copy shadowed by ~/.pi/agent/skills is not loaded, not budgeted, and surfaces as a `shadowed` finding", () => {
    const inv: Inventory = {
      ...emptyInventory("/h"),
      agentDirs: { pi: { exists: true, entries: [{ kind: "managed", name: "alpha", direct: true, hash: "H-a" }] } },
      alsoReads: { pi: [{ kind: "managed", name: "alpha", direct: true, hash: "H-a" }, { kind: "managed", name: "beta", direct: true, hash: "H-b" }] },
      alsoDirs: { pi: { alpha: "/h/.agents/skills", beta: "/h/.agents/skills" } },
      docs: { "H-a": md("alpha", "x".repeat(100)), "H-b": md("beta", "y".repeat(100)) },
    };
    const v = buildHostView("h", [agent("pi")], inv, 1_000_000);
    expect(v.effective["pi"]?.map((e) => `${e.source.kind}:${e.name}`)).toEqual(["user:alpha", "legacy:beta"]);
    expect(v.counts["pi"]).toEqual({ user: 1, legacy: 1, builtin: 0, plugin: 0 });
    expect(v.budget["pi"]?.perSkill.map((e) => e.name)).toEqual(["alpha", "beta"]);
    expect(v.shadowed["pi"]?.map((x) => x.name)).toEqual(["alpha"]);
    expect(v.findings).toEqual([{ kind: "shadowed", host: "h", agent: "pi", names: ["alpha"], differing: [], winner: "/h/.pi/agent/skills", dir: "/h/.agents/skills" }]);
  });
});
