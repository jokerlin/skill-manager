import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { none, some } from "../src/lib/result";
import { defaultConfig, type HostConfig } from "../src/core/config";
import { agentById } from "../src/core/agents";
import { loadStore } from "../src/shell/store";
import { localRunner } from "../src/shell/runner";
import { probeHost } from "../src/shell/probe";
import { planFor, agentsOn, agentDirsRel, backupPathsFor } from "../src/shell/hosts";
import { executePlan } from "../src/shell/sync";
import { backupHost, restoreHost, listBackups } from "../src/shell/backup";

const SCRATCH = process.env["CLAUDE_SCRATCHPAD"] ?? tmpdir();
const skillMd = (n: string) => `---\nname: ${n}\ndescription: ${n} does things. Use when ${n}.\n---\n# ${n}\n`;

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
