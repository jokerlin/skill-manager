import { describe, expect, test } from "bun:test";
import { agentById } from "../src/core/agents";
import { type Inventory, emptyInventory } from "../src/core/inventory";
import { buildHostView } from "../src/core/view";

const agent = (id: string) => { const a = agentById(id); if (!a.some) throw new Error(id); return a.value; };
const md = (n: string, desc: string) => `---\nname: ${n}\ndescription: ${desc}\n---\nbody\n`;

const base: Inventory = {
  ...emptyInventory("/h"),
  agentDirs: { claude: { exists: true, entries: [{ kind: "dir", name: "alpha", hash: "H-a" }] }, codex: { exists: true, entries: [{ kind: "dir", name: "alpha", hash: "H-a" }] } },
  docs: { "H-a": md("alpha", "x".repeat(100)) },
};
const withSettings = (settings: unknown): Inventory => ({ ...base, files: { "claude-settings": JSON.stringify(settings) } });

describe("buildHostView budget", () => {
  test("claude budget follows the host's model: fable → 1M × 3 × 1% = 30,000 chars", () => {
    const v = buildHostView("h", [agent("claude"), agent("codex")], withSettings({ model: "fable" }), 200_000);
    expect(v.budget["claude"]?.budgetChars).toBe(30_000);
    expect(v.budget["claude"]?.note).toContain("1M");
    expect(v.budget["codex"]?.budgetChars).toBe(4_000);
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
