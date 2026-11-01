import { describe, expect, test } from "bun:test";
import { parseConfig, serializeConfig, defaultConfig, ownedProbe } from "../src/core/config";
import { desiredFor, pluginWanted, scopeOf, selects, setPluginScope, setScope } from "../src/core/scope";

const yamlText = `
store: ~/.skm/skills
agents: [claude, codex, pi]
hosts:
  local: {}
  mini: { ssh: mini }
  devbox: { ssh: devbox, agents: [claude, codex] }
rules:
  - skills: ["kb-*"]
    hosts: { except: [devbox] }
  - skills: ["corp-*"]
    hosts: { only: [mini, devbox] }
  - skills: [hatch-pet]
    hosts: { only: [local] }
    agents: { only: [codex] }
`;

const skills = ["kb-doc", "kb-im", "corp-x", "hatch-pet", "plain"];

describe("parseConfig", () => {
  test("parses spec example", () => {
    const r = parseConfig(yamlText);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hosts.map((h) => h.id)).toEqual(["local", "mini", "devbox"]);
    expect(r.value.rules.length).toBe(3);
    expect(r.value.hosts[2]?.agents).toEqual({ some: true, value: ["claude", "codex"] });
  });
  test("rejects unknown selector shape", () => {
    const r = parseConfig(`hosts: { local: {} }\nrules:\n  - skills: [a]\n    hosts: { bogus: [x] }`);
    expect(r.ok).toBe(false);
  });
  test("rejects bad yaml and missing local host", () => {
    expect(parseConfig("hosts: [").ok).toBe(false);
    const r = parseConfig("hosts: { mini: { ssh: mini } }");
    expect(r.ok).toBe(false);
  });
  test("defaults + round trip", () => {
    const d = defaultConfig();
    expect(d.hosts[0]?.id).toBe("local");
    const again = parseConfig(serializeConfig(d));
    expect(again).toEqual({ ok: true, value: d });
    const c = parseConfig(yamlText);
    if (!c.ok) throw new Error("x");
    expect(parseConfig(serializeConfig(c.value))).toEqual({ ok: true, value: c.value });
  });
});

describe("scope", () => {
  const cfg = (() => {
    const r = parseConfig(yamlText);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  })();
  test("selects", () => {
    expect(selects({ kind: "all" }, "x")).toBe(true);
    expect(selects({ kind: "only", globs: ["a*"] }, "ab")).toBe(true);
    expect(selects({ kind: "except", globs: ["a*"] }, "ab")).toBe(false);
  });
  test("scopeOf applies later rules per field", () => {
    expect(scopeOf(cfg, "hatch-pet")).toEqual({ hosts: { kind: "only", globs: ["local"] }, agents: { kind: "only", globs: ["codex"] }, overrides: [] });
    expect(scopeOf(cfg, "plain")).toEqual({ hosts: { kind: "all" }, agents: { kind: "all" }, overrides: [] });
  });
  test("desiredFor per host × agent", () => {
    expect(desiredFor(cfg, skills, "local", "claude")).toEqual(["kb-doc", "kb-im", "plain"]);
    expect(desiredFor(cfg, skills, "local", "codex")).toEqual(["hatch-pet", "kb-doc", "kb-im", "plain"]);
    expect(desiredFor(cfg, skills, "devbox", "claude")).toEqual(["corp-x", "plain"]);
    expect(desiredFor(cfg, skills, "devbox", "pi")).toEqual([]); // pi not enabled on devbox
    expect(desiredFor(cfg, skills, "mini", "pi")).toEqual(["corp-x", "kb-doc", "kb-im", "plain"]);
    expect(desiredFor(cfg, skills, "nowhere", "claude")).toEqual([]);
  });
  test("setScope toggles a single cell and is idempotent", () => {
    const off = setScope(cfg, "plain", "mini", "claude", false);
    expect(desiredFor(off, skills, "mini", "claude")).not.toContain("plain");
    expect(desiredFor(off, skills, "mini", "codex")).toContain("plain");
    expect(desiredFor(off, skills, "local", "claude")).toContain("plain");
    const off2 = setScope(off, "plain", "mini", "claude", false);
    expect(off2).toEqual(off);
    const on = setScope(off, "plain", "mini", "claude", true);
    expect(desiredFor(on, skills, "mini", "claude")).toContain("plain");
    // turning a cell on for a skill restricted elsewhere keeps other restrictions
    const on2 = setScope(cfg, "kb-doc", "devbox", "claude", true);
    expect(desiredFor(on2, skills, "devbox", "claude")).toContain("kb-doc");
    expect(desiredFor(on2, skills, "devbox", "codex")).not.toContain("kb-doc");
  });
  test("setScope toggled back leaves no override behind", () => {
    const there = setScope(cfg, "plain", "mini", "claude", false);
    expect(setScope(there, "plain", "mini", "claude", true).rules).toEqual(cfg.rules);
    const on = setScope(cfg, "kb-doc", "devbox", "claude", true);
    expect(setScope(on, "kb-doc", "devbox", "claude", false).rules).toEqual(cfg.rules);
    // two cells in the same trailing rule: reverting one keeps the other
    const two = setScope(setScope(cfg, "plain", "mini", "claude", false), "plain", "mini", "codex", false);
    const back = setScope(two, "plain", "mini", "claude", true);
    expect(back.rules.at(-1)?.off).toEqual([{ host: "mini", agent: "codex" }]);
    expect(back.rules.at(-1)?.on).toEqual([]);
  });
});

describe("v2: plugins + owned", () => {
  const text = `
hosts: { local: {}, mini: { ssh: mini } }
plugins:
  superpowers: { marketplace: claude-plugins-official, agents: { only: [claude, codex] } }
  linear-cli: { marketplace: { claude: linear-cli, codex: claude-extras }, hosts: { only: [local] } }
  bare:
  off: { marketplace: claude-extras, enabled: false }
owned:
  acme: { tool: acme, lock: { file: ~/.lock.json, version: "skills.{skill}.v" } }
  other: { tool: foo, ensure: "foo install", fallback: none, agents: [claude] }
`;
  test("parses and round-trips", () => {
    const r = parseConfig(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.plugins.map((p) => p.name)).toEqual(["superpowers", "linear-cli", "bare", "off"]);
    expect(r.value.plugins[0]?.marketplace).toEqual({ claude: "claude-plugins-official", codex: "claude-plugins-official" });
    expect(r.value.plugins[1]?.marketplace).toEqual({ claude: "linear-cli", codex: "claude-extras" });
    expect(r.value.plugins[1]?.hosts).toEqual({ kind: "only", globs: ["local"] });
    expect(r.value.plugins[2]).toEqual({ name: "bare", marketplace: {}, hosts: { kind: "all" }, agents: { kind: "all" }, enabled: true, on: [], off: [] });
    expect(r.value.plugins[3]?.enabled).toBe(false);
    expect(r.value.owned).toEqual([
      { skill: "acme", tool: "acme", ensure: { some: false }, fallback: "store", agents: { some: false }, lock: { some: true, value: { file: "~/.lock.json", version: "skills.{skill}.v" } } },
      { skill: "other", tool: "foo", ensure: { some: true, value: "foo install" }, fallback: "none", agents: { some: true, value: ["claude"] }, lock: { some: false } },
    ]);
    expect(parseConfig(serializeConfig(r.value))).toEqual({ ok: true, value: r.value });
    expect(serializeConfig(r.value)).toContain("marketplace: claude-plugins-official");
    expect(serializeConfig(r.value)).toContain("enabled: false");
    expect(serializeConfig(r.value)).not.toContain("enabled: true");
  });
  test("rejects bad shapes", () => {
    expect(parseConfig("hosts: { local: {} }\nplugins: [a]").ok).toBe(false);
    expect(parseConfig("hosts: { local: {} }\nowned: { x: { ensure: 1 } }").ok).toBe(false);
    expect(parseConfig("hosts: { local: {} }\nowned: { x: { tool: t, fallback: maybe } }").ok).toBe(false);
    expect(parseConfig("hosts: { local: {} }\nowned: { x: { tool: t, agents: claude } }").ok).toBe(false);
    expect(parseConfig("hosts: { local: {} }\nowned: { x: { tool: t, lock: { file: f } } }").ok).toBe(false);
    expect(parseConfig("hosts: { local: {} }\nowned: { x: { tool: t, lock: f } }").ok).toBe(false);
    expect(parseConfig("hosts: { local: {} }\nplugins: { p: { marketplace: [1] } }").ok).toBe(false);
    expect(parseConfig("hosts: { local: {} }\nplugins: { p: { enabled: maybe } }").ok).toBe(false);
  });
  test("defaults have no plugins/owned and serialize without those keys", () => {
    const d = defaultConfig();
    expect(d.plugins).toEqual([]);
    expect(serializeConfig(d)).not.toContain("plugins:");
  });
});

describe("ownedProbe", () => {
  test("adds each owned tool once and each lock file once", () => {
    const r = parseConfig(`hosts: { local: {} }
owned:
  a: { tool: t1, lock: { file: ~/l.json, version: "s.{skill}.v" } }
  b: { tool: t1, lock: { file: ~/l.json, version: "s.{skill}.v" } }
  c: { tool: t2 }`);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(ownedProbe(r.value.owned)).toEqual({ tools: ["t1", "t2"], files: { "lock:~/l.json": "~/l.json" } });
    expect(ownedProbe([])).toEqual({ tools: [], files: {} });
  });
});

describe("plugin cells", () => {
  const base = `
hosts: { local: {}, mini: { ssh: mini }, devbox: { ssh: devbox } }
plugins:
  superpowers: { marketplace: claude-plugins-official, agents: { only: [claude, codex] }, off: [mini/codex] }
  gone: { marketplace: mk, enabled: false }
`;
  const cfg = (() => { const r = parseConfig(base); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; })();
  const sp = (c: typeof cfg) => c.plugins.find((p) => p.name === "superpowers")!;

  test("on/off cells parse, round-trip and override the selectors", () => {
    expect(sp(cfg).off).toEqual([{ host: "mini", agent: "codex" }]);
    expect(pluginWanted(sp(cfg), "mini", "codex")).toBe(false);
    expect(pluginWanted(sp(cfg), "local", "codex")).toBe(true);
    expect(pluginWanted(sp(cfg), "local", "pi")).toBe(false);
    expect(parseConfig(serializeConfig(cfg))).toEqual({ ok: true, value: cfg });
    expect(parseConfig("hosts: { local: {} }\nplugins: { p: { off: [nope] } }").ok).toBe(false);
  });

  test("toggling an existing policy adds an override only where the selectors disagree, and is idempotent", () => {
    const back = setPluginScope(cfg, "superpowers", "mini", "codex", true);
    expect(sp(back).off).toEqual([]);
    expect(sp(back).on).toEqual([]);
    expect(setPluginScope(back, "superpowers", "mini", "codex", true)).toBe(back);
    const pi = setPluginScope(cfg, "superpowers", "devbox", "pi", true);
    expect(sp(pi).on).toEqual([{ host: "devbox", agent: "pi" }]);
    expect(pluginWanted(sp(pi), "devbox", "pi")).toBe(true);
  });

  test("a plugin new to the config keeps today's cells and changes only the toggled one", () => {
    const active = [{ host: "local", agent: "claude" }, { host: "mini", agent: "claude" }];
    const next = setPluginScope(cfg, "linear-cli@linear-cli", "mini", "claude", false, active);
    const p = next.plugins.find((x) => x.name === "linear-cli")!;
    expect(p.marketplace).toEqual({ claude: "linear-cli", codex: "linear-cli" });
    expect(p.hosts).toEqual({ kind: "only", globs: [] });
    expect(pluginWanted(p, "local", "claude")).toBe(true);
    expect(pluginWanted(p, "mini", "claude")).toBe(false);
    expect(pluginWanted(p, "devbox", "claude")).toBe(false);
  });

  test("turning one cell on in an enabled:false policy keeps every other cell off", () => {
    const next = setPluginScope(cfg, "gone", "local", "claude", true);
    const p = next.plugins.find((x) => x.name === "gone")!;
    expect(p.enabled).toBe(true);
    expect(pluginWanted(p, "local", "claude")).toBe(true);
    expect(pluginWanted(p, "mini", "claude")).toBe(false);
    expect(setPluginScope(cfg, "gone", "local", "claude", false)).toBe(cfg);
  });
});

import { withOverride, AGENTS } from "../src/core/agents";
import { none as noneOpt, some as someOpt } from "../src/lib/result";
test("agent override replaces the skills dir and update command", () => {
  const claude = AGENTS[0];
  if (!claude) throw new Error("no agent");
  const a = withOverride(claude, { dir: someOpt("~/.claude-work/skills"), update: noneOpt });
  expect(a.userDir("/h")).toBe("/h/.claude-work/skills");
  expect(a.cli.update).toBe("claude update");
  expect(withOverride(claude, { dir: someOpt("/opt/skills"), update: someOpt("brew upgrade claude") }).userDir("/h")).toBe("/opt/skills");
});
