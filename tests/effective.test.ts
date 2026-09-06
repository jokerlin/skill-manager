import { describe, expect, test } from "bun:test";
import { agentById } from "../src/core/agents";
import { driftFindings, effectiveFor, findingText, hostFacts, hostFindings, pluginStates, shadowedFor, sourceCounts } from "../src/core/effective";
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
  test("codex: config entry wins; cached without entry is off (Codex does not load it); configured-but-uncached has no active version", () => {
    const ps = pluginStates(inv, f, "codex");
    const by = Object.fromEntries(ps.map((p) => [p.id, p]));
    expect(by["superpowers@mk"]?.enabled).toBe("on");
    expect(by["superpowers@mk"]?.active.some && by["superpowers@mk"]?.active.value.version).toBe("6.2.0");
    expect(by["implicit@mk"]?.enabled).toBe("off");
    expect(by["implicit@mk"]?.cachedVersions).toEqual(["1.0.0"]);
    expect(by["off@mk"]?.enabled).toBe("off");
    expect(by["off@mk"]?.active.some).toBe(false);
  });
  test("agents/openai.yaml allow_implicit_invocation: false hides a skill from Codex's catalog only", () => {
    const hidden: Inventory = { ...inv, hidden: [{ agent: "codex", dir: "/h/.codex/skills/.system/imagegen" }, { agent: "claude", dir: "/h/.claude/skills/check" }] };
    const f2 = hostFacts(hidden);
    const codex = effectiveFor(hidden, f2, agent("codex"));
    expect(codex.find((e) => e.name === "imagegen")?.promptVisible).toBe(false);
    expect(codex.find((e) => e.name === "check" && e.source.kind === "user")?.promptVisible).toBe(true);
    expect(effectiveFor(hidden, f2, agent("claude")).find((e) => e.name === "check")?.promptVisible).toBe(true);
    expect(effectiveFor(inv, hostFacts(inv), agent("codex")).every((e) => e.promptVisible)).toBe(true);
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
  test("codex: legacy dir entries carry their dir, builtins included, cached-only plugins excluded, skills-cli owner from lock", () => {
    const es = effectiveFor(inv, f, agent("codex"));
    expect(es.map((e) => `${e.source.kind}:${e.name}`)).toEqual(["user:check", "user:orca-cli", "legacy:check", "builtin:imagegen", "plugin:brainstorming"]);
    expect(es.find((e) => e.source.kind === "legacy")?.path).toBe("/h/.codex/skills/check");
    expect(es.find((e) => e.name === "orca-cli")?.owner).toBe("skills-cli");
    expect(es.find((e) => e.name === "imp")).toBeUndefined();
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
    // switched off in the agent's config ⇒ disabled-cached; never mentioned there ⇒ unloaded-cache (codex's cached-but-unconfigured plugin is a leftover it never loads)
    expect(fs.filter((x) => x.kind === "disabled-cached").map((x) => x.kind === "disabled-cached" ? `${x.agent}:${x.plugin}` : "")).toEqual(["claude:video@mk"]);
    const unloaded = fs.filter((x) => x.kind === "unloaded-cache");
    expect(unloaded).toEqual([{ kind: "unloaded-cache", host: "local", agent: "codex", plugin: "implicit@mk", marketplaceKnown: false }]);
    expect(unloaded.map(findingText)[0]).toContain("no entry in config.toml [plugins]");
    expect(unloaded.map(findingText)[0]).toContain("marketplace is not configured");
    expect(states.codex.map((p) => `${p.id}:${p.configured ? "configured" : "unconfigured"}`)).toEqual(["implicit@mk:unconfigured", "off@mk:configured", "superpowers@mk:configured"]);
  });
  test("owned-drift: a store copy linked for pi differs from the acme-written claude dir; identical copies are quiet", () => {
    const withPi = (hash: string): Inventory => ({
      ...inv,
      storeSkills: [...inv.storeSkills, { name: "acme", hash }],
      agentDirs: { ...inv.agentDirs, pi: { exists: true, entries: [{ kind: "managed", name: "acme", direct: true, hash }] } },
      docs: { ...inv.docs, [hash]: md("acme", "store copy") },
    });
    const stale = withPi("H-acme-store");
    const fs = hostFindings("local", { claude: effectiveFor(stale, hostFacts(stale), agent("claude")), pi: effectiveFor(stale, hostFacts(stale), agent("pi")) }, {});
    const d = fs.find((x) => x.kind === "owned-drift");
    expect(d).toMatchObject({ kind: "owned-drift", host: "local", name: "acme", owner: "acme", ownerPath: "/h/.claude/skills/acme", agents: ["pi"], storeHash: "H-acme-store", ownerHash: "H-acme" });
    expect(d && findingText(d)).toContain("differs from the acme-written /h/.claude/skills/acme");
    const fresh = withPi("H-acme");
    expect(hostFindings("local", { claude: effectiveFor(fresh, hostFacts(fresh), agent("claude")), pi: effectiveFor(fresh, hostFacts(fresh), agent("pi")) }, {}).filter((x) => x.kind === "owned-drift")).toEqual([]);
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

describe("effectiveFor: agents that dedupe by name (dsh: ~/.dsh/skills wins over ~/.agents/skills)", () => {
  const dsh: Inventory = {
    ...emptyInventory("/h"),
    storeSkills: [{ name: "check", hash: "H-check" }, { name: "hunt", hash: "H-hunt" }, { name: "learn", hash: "H-learn" }],
    agentDirs: { dsh: { exists: true, entries: [{ kind: "managed", name: "check", direct: true, hash: "H-check" }, { kind: "managed", name: "hunt", direct: true, hash: "H-hunt" }, { kind: "broken-link", name: "gone", target: "/x" }] } },
    alsoReads: { dsh: [{ kind: "managed", name: "check", direct: true, hash: "H-check" }, { kind: "managed", name: "learn", direct: true, hash: "H-learn" }, { kind: "dir", name: "hunt", hash: "H-hunt-other" }, { kind: "managed", name: "gone", direct: true, hash: "H-gone" }] },
    alsoDirs: { dsh: { check: "/h/.agents/skills", learn: "/h/.agents/skills", hunt: "/h/.agents/skills", gone: "/h/.agents/skills" } },
    docs: { "H-check": md("check"), "H-hunt": md("hunt"), "H-hunt-other": md("hunt", "a different hunt"), "H-learn": md("learn"), "H-gone": md("gone") },
  };
  const f = hostFacts(dsh);
  const es = effectiveFor(dsh, f, agent("dsh"));
  test("a name present in the user dir loads once; the ~/.agents copy is shadowed and not part of the effective list", () => {
    expect(es.map((e) => `${e.source.kind}:${e.name}`)).toEqual(["user:check", "user:hunt", "legacy:gone", "legacy:learn"]);
    expect(sourceCounts(es)).toEqual({ user: 2, legacy: 2, builtin: 0, plugin: 0 });
  });
  test("shadowed copies are reported once as a `shadowed` finding (content-differing copies named), never as linked-twice or same-name", () => {
    const shadowed = shadowedFor(dsh, f, agent("dsh"));
    expect(shadowed.map((x) => `${x.name}:${x.sameContent}`)).toEqual(["check:true", "hunt:false"]);
    const fs = hostFindings("local", { dsh: es }, {}, { dsh: shadowed });
    expect(fs).toEqual([{ kind: "shadowed", host: "local", agent: "dsh", names: ["check", "hunt"], differing: ["hunt"], winner: "/h/.dsh/skills", dir: "/h/.agents/skills" }]);
  });
  test("codex still loads every copy (no dedupe), so the same inventory shape keeps its linked-twice finding", () => {
    const codex: Inventory = { ...dsh, agentDirs: { codex: dsh.agentDirs["dsh"]! }, alsoReads: { codex: [{ kind: "managed", name: "check", direct: true, hash: "H-check" }] }, alsoDirs: { codex: { check: "/h/.codex/skills" } } };
    const f2 = hostFacts(codex);
    const es2 = effectiveFor(codex, f2, agent("codex"));
    expect(es2.map((e) => `${e.source.kind}:${e.name}`)).toEqual(["user:check", "user:hunt", "legacy:check"]);
    expect(shadowedFor(codex, f2, agent("codex"))).toEqual([]);
    expect(hostFindings("local", { codex: es2 }, {}, { codex: [] }).map((x) => x.kind)).toEqual(["linked-twice"]);
  });
});
