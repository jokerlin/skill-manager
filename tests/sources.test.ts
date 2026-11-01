import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  highestVersion,
  ownerOf,
  lockVersion,
  parseAgentsLock,
  parseClaudeInstalled,
  parseClaudeMarketplaces,
  parseClaudeSettings,
  parseCodexConfig,
  parseCodexModels,
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
  test("settings.json model + env drive the listing window", () => {
    const r = parseClaudeSettings(JSON.stringify({ model: "fable", env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1", SLASH_COMMAND_TOOL_CHAR_BUDGET: "2000", OTHER: "x" } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.model).toEqual({ some: true, value: "fable" });
    expect(r.value.disable1m).toBe(true);
    expect(r.value.fixedChars).toBe(2000);
    const off = parseClaudeSettings(JSON.stringify({ env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "0", SLASH_COMMAND_TOOL_CHAR_BUDGET: "nope" } }));
    expect(off.ok && off.value.model.some).toBe(false);
    expect(off.ok && off.value.disable1m).toBe(false);
    expect(off.ok && off.value.fixedChars).toBeUndefined();
  });
  test("settings.json without enabledPlugins", () => {
    const r = parseClaudeSettings("{}");
    expect(r.ok && r.value.enabledPlugins).toEqual({});
    expect(parseClaudeSettings("{nope").ok).toBe(false);
  });
  test("installed_plugins.json v2 shape", () => {
    const r = parseClaudeInstalled(JSON.stringify({ version: 2, plugins: { "superpowers@claude-plugins-official": [{ scope: "user", installPath: "/h/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0", version: "6.3.0" }], broken: [{}] } }));
    expect(r.ok && r.value).toEqual({ "superpowers@claude-plugins-official": { version: "6.3.0", installPath: "/h/.claude/plugins/cache/claude-plugins-official/superpowers/6.3.0", installs: [{ scope: "user", projectPath: { some: false }, version: "6.3.0" }] } });
  });
  test("known_marketplaces.json sources", () => {
    const r = parseClaudeMarketplaces(JSON.stringify({ "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official" } }, local: { source: { source: "directory", path: "/tmp/mk" } }, junk: 1 }));
    expect(r.ok && r.value).toEqual({ "claude-plugins-official": { kind: "portable", source: "anthropics/claude-plugins-official" }, local: { kind: "local-dir", path: "/tmp/mk" } });
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
[marketplaces.openai-primary-runtime]
source_type = "local"
source = "/Users/me/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime"
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
    expect(r.value.marketplaces).toEqual({
      "claude-plugins-official": { kind: "portable", source: "https://github.com/anthropics/claude-plugins-official.git" },
      "openai-primary-runtime": { kind: "local-dir", path: "/Users/me/.cache/codex-runtimes/codex-primary-runtime/plugins/openai-primary-runtime" },
    });
    expect(r.value.pluginsFeature).toBe(true);
    expect(r.value.model).toEqual({ some: true, value: "gpt-6" });
    expect(r.value.skillsMaxContextTokens.some).toBe(false);
  });
  test("config.toml model and [skills] max_context_tokens feed the Codex listing budget", () => {
    const r = parseCodexConfig('model = "gpt-6-astra"\n\n[skills]\nmax_context_tokens = 3000\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.model).toEqual({ some: true, value: "gpt-6-astra" });
    expect(r.value.skillsMaxContextTokens).toEqual({ some: true, value: 3000 });
    const bad = parseCodexConfig('[skills]\nmax_context_tokens = -5\n');
    expect(bad.ok && bad.value.skillsMaxContextTokens.some).toBe(false);
    const win = parseCodexConfig("model_context_window = 400000\n");
    expect(win.ok && win.value.modelContextWindow).toEqual({ some: true, value: 400000 });
  });
  test("models_cache.json → slug → context windows", () => {
    const r = parseCodexModels(JSON.stringify({ fetched_at: 1, models: [{ slug: "gpt-6-astra", context_window: 272000, max_context_window: 872000, priority: 1, visibility: "list" }, { slug: "odd", context_window: "x", visibility: "hide" }, { nope: true }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value["gpt-6-astra"]).toEqual({ contextWindow: { some: true, value: 272000 }, maxContextWindow: { some: true, value: 872000 }, priority: { some: true, value: 1 }, listed: true });
    expect(r.value["odd"]?.contextWindow.some).toBe(false);
    expect(r.value["odd"]).toMatchObject({ priority: { some: false }, listed: false });
    expect(Object.keys(r.value)).toEqual(["gpt-6-astra", "odd"]);
    expect(parseCodexModels("{}").ok).toBe(false);
  });
  test("bad toml is an error, empty toml is fine", () => {
    expect(parseCodexConfig("a = ").ok).toBe(false);
    const r = parseCodexConfig("");
    expect(r.ok && r.value.plugins).toEqual({});
  });
});

describe("locks", () => {
  test("owned lock: dotted key path with {skill}; absent or non-string keys give \"\"", () => {
    const text = JSON.stringify({ version: 1, global: { skills: { acme: { source: "builtin", acmeVersion: "0.144.0" }, odd: { acmeVersion: 3 } } } });
    const at = (skill: string) => lockVersion(text, "lock.json", "global.skills.{skill}.acmeVersion", skill);
    expect(at("acme")).toEqual({ ok: true, value: "0.144.0" });
    expect(at("missing")).toEqual({ ok: true, value: "" });
    expect(at("odd")).toEqual({ ok: true, value: "" });
    expect(lockVersion("{", "lock.json", "a", "s").ok).toBe(false);
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
    const locks = { owned: { acme: "acme" }, skillsCli: new Set(["orca-cli"]) };
    expect(ownerOf("claude", { kind: "store-link", direct: true }, "x", locks)).toBe("skm");
    expect(ownerOf("claude", { kind: "real-dir" }, "acme", locks)).toBe("acme");
    expect(ownerOf("codex", { kind: "real-dir" }, "orca-cli", locks)).toBe("skills-cli");
    expect(ownerOf("codex", { kind: "real-dir" }, "other", locks)).toBe("manual");
    expect(ownerOf("codex", { kind: "plugin-cache" }, "brainstorming", locks)).toBe("codex-plugins");
    expect(ownerOf("claude", { kind: "plugin-cache" }, "brainstorming", locks)).toBe("claude-plugins");
    expect(ownerOf("codex", { kind: "builtin" }, "imagegen", locks)).toBe("codex-builtin");
  });
});
