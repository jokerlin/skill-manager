import { describe, expect, test } from "bun:test";
import { hostEntries, parseConfig, serializeConfig, setHostEnabled } from "../src/core/config";
import { parsePatch, patchConfig } from "../src/core/patch";

const parse = (text: string) => {
  const r = parseConfig(text);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const yamlText = `agents: [claude, codex]
hosts:
  local: {}
  mini: { ssh: mini }
  home-mbp: { ssh: home-mbp, enabled: false }
  devbox: { ssh: devbox }
rules:
  - skills: [readwise-cli]
    hosts: { only: [home-mbp] }
`;

describe("host enabled: false", () => {
  test("parks the host: hosts leaves it out, parked keeps it with its file position", () => {
    const c = parse(yamlText);
    expect(c.hosts.map((h) => h.id)).toEqual(["local", "mini", "devbox"]);
    expect(c.parked.map((p) => [p.host.id, p.at])).toEqual([["home-mbp", 2]]);
    expect(hostEntries(c).map((e) => [e.host.id, e.enabled])).toEqual([["local", true], ["mini", true], ["home-mbp", false], ["devbox", true]]);
  });

  test("round-trips: the parked host is written back in place with enabled: false, rules untouched", () => {
    const c = parse(yamlText);
    const text = serializeConfig(c);
    expect(text).toMatch(/mini:\n {4}ssh: mini\n {2}home-mbp:\n {4}ssh: home-mbp\n {4}enabled: false\n {2}devbox:/);
    expect(parse(text)).toEqual(c);
  });

  test("enabled hosts serialize without the key", () => {
    expect(serializeConfig(parse(`hosts: { local: {}, mini: { ssh: mini, enabled: true } }`))).not.toContain("enabled");
  });

  test("rejects a non-boolean and a parked hub", () => {
    expect(parseConfig(`hosts: { local: {}, mini: { ssh: mini, enabled: "no" } }`).ok).toBe(false);
    const r = parseConfig(`hosts: { local: { enabled: false }, mini: { ssh: mini } }`);
    expect(r.ok ? null : r.error).toEqual({ kind: "hub-disabled", host: "local" });
  });

  test("setHostEnabled parks and restores in place, is idempotent, refuses the hub and unknown ids", () => {
    const c = parse(yamlText);
    const on = setHostEnabled(c, "home-mbp", true);
    if (!on.ok) throw new Error(JSON.stringify(on.error));
    expect(on.value.hosts.map((h) => h.id)).toEqual(["local", "mini", "home-mbp", "devbox"]);
    expect(on.value.parked).toEqual([]);
    const off = setHostEnabled(on.value, "home-mbp", false);
    expect(off.ok && off.value.parked.map((p) => [p.host.id, p.at])).toEqual([["home-mbp", 2]]);
    expect(off.ok && serializeConfig(off.value)).toBe(serializeConfig(c));
    expect(setHostEnabled(c, "home-mbp", false)).toEqual({ ok: true, value: c });
    expect(setHostEnabled(c, "local", false)).toEqual({ ok: false, error: { kind: "hub-disabled", host: "local" } });
    expect(setHostEnabled(c, "nope", false)).toEqual({ ok: false, error: { kind: "unknown-host", host: "nope", known: ["local", "mini", "home-mbp", "devbox"] } });
  });

  test("two parked hosts come back in file order", () => {
    const c = parse(`hosts: { a: { ssh: a, enabled: false }, local: {}, b: { ssh: b, enabled: false }, c: { ssh: c } }`);
    expect(c.hosts.map((h) => h.id)).toEqual(["local", "c"]);
    expect(hostEntries(c).map((e) => e.host.id)).toEqual(["a", "local", "b", "c"]);
  });
});

describe("config patch with parked hosts", () => {
  const c = parse(yamlText);
  const apply = (json: string) => {
    const p = parsePatch(json);
    return p.ok ? patchConfig(c, p.value) : p;
  };
  const list = (over: Record<string, unknown> = {}) => [
    { id: "local", ssh: null, agents: null },
    { id: "mini", ssh: "mini", agents: null },
    { id: "home-mbp", ssh: "home-mbp", agents: null, ...over },
    { id: "devbox", ssh: "devbox", agents: null },
  ];

  test("a patch without enabled keeps a parked host parked", () => {
    const r = apply(JSON.stringify({ hosts: list() }));
    expect(r.ok && r.value.parked.map((p) => p.host.id)).toEqual(["home-mbp"]);
    expect(r.ok && r.value.hosts.map((h) => h.id)).toEqual(["local", "mini", "devbox"]);
  });

  test("a patch that does not touch hosts keeps parked hosts", () => {
    const r = apply(JSON.stringify({ contextTokens: 200000 }));
    expect(r.ok && serializeConfig(r.value)).toContain("enabled: false");
  });

  test("enabled: true brings it back; enabled: false on the hub is refused", () => {
    const r = apply(JSON.stringify({ hosts: list({ enabled: true }) }));
    expect(r.ok && r.value.hosts.map((h) => h.id)).toEqual(["local", "mini", "home-mbp", "devbox"]);
    const hub = apply(JSON.stringify({ hosts: [{ id: "local", ssh: null, agents: null, enabled: false }, { id: "mini", ssh: "mini", agents: null }] }));
    expect(hub.ok).toBe(false);
    expect(parsePatch(JSON.stringify({ hosts: [{ id: "local", ssh: null, agents: null, enabled: "yes" }] })).ok).toBe(false);
  });

  test("renaming a parked host renames its rule references", () => {
    const r = apply(JSON.stringify({ hosts: list({ from: "home-mbp", id: "mbp" }) }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.parked.map((p) => p.host.id)).toEqual(["mbp"]);
    expect(r.value.rules[0]?.hosts).toEqual({ some: true, value: { kind: "only", globs: ["mbp"] } });
  });
});
