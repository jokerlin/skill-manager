import { describe, expect, test } from "bun:test";
import { hostFacts, pluginStates } from "../src/core/effective";
import { type Inventory, emptyInventory } from "../src/core/inventory";
import { opText } from "../src/core/plan";
import { pluginRows, pluginUpdateOps } from "../src/core/pluginUpdate";
import { commandsScript } from "../src/core/scripts";

const inv = (version: string, extra: Partial<Inventory> = {}): Inventory => ({
  ...emptyInventory("/h"),
  tools: { claude: "/bin/claude", codex: "/bin/codex" },
  files: {
    "claude-settings": JSON.stringify({ enabledPlugins: { "superpowers@official": true, "off@official": false } }),
    "claude-installed": JSON.stringify({ version: 2, plugins: {
      "superpowers@official": [
        { scope: "user", installPath: `/h/.claude/plugins/cache/official/superpowers/${version}`, version },
        { scope: "project", projectPath: "/data/repo", installPath: "/h/.claude/plugins/cache/official/superpowers/6.0.0", version: "6.0.0" },
      ],
      "off@official": [{ scope: "user", installPath: "/h/.claude/plugins/cache/official/off/1.0.0", version: "1.0.0" }],
    } }),
    "codex-config": [
      '[marketplaces.official]', 'source_type = "git"', 'source = "https://example.com/official.git"',
      '[marketplaces.extras]', 'source_type = "local"', 'source = "/h/.codex/local-marketplaces/extras"',
      '[plugins."superpowers@official"]', 'enabled = true',
      '[plugins."video@extras"]', 'enabled = true',
    ].join("\n"),
  },
  pluginCache: [
    { agent: "claude", marketplace: "official", plugin: "superpowers", version, dir: `/h/.claude/plugins/cache/official/superpowers/${version}` },
    { agent: "claude", marketplace: "official", plugin: "off", version: "1.0.0", dir: "/h/.claude/plugins/cache/official/off/1.0.0" },
    { agent: "codex", marketplace: "official", plugin: "superpowers", version: "6.2.0", dir: "/h/.codex/plugins/cache/official/superpowers/6.2.0" },
    { agent: "codex", marketplace: "extras", plugin: "video", version: "3.0.0", dir: "/h/.codex/plugins/cache/extras/video/3.0.0" },
  ],
  ...extra,
});

const statesOf = (i: Inventory) => { const f = hostFacts(i); return { facts: f, states: { claude: pluginStates(i, f, "claude"), codex: pluginStates(i, f, "codex") } }; };

describe("pluginUpdateOps", () => {
  test("refreshes marketplaces once, updates every Claude scope, re-adds Codex plugins, skips disabled ones", () => {
    const i = inv("6.3.0");
    const { facts, states } = statesOf(i);
    const ops = pluginUpdateOps("devbox", states, facts, i.tools, { plugins: [], agents: [] });
    expect(ops.map(opText)).toEqual([
      "claude: marketplace refresh official",
      "claude: plugin update superpowers@official (6.3.0)",
      "claude: plugin update superpowers@official (6.0.0, project /data/repo)",
      // extras is a local-dir marketplace: Codex reads it live, `upgrade` only refreshes Git ones
      "codex: marketplace refresh official",
      "codex: plugin update superpowers@official (6.2.0)",
      "codex: plugin update video@extras (3.0.0)",
    ]);
    const script = commandsScript(ops);
    expect(script).toContain("run 'claude: plugin update superpowers@official (project)' in_dir '/data/repo' claude plugin update 'superpowers@official' --scope 'project' -y");
    expect(script).toContain("in_dir \"$HOME\" claude plugin update 'superpowers@official' --scope 'user' -y");
    expect(script).toContain("codex plugin marketplace upgrade 'official'");
    expect(script).toContain("codex plugin add 'video@extras'");
  });

  test("filters by plugin name/id and agent; a missing CLI blocks", () => {
    const i = inv("6.3.0", { tools: { claude: "/bin/claude" } });
    const { facts, states } = statesOf(i);
    expect(pluginUpdateOps("h", states, facts, i.tools, { plugins: ["video@extras"], agents: [] }).map(opText)).toEqual(["blocked codex plugin video@extras: codex CLI not found on h"]);
    expect(pluginUpdateOps("h", states, facts, i.tools, { plugins: ["superpowers"], agents: ["claude"] }).map((o) => o.op)).toEqual(["marketplace-refresh", "plugin-update", "plugin-update"]);
    expect(pluginUpdateOps("h", states, facts, i.tools, { plugins: ["nope"], agents: [] })).toEqual([]);
  });
});

describe("pluginRows", () => {
  test("one row per plugin name across hosts × agents, drift when active versions differ", () => {
    const a = inv("6.3.0"), b = inv("6.1.1");
    const rows = pluginRows([{ host: "local", ...statesOf(a) }, { host: "mini", ...statesOf(b) }]);
    const sp = rows.find((r) => r.name === "superpowers");
    expect(sp?.versions).toEqual(["6.1.1", "6.2.0", "6.3.0"]);
    expect(sp?.drift).toBe(true);
    expect(sp?.cells.find((c) => c.host === "local" && c.agent === "claude")?.scopes).toEqual(["user", "project"]);
    const off = rows.find((r) => r.name === "off");
    expect(off?.drift).toBe(false);
    expect(off?.cells[0]?.enabled).toBe("off");
  });
});
