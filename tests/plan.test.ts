import { describe, expect, test } from "bun:test";
import { parseProbeOutput, type Inventory } from "../src/core/inventory";
import { planHost } from "../src/core/plan";

const probe = [
  "meta\thome\t/home/u",
  "store\talpha\tAAA",
  "store\tbeta\tBBB",
  "store\tremote-only\tRRR",
  "dir\tclaude\t1",
  "entry\tclaude\talpha\tlink\t/home/u/.skm/skills/alpha",
  "entry\tclaude\tgamma\tlink\t/home/u/.skm/skills/gamma",
  "entry\tclaude\tlocalthing\tdir\t",
  "entry\tclaude\tforeign\tlink\t/repo/skills/foreign",
  "entry\tclaude\tbroken\tbrokenlink\t/home/u/.skm/skills/gone",
  "entry\tclaude\tnotes.txt\tfile\t",
  "dir\tcodex\t0",
].join("\n");

describe("parseProbeOutput", () => {
  test("classifies entries", () => {
    const r = parseProbeOutput(probe, "/home/u/.skm/skills");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inv = r.value;
    expect(inv.home).toBe("/home/u");
    expect(inv.storeSkills).toEqual([{ name: "alpha", hash: "AAA" }, { name: "beta", hash: "BBB" }, { name: "remote-only", hash: "RRR" }]);
    expect(inv.agentDirs["claude"]?.exists).toBe(true);
    expect(inv.agentDirs["codex"]?.exists).toBe(false);
    const kinds = Object.fromEntries((inv.agentDirs["claude"]?.entries ?? []).map((e) => [e.name, e.kind]));
    expect(kinds).toEqual({ alpha: "managed", gamma: "managed", localthing: "dir", foreign: "foreign-link", broken: "broken-link", "notes.txt": "file" });
  });
  test("rejects garbage", () => {
    expect(parseProbeOutput("what\tever", "/x").ok).toBe(false);
  });
});

describe("planHost", () => {
  const inv = (() => { const r = parseProbeOutput(probe, "/home/u/.skm/skills"); if (!r.ok) throw new Error(); return r.value; })();
  const hub = [{ name: "alpha", hash: "AAA" }, { name: "beta", hash: "NEW" }, { name: "delta", hash: "DDD" }, { name: "gamma", hash: "GGG" }];
  const agentDirs = { claude: "/home/u/.claude/skills", codex: "/home/u/.agents/skills" };
  const ops = planHost({
    hostId: "devbox", isLocal: false,
    desired: { claude: ["alpha", "beta", "localthing", "foreign", "broken"], codex: ["delta"] },
    inventory: inv, hubSkills: hub, agentDirs,
  });
  const of = (op: string) => ops.filter((o) => o.op === op);
  test("rsync only changed/missing skills that some agent wants", () => {
    expect(of("rsync-skill").map((o) => (o.op === "rsync-skill" ? o.skill : "")).sort()).toEqual(["beta", "delta"]);
  });
  test("mkdir for missing agent dirs", () => {
    expect(of("mkdir")).toEqual([{ op: "mkdir", host: "devbox", path: "/home/u/.agents/skills" }]);
  });
  test("link desired-but-absent and broken links; unlink managed-but-undesired", () => {
    expect(of("link").map((o) => (o.op === "link" ? `${o.agent}/${o.skill}` : "")).sort()).toEqual(["claude/beta", "claude/broken", "codex/delta"]);
    expect(of("unlink").map((o) => (o.op === "unlink" ? `${o.agent}/${o.skill}` : ""))).toEqual(["claude/gamma"]);
  });
  test("conflicts for real dirs and foreign links", () => {
    expect(of("conflict").map((o) => (o.op === "conflict" ? `${o.agent}/${o.skill}:${o.entry.kind}` : "")).sort()).toEqual(["claude/foreign:foreign-link", "claude/localthing:dir"]);
  });
  test("remote-only store skills reported", () => {
    expect(of("remote-only")).toEqual([{ op: "remote-only", host: "devbox", skill: "remote-only" }]);
  });
  test("a managed link to a skill the hub does not know is left alone", () => {
    const inv2 = { ...inv, agentDirs: { ...inv.agentDirs, claude: { exists: true, entries: [{ kind: "managed" as const, name: "remote-only", direct: true }] } } };
    const ops2 = planHost({ hostId: "devbox", isLocal: false, desired: { claude: [] }, inventory: inv2, hubSkills: hub, agentDirs });
    expect(ops2.filter((o) => o.op === "unlink")).toEqual([]);
  });
  test("ordering: mkdir → rsync → unlink → link", () => {
    const seq = ops.map((o) => o.op).filter((k) => ["mkdir", "rsync-skill", "unlink", "link"].includes(k));
    const rank = { mkdir: 0, "rsync-skill": 1, unlink: 2, link: 3 } as Record<string, number>;
    expect(seq.every((k, i) => i === 0 || (rank[k] ?? 0) >= (rank[seq[i - 1] ?? ""] ?? 0))).toBe(true);
  });
  test("local host never rsyncs", () => {
    const local = planHost({ hostId: "local", isLocal: true, desired: { claude: ["beta"] }, inventory: inv, hubSkills: hub, agentDirs });
    expect(local.filter((o) => o.op === "rsync-skill")).toEqual([]);
  });
  test("second run is a no-op", () => {
    const settled: Inventory = {
      ...inv,
      storeSkills: hub,
      agentDirs: {
        claude: { exists: true, entries: [{ kind: "managed", name: "alpha", direct: true }, { kind: "managed", name: "beta", direct: true }] },
        codex: { exists: true, entries: [{ kind: "managed", name: "delta", direct: true }] },
      },
    };
    const again = planHost({ hostId: "devbox", isLocal: false, desired: { claude: ["alpha", "beta"], codex: ["delta"] }, inventory: settled, hubSkills: hub, agentDirs });
    expect(again).toEqual([]);
  });
});

describe("planHost v2: plugins and owned skills", () => {
  const { some, none } = require("../src/lib/result") as typeof import("../src/lib/result");
  const { emptyInventory } = require("../src/core/inventory") as typeof import("../src/core/inventory");
  const base = {
    hostId: "mini", isLocal: false, hubSkills: [{ name: "acme", hash: "B" }, { name: "alpha", hash: "A" }],
    agentDirs: { claude: "/h/.claude/skills", codex: "/h/.agents/skills" },
  };
  const inv = (entries: Record<string, Inventory["agentDirs"][string]>, tools: Record<string, string> = {}): Inventory => ({
    ...emptyInventory("/h"), storeSkills: [{ name: "acme", hash: "B" }, { name: "alpha", hash: "A" }], agentDirs: entries, tools,
  });
  const state = (agent: string, id: string, enabled: "on" | "off" | "implicit", version?: string) => {
    const at = id.lastIndexOf("@");
    return { agent, id, name: id.slice(0, at), marketplace: id.slice(at + 1), enabled, active: version ? some({ version, dir: `/c/${version}`, skills: [] }) : none, cachedVersions: version ? [version] : [] };
  };
  const both = { claude: { exists: true, entries: [] }, codex: { exists: true, entries: [] } };
  const kinds = (ops: readonly ReturnType<typeof planHost>[number][]) => ops.map((o) => o.op === "blocked" ? `blocked:${o.agent}` : o.op === "owned-ensure" ? `owned-ensure:${o.skill}` : "plugin" in o ? `${o.op}:${o.agent}:${o.plugin}` : "marketplace" in o ? `${o.op}:${o.agent}:${o.marketplace}` : `${o.op}`);

  test("wanted plugin: install (+marketplace add when unknown but hub knows source), enable when off, nothing when on", () => {
    const cells = [{ agent: "claude", name: "superpowers", marketplace: "mk", wanted: true }, { agent: "codex", name: "superpowers", marketplace: "mk", wanted: true }];
    const ops = planHost({ ...base, desired: {}, inventory: inv(both, { claude: "/bin/claude", codex: "/bin/codex" }), plugins: cells,
      pluginStates: { claude: [state("claude", "superpowers@mk", "off", "6.3.0")], codex: [] }, marketplaces: { claude: { mk: "x" } }, hubMarketplaces: { mk: "anthropics/x" } });
    expect(kinds(ops)).toEqual(["marketplace-add:codex:mk", "plugin-install:codex:superpowers@mk", "plugin-enable:claude:superpowers@mk"]);
    const quiet = planHost({ ...base, desired: {}, inventory: inv(both, { claude: "/bin/claude" }), plugins: [cells[0]!], pluginStates: { claude: [state("claude", "superpowers@mk", "on", "6.3.0")] } });
    expect(quiet).toEqual([]);
  });
  test("blocked when the agent CLI is missing or no marketplace source is known; implicit counts as on", () => {
    const cells = [{ agent: "claude", name: "p", marketplace: "mk", wanted: true }, { agent: "codex", name: "q", marketplace: "mk2", wanted: true }, { agent: "codex", name: "r", marketplace: "", wanted: true }];
    const ops = planHost({ ...base, desired: {}, inventory: inv(both, { codex: "/bin/codex" }), plugins: cells, pluginStates: { codex: [state("codex", "r@", "implicit", "1")] }, hubMarketplaces: {} });
    expect(ops.map((o) => (o.op === "blocked" ? `${o.agent}:${o.what}` : o.op))).toEqual(["claude:plugin p@mk", "codex:plugin q@mk2", "codex:plugin r@"]);
    const okImplicit = planHost({ ...base, desired: {}, inventory: inv(both, { codex: "/bin/codex" }), plugins: [{ agent: "codex", name: "r", marketplace: "mk", wanted: true }], pluginStates: { codex: [state("codex", "r@mk", "implicit", "1")] } });
    expect(okImplicit).toEqual([]);
  });
  test("unwanted plugin: disable only when currently on/implicit; codex disable needs no CLI", () => {
    const cells = [{ agent: "claude", name: "p", marketplace: "mk", wanted: false }, { agent: "codex", name: "p", marketplace: "mk", wanted: false }, { agent: "codex", name: "z", marketplace: "mk", wanted: false }];
    const ops = planHost({ ...base, desired: {}, inventory: inv(both, {}), plugins: cells, pluginStates: { claude: [state("claude", "p@mk", "on", "1")], codex: [state("codex", "p@mk", "implicit", "1"), state("codex", "z@mk", "off", "1")] } });
    expect(kinds(ops)).toEqual(["plugin-disable:codex:p@mk", "blocked:claude"]);
  });
  test("owned skill with tool present: no link/conflict, ensure when a wanted agent lacks the real dir", () => {
    const owned = [{ skill: "acme", tool: "acme", command: some("acme self skill install -g -s acme"), fallback: "store" as const }];
    const present = inv({ claude: { exists: true, entries: [{ kind: "dir", name: "acme" }] }, codex: { exists: true, entries: [{ kind: "dir", name: "acme" }] } }, { acme: "/bin/acme" });
    expect(planHost({ ...base, desired: { claude: ["acme"], codex: ["acme"] }, inventory: present, owned })).toEqual([]);
    const half = inv({ claude: { exists: true, entries: [{ kind: "dir", name: "acme" }] }, codex: { exists: true, entries: [{ kind: "managed", name: "acme", direct: true }] } }, { acme: "/bin/acme" });
    const ops = planHost({ ...base, desired: { claude: ["acme"], codex: ["acme"] }, inventory: half, owned });
    expect(kinds(ops)).toEqual(["unlink", "owned-ensure:acme"]);
    expect(ops[1]).toMatchObject({ op: "owned-ensure", tool: "acme", command: "acme self skill install -g -s acme" });
    const noCmd = planHost({ ...base, desired: { claude: ["acme"] }, inventory: inv(both, { acme: "/bin/acme" }), owned: [{ ...owned[0]!, command: none }] });
    expect(noCmd.map((o) => o.op)).toEqual(["blocked"]);
  });
  test("owned skill with tool absent: fallback store links the hub copy; fallback none leaves the cell empty and unlinks", () => {
    const owned = (fallback: "store" | "none") => [{ skill: "acme", tool: "acme", command: none, fallback }];
    const empty = inv(both, {});
    expect(planHost({ ...base, desired: { claude: ["acme"] }, inventory: empty, owned: owned("store") }).map((o) => o.op)).toEqual(["link"]);
    expect(planHost({ ...base, desired: { claude: ["acme"] }, inventory: empty, owned: owned("none") })).toEqual([]);
    // fallback store but the hub has no copy: nothing to link, nothing dangling
    expect(planHost({ ...base, hubSkills: [], desired: { claude: ["acme"] }, inventory: empty, owned: owned("store") }).filter((o) => o.op !== "remote-only")).toEqual([]);
    const linked = inv({ claude: { exists: true, entries: [{ kind: "managed", name: "acme", direct: true }] }, codex: both.codex }, {});
    expect(planHost({ ...base, desired: { claude: ["acme"] }, inventory: linked, owned: owned("none") }).map((o) => o.op)).toEqual(["unlink"]);
  });
  test("v1 behaviour untouched when no plugins/owned are configured", () => {
    const ops = planHost({ ...base, desired: { claude: ["alpha"] }, inventory: inv(both) });
    expect(ops.map((o) => o.op)).toEqual(["link"]);
  });
});
