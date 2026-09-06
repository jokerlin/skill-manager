import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  highestVersion,
  ownerOf,
  parseAgentsLock,
  parseAcmeLock,
  parseClaudeInstalled,
  parseClaudeMarketplaces,
  parseClaudeSettings,
  parseCodexConfig,
} from "../src/core/sources";

describe("claude files", () => {
  test("settings.json enabledPlugins + overrides", () => {
    const r = parseClaudeSettings(JSON.stringify({ enabledPlugins: { "superpowers@claude-plugins-official": true, "x@y": false, "bad@z": "yes" }, skillListingBudgetFraction: 0.02 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.enabledPlugins).toEqual({ "superpowers@claude-plugins-official": true, "x@y": false });
    expect(r.value.fraction).toBe(0.02);
    expect(r.value.maxDescChars).toBeUndefined();
  });
  test("settings.json without enabledPlugins", () => {
    const r = parseClaudeSettings("{}");
    expect(r.ok && r.value.enabledPlugins).toEqual({});
    expect(parseClaudeSettings("{nope").ok).toBe(false);
  });
  test("installed_plugins.json v2 shape", () => {
    const r = parseClaudeInstalled(JSON.stringify({ version: 2, plugins: { "superpowers@claude-plugins-official": [{ scope: "user", installPath: "/h/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0", version: "6.3.0" }], broken: [{}] } }));
    expect(r.ok && r.value).toEqual({ "superpowers@claude-plugins-official": { version: "6.3.0", installPath: "/h/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0" } });
  });
  test("known_marketplaces.json sources", () => {
    const r = parseClaudeMarketplaces(JSON.stringify({ "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official" } }, local: { source: { source: "directory", path: "/tmp/mk" } }, junk: 1 }));
    expect(r.ok && r.value).toEqual({ "claude-plugins-official": "anthropics/claude-plugins-official", local: "/tmp/mk" });
  });
});

describe("codex config.toml", () => {
  const toml = `
model = "gpt-6"
[features]
plugins = true
[marketplaces.claude-plugins-official]
source_type = "git"
source = "https://github.com/anthropics/claude-plugins-official.git"
[plugins."superpowers@claude-plugins-official"]
enabled = true
[plugins."documents@openai-primary-runtime"]
enabled = false
[plugins."implicit@x"]
mcp_servers = {}
`;
  test("plugins and marketplaces", () => {
    const r = parseCodexConfig(toml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.plugins).toEqual({ "superpowers@claude-plugins-official": true, "documents@openai-primary-runtime": false, "implicit@x": true });
    expect(r.value.marketplaces).toEqual({ "claude-plugins-official": "https://github.com/anthropics/claude-plugins-official.git" });
    expect(r.value.pluginsFeature).toBe(true);
  });
  test("bad toml is an error, empty toml is fine", () => {
    expect(parseCodexConfig("a = ").ok).toBe(false);
    const r = parseCodexConfig("");
    expect(r.ok && r.value.plugins).toEqual({});
  });
});

describe("locks", () => {
  test("acme lock", () => {
    const r = parseAcmeLock(JSON.stringify({ version: 1, global: { skills: { acme: { source: "builtin", acmeVersion: "0.144.0" } } } }));
    expect(r.ok && r.value).toEqual({ acme: "0.144.0" });
  });
  test("agents lock", () => {
    const r = parseAgentsLock(JSON.stringify({ version: 3, skills: { "orca-cli": { source: "stablyai/orca" } } }));
    expect(r.ok && r.value).toEqual({ "orca-cli": "stablyai/orca" });
  });
});

describe("versions + owners", () => {
  test("numeric beats labels; numeric compares per segment", () => {
    expect(["1.7.0", "1.8.0", "latest", "unknown", "0120fb83da5d"].sort(compareVersions).at(-1)).toBe("1.8.0");
    expect(compareVersions("26.901.41600", "26.904.11930")).toBeLessThan(0);
    expect(compareVersions("6.3.0", "6.3")).toBe(0);
    expect(highestVersion([])).toBeUndefined();
  });
  test("ownerOf", () => {
    const locks = { acme: new Set(["acme"]), skillsCli: new Set(["orca-cli"]) };
    expect(ownerOf("claude", { kind: "store-link", direct: true }, "x", locks)).toBe("skm");
    expect(ownerOf("claude", { kind: "real-dir" }, "acme", locks)).toBe("acme");
    expect(ownerOf("codex", { kind: "real-dir" }, "orca-cli", locks)).toBe("skills-cli");
    expect(ownerOf("codex", { kind: "real-dir" }, "other", locks)).toBe("manual");
    expect(ownerOf("codex", { kind: "plugin-cache" }, "brainstorming", locks)).toBe("codex-plugins");
    expect(ownerOf("claude", { kind: "plugin-cache" }, "brainstorming", locks)).toBe("claude-plugins");
    expect(ownerOf("codex", { kind: "builtin" }, "imagegen", locks)).toBe("codex-builtin");
  });
});
