import { describe, expect, test } from "bun:test";
import { parseConfig, serializeConfig } from "../src/core/config";
import { parsePatch, patchConfig } from "../src/core/patch";

const cfg = (() => {
  const r = parseConfig(`agents: [claude, codex, pi]
hosts: { local: {}, mini: { ssh: mini }, devbox: { ssh: devbox, agents: [claude], skm: ~/x } }`);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
})();

const apply = (json: string) => {
  const p = parsePatch(json);
  if (!p.ok) return p;
  return patchConfig(cfg, p.value);
};

describe("config patch", () => {
  test("reorders hosts, keeps skm home, drops a full agent subset", () => {
    const r = apply(JSON.stringify({ hosts: [
      { id: "devbox", ssh: "devbox", agents: ["claude", "codex", "pi"] },
      { id: "local", ssh: null, agents: null },
      { id: "mini", ssh: " mini2 ", agents: ["codex"] },
    ] }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.hosts.map((h) => h.id)).toEqual(["devbox", "local", "mini"]);
    expect(r.value.hosts[0]).toEqual({ id: "devbox", ssh: { some: true, value: "devbox" }, agents: { some: false }, skm: "~/x" });
    expect(r.value.hosts[2]?.ssh).toEqual({ some: true, value: "mini2" });
    expect(r.value.hosts[2]?.agents).toEqual({ some: true, value: ["codex"] });
    expect(parseConfig(serializeConfig(r.value))).toEqual({ ok: true, value: r.value });
  });

  test("scalar fields", () => {
    const r = apply(`{"backupBeforeApply": false, "contextTokens": 272000, "agents": ["claude", "codex"]}`);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.backupBeforeApply).toBe(false);
    expect(r.value.contextTokens).toBe(272000);
    expect(r.value.agents).toEqual(["claude", "codex"]);
  });

  test("rejects what config.yaml could not hold", () => {
    expect(apply("{").ok).toBe(false);
    expect(apply(`{"agents": ["cursor"]}`).ok).toBe(false);
    expect(apply(`{"agents": []}`).ok).toBe(false);
    expect(apply(`{"contextTokens": -1}`).ok).toBe(false);
    expect(apply(`{"hosts": [{"id": "mini", "ssh": "mini", "agents": null}]}`).ok).toBe(false); // no local
    expect(apply(`{"hosts": [{"id": "local", "ssh": "x", "agents": null}]}`).ok).toBe(false);
    expect(apply(`{"hosts": [{"id": "local", "ssh": null, "agents": null}, {"id": "a b", "ssh": "x", "agents": null}]}`).ok).toBe(false);
    expect(apply(`{"hosts": [{"id": "local", "ssh": null, "agents": null}, {"id": "box", "ssh": "", "agents": null}]}`).ok).toBe(false);
    expect(apply(`{"hosts": [{"id": "local", "ssh": null, "agents": null}, {"id": "local", "ssh": null, "agents": null}]}`).ok).toBe(false);
    expect(apply(`{"hosts": [{"id": "local", "ssh": null, "agents": ["gemini"]}]}`).ok).toBe(false);
  });

  test("renames a host and every exact reference to it", () => {
    const base = parseConfig(`agents: [claude, codex]
hosts: { local: {}, mini: { ssh: mini } }
defaults: { hosts: { except: [mini] } }
rules:
  - skills: [a]
    hosts: { only: [mini, "mini*"] }
    on: [mini/claude]
    off: [local/codex]
plugins:
  sp:
    hosts: { only: [mini] }
    off: [mini/codex]`);
    if (!base.ok) throw new Error(JSON.stringify(base.error));
    const p = parsePatch(JSON.stringify({ hosts: [{ from: "local", id: "laptop", ssh: null, agents: null }, { from: "mini", id: "studio", ssh: "mini", agents: null, skm: "~/.skm2" }] }));
    if (!p.ok) throw new Error(JSON.stringify(p.error));
    const r = patchConfig(base.value, p.value);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.hosts.map((h) => [h.id, h.skm])).toEqual([["laptop", "~/.skm"], ["studio", "~/.skm2"]]);
    expect(r.value.defaults.hosts).toEqual({ kind: "except", globs: ["studio"] });
    const rule = r.value.rules[0];
    expect(rule?.hosts).toEqual({ some: true, value: { kind: "only", globs: ["studio", "mini*"] } });
    expect(rule?.on).toEqual([{ host: "studio", agent: "claude" }]);
    expect(rule?.off).toEqual([{ host: "laptop", agent: "codex" }]);
    expect(r.value.plugins[0]?.hosts).toEqual({ kind: "only", globs: ["studio"] });
    expect(r.value.plugins[0]?.off).toEqual([{ host: "studio", agent: "codex" }]);
  });

  test("swapping two host ids does not merge their references", () => {
    const base = parseConfig(`hosts: { local: {}, a: { ssh: a }, b: { ssh: b } }
rules: [{ skills: [x], on: [a/claude], off: [b/claude] }]`);
    if (!base.ok) throw new Error(JSON.stringify(base.error));
    const p = parsePatch(JSON.stringify({ hosts: [{ from: "local", id: "local", ssh: null, agents: null }, { from: "a", id: "b", ssh: "a", agents: null }, { from: "b", id: "a", ssh: "b", agents: null }] }));
    if (!p.ok) throw new Error(JSON.stringify(p.error));
    const r = patchConfig(base.value, p.value);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.rules[0]?.on).toEqual([{ host: "b", agent: "claude" }]);
    expect(r.value.rules[0]?.off).toEqual([{ host: "a", agent: "claude" }]);
  });

  test("exactly one host may omit ssh, and it need not be called local", () => {
    expect(apply(JSON.stringify({ hosts: [{ from: "local", id: "laptop", ssh: null, agents: null }, { from: "mini", id: "mini", ssh: "mini", agents: null }] })).ok).toBe(true);
    expect(apply(JSON.stringify({ hosts: [{ id: "a", ssh: null, agents: null }, { id: "b", ssh: null, agents: null }] })).ok).toBe(false);
    expect(apply(JSON.stringify({ hosts: [{ id: "a", ssh: "a", agents: null }] })).ok).toBe(false);
    expect(parseConfig("hosts: { laptop: {}, mini: { ssh: mini } }").ok).toBe(true);
    expect(parseConfig("hosts: { a: {}, b: {} }")).toEqual({ ok: false, error: { kind: "hub", count: 2 } });
  });

  test("agent overrides set, round-trip, and clear", () => {
    const r = apply(JSON.stringify({ agentOverrides: { claude: { dir: "~/.claude-work/skills", update: null }, pi: { dir: "", update: "pi update" } } }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.agentOverrides).toEqual({ claude: { dir: { some: true, value: "~/.claude-work/skills" }, update: { some: false } }, pi: { dir: { some: false }, update: { some: true, value: "pi update" } } });
    expect(parseConfig(serializeConfig(r.value))).toEqual({ ok: true, value: r.value });
    const cleared = patchConfig(r.value, { agentOverrides: { claude: { dir: null, update: null } } });
    if (!cleared.ok) throw new Error(JSON.stringify(cleared.error));
    expect(Object.keys(cleared.value.agentOverrides)).toEqual(["pi"]);
    expect(apply(JSON.stringify({ agentOverrides: { gemini: { dir: "x", update: null } } })).ok).toBe(false);
  });
});
