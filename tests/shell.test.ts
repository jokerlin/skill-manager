import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readlinkSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { none, some } from "../src/lib/result";
import { defaultConfig, parseConfig, type HostConfig } from "../src/core/config";
import { agentById } from "../src/core/agents";
import { loadStore } from "../src/shell/store";
import { localRunner } from "../src/shell/runner";
import { probeHost } from "../src/shell/probe";
import { planFor, agentsOn, agentDirsRel, backupPathsFor, pluginCellsFor, desiredOn } from "../src/shell/hosts";
import { executePlan } from "../src/shell/sync";
import { backupHost, restoreHost, listBackups } from "../src/shell/backup";
import { loadApp } from "../src/shell/app";
import { emptyInventory, type Inventory } from "../src/core/inventory";
import { buildSkill } from "../src/core/skill";

const SCRATCH = process.env["CLAUDE_SCRATCHPAD"] ?? tmpdir();
const skillMd = (n: string) => `---\nname: ${n}\ndescription: ${n} does things. Use when ${n}.\n---\n# ${n}\n`;

describe("CLI-owned skills loaded through a shared directory", () => {
  const parsed = parseConfig(`agents: [claude, codex, pi]\nhosts: { local: {}, mini: { ssh: mini } }\nowned: { acme: { tool: acme, agents: [claude, codex] } }`);
  if (!parsed.ok) throw new Error("invalid fixture");
  const c = parsed.value;
  const host = c.hosts[1]!;
  const skill = buildSkill("acme", "/store/acme", skillMd("acme"), []);
  const inv: Inventory = {
    ...emptyInventory("/h"),
    storeSkills: [{ name: "acme", hash: "old-store-copy" }],
    agentDirs: {
      claude: { exists: true, entries: [{ kind: "dir", name: "acme", hash: "cli-version" }] },
      codex: { exists: true, entries: [{ kind: "dir", name: "acme", hash: "cli-version" }] },
      pi: { exists: false, entries: [] },
    },
    alsoReads: { pi: [{ kind: "dir", name: "acme", hash: "cli-version" }] },
    alsoDirs: { pi: { acme: "/h/.agents/skills" } },
    tools: { acme: "/bin/acme" },
    docs: { "cli-version": skillMd("acme") },
  };
  test("Pi can want the skill without creating a duplicate or replacing the CLI version with the store copy", () => {
    expect(desiredOn(c, [skill], host).pi).toEqual(["acme"]);
    expect(planFor(c, [skill], host, inv)).toEqual([]);
  });
  test("missing, broken, or non-owner shared sources still require a fallback link", () => {
    const variants: Inventory[] = [
      { ...inv, alsoReads: {} },
      { ...inv, alsoReads: { pi: [{ kind: "broken-link", name: "acme", target: "/gone" }] } },
      { ...inv, alsoReads: { pi: [{ kind: "dir", name: "acme" }] } },
      { ...inv, alsoReads: { pi: [{ kind: "foreign-link", name: "acme", hash: "cli-version", target: "/other/acme" }] } },
      { ...inv, alsoDirs: { pi: { acme: "/h/.another/skills" } } },
      { ...inv, tools: {} },
    ];
    for (const inventory of variants) {
      expect(planFor(c, [skill], host, inventory)).toContainEqual({ op: "link", host: "mini", agent: "pi", skill: "acme" });
    }
  });
});

describe("pi exclusions for skills that land in the shared ~/.agents/skills", () => {
  const parsed = parseConfig(`agents: [claude, codex, pi]\nhosts: { local: {}, mini: { ssh: mini } }\nrules:\n  - { skills: [solo], agents: { only: [codex] } }\n  - { skills: [gone], agents: { only: [claude] } }`);
  if (!parsed.ok) throw new Error("invalid fixture");
  const c = parsed.value;
  const host = c.hosts[1]!;
  const skills = ["both", "solo", "gone"].map((n) => buildSkill(n, `/store/${n}`, skillMd(n), []));
  const link = (name: string) => ({ kind: "managed" as const, name, direct: true, hash: `H-${name}` });
  const base: Inventory = {
    ...emptyInventory("/h"),
    storeSkills: skills.map((s) => ({ name: s.name, hash: s.contentHash })),
    agentDirs: {
      claude: { exists: true, entries: [link("both"), link("gone")] },
      codex: { exists: true, entries: [link("both"), link("solo")] },
      pi: { exists: true, entries: [link("both")] },
    },
    alsoReads: { pi: [link("both"), link("solo")] },
    alsoDirs: { pi: { both: "/h/.agents/skills", solo: "/h/.agents/skills" } },
    tools: { node: "/bin/node" },
    docs: Object.fromEntries(["both", "solo", "gone"].map((n) => [`H-${n}`, skillMd(n)])),
  };
  const piSettings = (skills: string[]) => ({ "pi-settings": JSON.stringify({ theme: "light", skills }) });
  const excl = (inv: Inventory) => planFor(c, skills, host, inv).filter((o) => o.op === "exclude" || o.op === "unexclude" || o.op === "blocked");

  test("a codex-only skill linked in ~/.agents/skills is excluded for pi; nothing else is touched", () => {
    expect(excl(base)).toEqual([{ op: "exclude", host: "mini", agent: "pi", skill: "solo" }]);
  });
  test("a codex-only skill this sync is about to link is excluded in the same sync", () => {
    const fresh: Inventory = { ...base, agentDirs: { ...base.agentDirs, codex: { exists: true, entries: [link("both")] } }, alsoReads: { pi: [link("both")] } };
    const ops = planFor(c, skills, host, fresh);
    expect(ops).toContainEqual({ op: "link", host: "mini", agent: "codex", skill: "solo" });
    expect(ops).toContainEqual({ op: "exclude", host: "mini", agent: "pi", skill: "solo" });
  });
  test("already excluded ⇒ no op; skm-form exclusions of managed skills that no longer apply are removed; the user's own entries stay", () => {
    expect(excl({ ...base, files: piSettings(["-skills/solo", "-skills/mine", "~/.agents/skills/x"]) })).toEqual([]);
    // both: pi wants it again; gone: claude-only, never lands in ~/.agents/skills
    expect(excl({ ...base, files: piSettings(["-skills/solo", "-skills/both", "-skills/gone", "-skills/mine"]) })).toEqual([
      { op: "unexclude", host: "mini", agent: "pi", skill: "both" },
      { op: "unexclude", host: "mini", agent: "pi", skill: "gone" },
    ]);
  });
  test("a store link codex no longer wants is unlinked this sync, so its exclusion goes with it", () => {
    const stale: Inventory = { ...base, agentDirs: { ...base.agentDirs, codex: { exists: true, entries: [link("both"), link("solo"), link("gone")] } }, alsoReads: { pi: [link("both"), link("solo"), link("gone")] }, alsoDirs: { pi: { ...base.alsoDirs["pi"], gone: "/h/.agents/skills" } }, files: piSettings(["-skills/solo", "-skills/gone"]) };
    const ops = planFor(c, skills, host, stale);
    expect(ops).toContainEqual({ op: "unlink", host: "mini", agent: "codex", skill: "gone" });
    expect(excl(stale)).toEqual([{ op: "unexclude", host: "mini", agent: "pi", skill: "gone" }]);
  });
  test("a real dir someone else wrote into ~/.agents/skills stays, so it stays excluded; without node the edit is blocked", () => {
    const real: Inventory = { ...base, agentDirs: { ...base.agentDirs, codex: { exists: true, entries: [link("both"), { kind: "dir", name: "gone", hash: "H-gone" }, link("solo")] } }, alsoReads: { pi: [link("both"), link("solo"), { kind: "dir", name: "gone", hash: "H-gone" }] }, alsoDirs: { pi: { ...base.alsoDirs["pi"], gone: "/h/.agents/skills" } } };
    expect(excl(real).map((o) => (o.op === "exclude" ? o.skill : o.op))).toEqual(["gone", "solo"]);
    expect(excl({ ...base, tools: {} })).toEqual([{ op: "blocked", host: "mini", agent: "pi", what: "exclude solo", reason: "node not found on mini; cannot edit pi settings" }]);
  });
});

describe("supported product agents", () => {
  test("old config cannot add unsupported columns, probe dirs, or sync targets", async () => {
    const skm = mkdtempSync(join(SCRATCH, "skm-agents-"));
    try {
      mkdirSync(join(skm, "skills/alpha"), { recursive: true });
      writeFileSync(join(skm, "skills/alpha/SKILL.md"), skillMd("alpha"));
      writeFileSync(join(skm, "config.yaml"), `store: ${skm}/skills\nagents: [claude, codex, pi, dsh, cursor, unknown]\nhosts: { local: {}, dev: { ssh: dev, agents: [pi, dsh, cursor] } }\n`);
      const loaded = await loadApp(skm);
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
      const app = loaded.value;
      expect(app.config.agents).toEqual(["claude", "codex", "pi"]);
      expect(app.unknownAgents).toEqual(["dsh", "cursor", "unknown"]);
      const h = app.config.hosts[1]!;
      expect(agentDirsRel(agentsOn(app.config, h))).toEqual({ pi: "~/.pi/agent/skills" });
      const inv = await probeHost(h, agentsOn(app.config, h), localRunner(skm));
      if (!inv.ok) throw new Error(JSON.stringify(inv.error));
      const ops = planFor(app.config, app.skills, h, inv.value);
      expect(ops.filter(o => o.op === "link").map(o => o.agent)).toEqual(["pi"]);
      expect(backupPathsFor(h, agentsOn(app.config, h))).toEqual(["~/.skm/skills", "~/.pi/agent/skills", "~/.agents/skills", "~/.pi/agent/settings.json"]);
    } finally {
      rmSync(skm, { recursive: true, force: true });
    }
  });

  test("fresh config plans skills for Claude Code, Codex, and Pi", () => {
    const c = defaultConfig();
    expect(agentDirsRel(agentsOn(c, c.hosts[0]!))).toEqual({
      claude: "~/.claude/skills", codex: "~/.agents/skills", pi: "~/.pi/agent/skills",
    });
  });
});

describe("shell integration: hub → fake remote (separate HOME)", () => {
  let hub = ""; let remote = "";
  beforeAll(() => {
    hub = mkdtempSync(join(SCRATCH, "skm-hub-"));
    remote = mkdtempSync(join(SCRATCH, "skm-remote-"));
    for (const n of ["alpha", "beta", "gamma"]) {
      mkdirSync(join(hub, ".skm/skills", n, "references"), { recursive: true });
      writeFileSync(join(hub, ".skm/skills", n, "SKILL.md"), skillMd(n));
      writeFileSync(join(hub, ".skm/skills", n, "references/r.md"), "ref");
    }
    mkdirSync(join(hub, ".skm/skills/noskill"), { recursive: true });
    // remote already has a stale alpha and a remote-only skill, plus a real dir in claude
    mkdirSync(join(remote, ".skm/skills/alpha"), { recursive: true });
    writeFileSync(join(remote, ".skm/skills/alpha/SKILL.md"), "old");
    mkdirSync(join(remote, ".skm/skills/zeta"), { recursive: true });
    writeFileSync(join(remote, ".skm/skills/zeta/SKILL.md"), skillMd("zeta"));
    mkdirSync(join(remote, ".claude/skills/localonly"), { recursive: true });
    symlinkSync(join(remote, ".skm/skills/zeta"), join(remote, ".claude/skills/zeta"));
  });

  const cfg = () => ({
    ...defaultConfig(),
    hosts: [
      { id: "local", ssh: none, agents: none, skm: "~/.skm" },
      { id: "dev", ssh: some("dev"), agents: some(["claude", "codex"]), skm: "~/.skm" },
    ] as HostConfig[],
    rules: [{ skills: ["gamma"], hosts: some({ kind: "except" as const, globs: ["dev"] }), agents: none, on: [], off: [] }],
  });
  const devHost = () => cfg().hosts[1]!;
  // a "remote" that is really a second HOME on this machine
  const fakeSsh = () => ({ ...localRunner(remote), id: "dev", kind: "ssh" as const });

  test("loadStore reads skills and ignores dirs without SKILL.md", async () => {
    const r = await loadStore(join(hub, ".skm/skills"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.skills.map((s) => s.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(r.value.ignored).toEqual(["noskill"]);
    expect(r.value.skills[0]?.cost.fileCount).toBe(2);
  });

  test("probe → plan → execute → re-probe is a fixpoint", async () => {
    const store = await loadStore(join(hub, ".skm/skills"));
    if (!store.ok) throw new Error();
    const c = cfg(); const h = devHost(); const agents = agentsOn(c, h); const runner = fakeSsh();
    const inv1 = await probeHost(h, agents, runner);
    expect(inv1.ok).toBe(true);
    if (!inv1.ok) return;
    const ops = planFor(c, store.value.skills, h, inv1.value);
    const kinds = ops.map((o) => o.op);
    expect(kinds).toContain("rsync-skill");
    expect(kinds).toContain("remote-only");
    expect(ops.filter((o) => o.op === "rsync-skill").map((o) => (o.op === "rsync-skill" ? o.skill : ""))).toEqual(["alpha", "beta"]); // gamma excluded on dev
    expect(ops.some((o) => o.op === "conflict" && o.skill === "localonly")).toBe(false); // not desired → not a conflict
    expect(ops.some((o) => o.op === "unlink")).toBe(false); // zeta link points into the remote store but the hub does not own zeta → untouched
    const report = await executePlan({ host: h, ops, runner, hubStore: join(hub, ".skm/skills"), agentDirs: agentDirsRel(agents), replaceConflictsInto: undefined, log: () => {} });
    expect(report.error).toBeUndefined();
    expect(report.rsynced).toEqual(["alpha", "beta"]);
    expect(await Bun.file(join(remote, ".skm/skills/alpha/SKILL.md")).text()).toContain("name: alpha");
    expect(existsSync(join(remote, ".skm/skills/alpha/references/r.md"))).toBe(true);
    expect(existsSync(join(remote, ".skm/skills/zeta"))).toBe(true); // remote-only untouched
    expect(readlinkSync(join(remote, ".claude/skills/alpha"))).toBe(join(remote, ".skm/skills/alpha"));
    expect(readlinkSync(join(remote, ".agents/skills/beta"))).toBe(join(remote, ".skm/skills/beta"));
    expect(existsSync(join(remote, ".claude/skills/gamma"))).toBe(false);
    const inv2 = await probeHost(h, agents, runner);
    if (!inv2.ok) throw new Error();
    const ops2 = planFor(c, store.value.skills, h, inv2.value);
    expect(ops2.filter((o) => o.op !== "remote-only")).toEqual([]);
  });

  test("backup + restore round trip on the fake remote", async () => {
    const c = cfg(); const h = devHost(); const runner = fakeSsh();
    writeFileSync(join(remote, ".skm/skills/alpha/SKILL.md"), skillMd("alpha"));
    const paths = backupPathsFor(h, agentsOn(c, h));
    expect(paths).toContain("~/.codex/skills");
    const b = await backupHost(h, runner, paths, join(hub, ".skm"), "20260906-010101");
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(existsSync(join(hub, ".skm/backups/dev/20260906-010101/restore.sh"))).toBe(true);
    const list = await listBackups(h, runner);
    expect(list.ok && list.value.map((x) => x.ts)).toEqual(["20260906-010101"]);
    writeFileSync(join(remote, ".skm/skills/alpha/SKILL.md"), "tampered");
    expect(existsSync(join(remote, ".claude/skills/zeta"))).toBe(true);
    const r = await restoreHost(h, runner, "20260906-010101");
    expect(r.ok).toBe(true);
    expect(await Bun.file(join(remote, ".skm/skills/alpha/SKILL.md")).text()).toContain("name: alpha");
  });

  test("unreachable host surfaces as HostError", async () => {
    const h: HostConfig = { id: "ghost", ssh: some("ghost"), agents: none, skm: "~/.skm" };
    const bad = { id: "ghost", kind: "ssh" as const, sh: async () => ({ ok: false as const, error: { kind: "exit" as const, code: 255, stdout: "", stderr: "ssh: no route" } }), rsyncPath: (p: string) => p };
    const a = agentById("claude"); if (!a.some) throw new Error();
    const r = await probeHost(h, [a.value], bad);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("unreachable");
  });
});

describe("pluginCellsFor", () => {
  const cfg = parseConfig(`
hosts: { local: {} }
agents: [claude, codex]
plugins:
  off: { marketplace: claude-extras, enabled: false, agents: { only: [codex] } }
  on: { marketplace: claude-extras }
`);
  test("enabled: false makes every cell unwanted, whatever the selectors say", () => {
    expect(cfg.ok).toBe(true);
    if (!cfg.ok) return;
    const host = cfg.value.hosts[0]!;
    const cells = pluginCellsFor(cfg.value, host, {});
    expect(cells.map((c) => `${c.agent}:${c.name}=${c.wanted}`).sort()).toEqual(["claude:off=false", "claude:on=true", "codex:off=false", "codex:on=true"]);
  });
});
