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
  const hub = [{ name: "alpha", hash: "AAA" }, { name: "beta", hash: "NEW" }, { name: "delta", hash: "DDD" }];
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
