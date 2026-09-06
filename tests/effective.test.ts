import { describe, expect, test } from "bun:test";
import { agentById } from "../src/core/agents";
import { driftFindings, effectiveFor, hostFacts, hostFindings, pluginStates, sourceCounts } from "../src/core/effective";
import { type Inventory, emptyInventory } from "../src/core/inventory";

const agent = (id: string) => { const a = agentById(id); if (!a.some) throw new Error(id); return a.value; };
const md = (n: string, desc = `${n} desc. Use when ${n}.`) => `---\nname: ${n}\ndescription: ${desc}\n---\nbody of ${n}\n`;

const inv: Inventory = {
  ...emptyInventory("/h"),
  storeSkills: [{ name: "check", hash: "H-check" }],
  agentDirs: {
    claude: { exists: true, entries: [{ kind: "managed", name: "check", direct: true, hash: "H-check" }, { kind: "dir", name: "acme", hash: "H-acme" }, { kind: "broken-link", name: "gone", target: "/x" }, { kind: "file", name: ".DS_Store" }] },
    codex: { exists: true, entries: [{ kind: "managed", name: "check", direct: true, hash: "H-check" }, { kind: "dir", name: "orca-cli", hash: "H-orca" }] },
  },
  alsoReads: { codex: [{ kind: "dir", name: "check", hash: "H-check" }] },
  alsoDirs: { codex: { check: "/h/.codex/skills" } },
  tools: { claude: "/h/.local/bin/claude", codex: "/h/.local/bin/codex" },
  files: {
    "claude-settings": JSON.stringify({ enabledPlugins: { "superpowers@mk": true, "video@mk": false } }),
    "claude-installed": JSON.stringify({ version: 2, plugins: { "superpowers@mk": [{ installPath: "/h/.claude/plugins/cache/mk/superpowers/6.3.0", version: "6.3.0" }], "video@mk": [{ installPath: "/h/.claude/plugins/cache/mk/video/1.0.0", version: "1.0.0" }] } }),
    "codex-config": '[plugins."superpowers@mk"]\nenabled = true\n[plugins."off@mk"]\nenabled = false\n',
    "acme-lock": JSON.stringify({ global: { skills: { acme: { acmeVersion: "0.144.0" } } } }),
    "agents-lock": JSON.stringify({ skills: { "orca-cli": { source: "stablyai/orca" } } }),
  },
  pluginCache: [
    { agent: "claude", marketplace: "mk", plugin: "superpowers", version: "6.2.0", dir: "/h/.claude/plugins/cache/mk/superpowers/6.2.0" },
    { agent: "claude", marketplace: "mk", plugin: "superpowers", version: "6.3.0", dir: "/h/.claude/plugins/cache/mk/superpowers/6.3.0" },
    { agent: "claude", marketplace: "mk", plugin: "video", version: "1.0.0", dir: "/h/.claude/plugins/cache/mk/video/1.0.0" },
    { agent: "codex", marketplace: "mk", plugin: "superpowers", version: "6.2.0", dir: "/h/.codex/plugins/cache/mk/superpowers/6.2.0" },
    { agent: "codex", marketplace: "mk", plugin: "implicit", version: "1.0.0", dir: "/h/.codex/plugins/cache/mk/implicit/1.0.0" },
  ],
  pluginSkills: [
    { agent: "claude", marketplace: "mk", plugin: "superpowers", version: "6.3.0", dir: "/h/.claude/plugins/cache/mk/superpowers/6.3.0", name: "brainstorming", skillDir: "/h/.claude/plugins/cache/mk/superpowers/6.3.0/skills/brainstorming", hash: "H-brain" },
    { agent: "claude", marketplace: "mk", plugin: "superpowers", version: "6.2.0", dir: "/h/.claude/plugins/cache/mk/superpowers/6.2.0", name: "brainstorming", skillDir: "/h/.claude/plugins/cache/mk/superpowers/6.2.0/skills/brainstorming", hash: "H-brain-old" },
    { agent: "claude", marketplace: "mk", plugin: "video", version: "1.0.0", dir: "/h/.claude/plugins/cache/mk/video/1.0.0", name: "video", skillDir: "/h/.claude/plugins/cache/mk/video/1.0.0/skills/video", hash: "H-video" },
    { agent: "codex", marketplace: "mk", plugin: "superpowers", version: "6.2.0", dir: "/h/.codex/plugins/cache/mk/superpowers/6.2.0", name: "brainstorming", skillDir: "/h/.codex/plugins/cache/mk/superpowers/6.2.0/skills/brainstorming", hash: "H-brain-old" },
    { agent: "codex", marketplace: "mk", plugin: "implicit", version: "1.0.0", dir: "/h/.codex/plugins/cache/mk/implicit/1.0.0", name: "imp", skillDir: "/h/.codex/plugins/cache/mk/implicit/1.0.0/skills/imp", hash: "H-imp" },
  ],
  builtins: [{ agent: "codex", name: "imagegen", dir: "/h/.codex/skills/.system/imagegen", hash: "H-img" }],
  docs: { "H-check": md("check"), "H-acme": md("acme"), "H-orca": md("orca-cli"), "H-brain": md("brainstorming"), "H-brain-old": md("brainstorming", "old"), "H-video": md("video"), "H-imp": md("imp"), "H-img": md("imagegen") },
};

describe("hostFacts", () => {
  test("parses shipped files; missing files fall back; bad files become errors", () => {
    const f = hostFacts(inv);
    expect(f.claudeEnabled).toEqual({ "superpowers@mk": true, "video@mk": false });
    expect(f.codex.plugins).toEqual({ "superpowers@mk": true, "off@mk": false });
    expect(f.locks.acme.has("acme")).toBe(true);
    expect(f.acmeVersions["acme"]).toBe("0.144.0");
    expect(f.errors).toEqual([]);
    expect(f.claudeModel.some).toBe(false);
    expect(f.claudeDisable1m).toBe(false);
    const modelled = hostFacts({ ...inv, files: { "claude-settings": JSON.stringify({ model: "fable", env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "true", SLASH_COMMAND_TOOL_CHAR_BUDGET: "1500" } }) } });
    expect(modelled.claudeModel).toEqual({ some: true, value: "fable" });
    expect(modelled.claudeDisable1m).toBe(true);
    expect(modelled.claudeOverrides.fixedChars).toBe(1500);
    const broken = hostFacts({ ...inv, files: { "claude-settings": "{" } });
    expect(broken.errors.length).toBe(1);
    expect(broken.claudeEnabled).toEqual({});
  });
});

describe("pluginStates", () => {
  const f = hostFacts(inv);
  test("claude: enabled from settings, active version from installed_plugins, all cached versions listed", () => {
    const ps = pluginStates(inv, f, "claude");
    const sp = ps.find((p) => p.id === "superpowers@mk");
    expect(sp?.enabled).toBe("on");
    expect(sp?.active.some && sp.active.value.version).toBe("6.3.0");
    expect(sp?.active.some && sp.active.value.skills).toEqual(["brainstorming"]);
    expect(sp?.cachedVersions).toEqual(["6.2.0", "6.3.0"]);
    expect(ps.find((p) => p.id === "video@mk")?.enabled).toBe("off");
  });
  test("codex: config entry wins; cached without entry is implicit; configured-but-uncached has no active version", () => {
    const ps = pluginStates(inv, f, "codex");
    const by = Object.fromEntries(ps.map((p) => [p.id, p]));
    expect(by["superpowers@mk"]?.enabled).toBe("on");
    expect(by["superpowers@mk"]?.active.some && by["superpowers@mk"]?.active.value.version).toBe("6.2.0");
    expect(by["implicit@mk"]?.enabled).toBe("implicit");
    expect(by["off@mk"]?.enabled).toBe("off");
    expect(by["off@mk"]?.active.some).toBe(false);
  });
  test("agents without plugins have none", () => {
    expect(pluginStates(inv, f, "cursor")).toEqual([]);
  });
});

describe("effectiveFor", () => {
  const f = hostFacts(inv);
  test("claude: user entries (skm link, acme real dir) + enabled plugin skills; broken links and files excluded", () => {
    const es = effectiveFor(inv, f, agent("claude"));
    expect(es.map((e) => `${e.source.kind}:${e.name}:${e.owner}`)).toEqual(["user:acme:acme", "user:check:skm", "plugin:brainstorming:claude-plugins"]);
    const acme = es.find((e) => e.name === "acme");
    expect(acme?.version).toEqual({ some: true, value: "0.144.0" });
    expect(acme?.storage).toEqual({ kind: "real-dir" });
    expect(acme?.listing).toBe("acme desc. Use when acme.");
    expect(acme?.bodyTokens).toBeGreaterThan(0);
    const brain = es.find((e) => e.name === "brainstorming");
    expect(brain?.source).toEqual({ kind: "plugin", marketplace: "mk", plugin: "superpowers", version: "6.3.0" });
    expect(brain?.path).toBe("/h/.claude/plugins/cache/mk/superpowers/6.3.0/skills/brainstorming");
    expect(sourceCounts(es)).toEqual({ user: 2, legacy: 0, builtin: 0, plugin: 1 });
  });
  test("codex: legacy dir entries carry their dir, builtins and implicit plugins included, skills-cli owner from lock", () => {
    const es = effectiveFor(inv, f, agent("codex"));
    expect(es.map((e) => `${e.source.kind}:${e.name}`)).toEqual(["user:check", "user:orca-cli", "legacy:check", "builtin:imagegen", "plugin:brainstorming", "plugin:imp"]);
    expect(es.find((e) => e.source.kind === "legacy")?.path).toBe("/h/.codex/skills/check");
    expect(es.find((e) => e.name === "orca-cli")?.owner).toBe("skills-cli");
    expect(es.find((e) => e.name === "imp")?.enabled).toBe("implicit");
    expect(es.find((e) => e.name === "imagegen")?.owner).toBe("codex-builtin");
  });
});

describe("findings", () => {
  const f = hostFacts(inv);
  const eff = { claude: effectiveFor(inv, f, agent("claude")), codex: effectiveFor(inv, f, agent("codex")) };
  const states = { claude: pluginStates(inv, f, "claude"), codex: pluginStates(inv, f, "codex") };
  test("same-name and same-content on codex (user link + legacy copy of check); stale + disabled caches on claude", () => {
    const fs = hostFindings("local", eff, states);
    const kinds = fs.map((x) => x.kind);
    expect(kinds.filter((k) => k === "same-name").length).toBe(1);
    expect(fs.find((x) => x.kind === "same-name")).toMatchObject({ agent: "codex", name: "check" });
    // the identical-content pair is the same path set as the same-name finding → reported once, not twice
    expect(fs.filter((x) => x.kind === "same-content")).toEqual([]);
    expect(fs.filter((x) => x.kind === "stale-cache").map((x) => x.kind === "stale-cache" ? `${x.agent}:${x.plugin}:${x.versions.join("+")}` : "")).toEqual(["claude:superpowers@mk:6.2.0"]);
    expect(fs.filter((x) => x.kind === "disabled-cached").map((x) => x.kind === "disabled-cached" ? `${x.agent}:${x.plugin}` : "")).toEqual(["claude:video@mk"]);
  });
  test("store skill reachable from two scanned dirs collapses into one linked-twice finding; a real copy elsewhere is same-content", () => {
    const twice: Inventory = { ...inv, alsoReads: { codex: [{ kind: "managed", name: "check", direct: true, hash: "H-check" }, { kind: "dir", name: "copy-of-check", hash: "H-check" }] }, alsoDirs: { codex: { check: "/h/.codex/skills", "copy-of-check": "/h/.codex/skills" } } };
    const f2 = hostFacts(twice);
    const fs = hostFindings("local", { codex: effectiveFor(twice, f2, agent("codex")) }, { codex: pluginStates(twice, f2, "codex") });
    expect(fs.find((x) => x.kind === "linked-twice")).toEqual({ kind: "linked-twice", host: "local", agent: "codex", names: ["check"], dirs: ["/h/.agents/skills", "/h/.codex/skills"] });
    expect(fs.filter((x) => x.kind === "same-name")).toEqual([]);
    const sc = fs.find((x) => x.kind === "same-content");
    expect(sc && sc.kind === "same-content" ? [...sc.names].sort() : []).toEqual(["check", "copy-of-check"]);
  });
  test("version drift across agents/hosts", () => {
    const d = driftFindings([{ host: "local", states }, { host: "mini", states: { claude: states.claude } }]);
    expect(d).toEqual([{ kind: "version-drift", plugin: "superpowers", cells: [{ host: "local", agent: "claude", version: "6.3.0" }, { host: "local", agent: "codex", version: "6.2.0" }, { host: "mini", agent: "claude", version: "6.3.0" }] }]);
    expect(driftFindings([{ host: "local", states: { claude: states.claude } }])).toEqual([]);
  });
});

describe("effectiveFor: directories without SKILL.md", () => {
  test("are skipped, because agents never load them", () => {
    const claude = agentById("claude");
    if (!claude.some) throw new Error("claude agent missing");
    const inv: Inventory = {
      ...emptyInventory("/h"),
      agentDirs: { claude: { exists: true, entries: [{ kind: "dir", name: "log" }, { kind: "dir", name: "real", hash: "h1" }] } },
      docs: { h1: "---\nname: real\ndescription: Real skill. Use when testing.\n---\nbody" },
    };
    const es = effectiveFor(inv, hostFacts(inv), claude.value);
    expect(es.map((e) => e.name)).toEqual(["real"]);
  });
});
