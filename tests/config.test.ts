import { describe, expect, test } from "bun:test";
import { parseConfig, serializeConfig, defaultConfig } from "../src/core/config";
import { desiredFor, scopeOf, selects, setScope } from "../src/core/scope";

const yamlText = `
store: ~/.skm/skills
agents: [claude, codex, cursor]
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
    expect(desiredFor(cfg, skills, "devbox", "cursor")).toEqual([]); // cursor not enabled on devbox
    expect(desiredFor(cfg, skills, "mini", "cursor")).toEqual(["corp-x", "kb-doc", "kb-im", "plain"]);
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
  acme: { tool: acme }
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
    expect(r.value.plugins[2]).toEqual({ name: "bare", marketplace: {}, hosts: { kind: "all" }, agents: { kind: "all" }, enabled: true });
    expect(r.value.plugins[3]?.enabled).toBe(false);
    expect(r.value.owned).toEqual([
      { skill: "acme", tool: "acme", ensure: { some: false }, fallback: "store", agents: { some: false } },
      { skill: "other", tool: "foo", ensure: { some: true, value: "foo install" }, fallback: "none", agents: { some: true, value: ["claude"] } },
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
    expect(parseConfig("hosts: { local: {} }\nplugins: { p: { marketplace: [1] } }").ok).toBe(false);
    expect(parseConfig("hosts: { local: {} }\nplugins: { p: { enabled: maybe } }").ok).toBe(false);
  });
  test("defaults have no plugins/owned and serialize without those keys", () => {
    const d = defaultConfig();
    expect(d.plugins).toEqual([]);
    expect(serializeConfig(d)).not.toContain("plugins:");
  });
});
