import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readlinkSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeScript, applyScript, backupScript, shPath } from "../src/core/scripts";
import { parseProbeOutput } from "../src/core/inventory";

const SCRATCH = process.env["CLAUDE_SCRATCHPAD"] ?? tmpdir();

const sh = async (script: string, home: string): Promise<{ code: number; out: string; err: string }> => {
  const p = Bun.spawn(["sh", "-s"], { stdin: new TextEncoder().encode(script), env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};

describe("shPath", () => {
  test("home-relative and absolute", () => {
    expect(shPath("~/.skm/skills")).toBe(`"$HOME"/'.skm/skills'`);
    expect(shPath("/abs/p")).toBe(`'/abs/p'`);
  });
});

describe("probe + apply + backup on a real temp HOME", () => {
  let home = "";
  let foreignTarget = "";
  beforeAll(() => {
    home = mkdtempSync(join(SCRATCH, "skm-home-"));
    foreignTarget = mkdtempSync(join(SCRATCH, "skm-foreign-"));
    mkdirSync(join(home, ".skm/skills/alpha"), { recursive: true });
    writeFileSync(join(home, ".skm/skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: a\n---\n");
    mkdirSync(join(home, ".skm/skills/beta"), { recursive: true });
    writeFileSync(join(home, ".skm/skills/beta/SKILL.md"), "---\nname: beta\ndescription: b\n---\n");
    mkdirSync(join(home, ".claude/skills/real"), { recursive: true });
    symlinkSync(join(home, ".skm/skills/alpha"), join(home, ".claude/skills/alpha"));
    symlinkSync("../../.skm/skills/beta", join(home, ".claude/skills/viarel")); // relative, resolves into store
    symlinkSync(foreignTarget, join(home, ".claude/skills/foreign"));
    symlinkSync(join(home, "nowhere"), join(home, ".claude/skills/broken"));
    writeFileSync(join(home, ".claude/skills/notes.txt"), "x");
    mkdirSync(join(home, ".codex/skills/kb-doc"), { recursive: true });
  });

  const agentDirs = { claude: "~/.claude/skills", codex: "~/.agents/skills" };
  const alsoReads = { codex: ["~/.codex/skills"] };

  test("probe classifies everything", async () => {
    const r = await sh(probeScript({ skm: "~/.skm", agentDirs, alsoReads }), home);
    expect(r.code).toBe(0);
    const inv = parseProbeOutput(r.out, join(home, ".skm/skills"));
    expect(inv.ok).toBe(true);
    if (!inv.ok) return;
    expect(inv.value.home).toBe(home);
    expect(inv.value.storeSkills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(inv.value.storeSkills[0]?.hash.length).toBeGreaterThan(8);
    const c = Object.fromEntries((inv.value.agentDirs["claude"]?.entries ?? []).map((e) => [e.name, e]));
    expect(c["alpha"]).toEqual({ kind: "managed", name: "alpha", direct: true });
    expect(c["viarel"]).toEqual({ kind: "managed", name: "viarel", direct: false });
    expect(c["real"]?.kind).toBe("dir");
    expect(c["foreign"]?.kind).toBe("foreign-link");
    expect(c["broken"]?.kind).toBe("broken-link");
    expect(c["notes.txt"]?.kind).toBe("file");
    expect(inv.value.agentDirs["codex"]?.exists).toBe(false);
    expect(inv.value.alsoReads["codex"]?.map((e) => e.name)).toEqual(["kb-doc"]);
  });

  test("apply links, unlinks, skips real dirs, idempotent", async () => {
    const script = applyScript({
      skm: "~/.skm",
      agentDirs,
      replaceConflictsInto: undefined,
      ops: [
        { op: "mkdir", host: "local", path: "~/.agents/skills" },
        { op: "unlink", host: "local", agent: "claude", skill: "alpha" },
        { op: "link", host: "local", agent: "claude", skill: "beta" },
        { op: "link", host: "local", agent: "codex", skill: "alpha" },
        { op: "link", host: "local", agent: "claude", skill: "real" },
        { op: "conflict", host: "local", agent: "claude", skill: "foreign", entry: { kind: "foreign-link", name: "foreign", target: "/x" } },
      ],
    });
    const r1 = await sh(script, home);
    expect(r1.code).toBe(0);
    expect(existsSync(join(home, ".claude/skills/alpha"))).toBe(false);
    expect(readlinkSync(join(home, ".claude/skills/beta"))).toBe(join(home, ".skm/skills/beta"));
    expect(readlinkSync(join(home, ".agents/skills/alpha"))).toBe(join(home, ".skm/skills/alpha"));
    expect(lstatSync(join(home, ".claude/skills/real")).isDirectory()).toBe(true);
    expect(r1.err).toContain("real directory");
    expect(r1.out).toContain("conflict claude/foreign");
    const r2 = await sh(script, home);
    expect(r2.code).toBe(0);
    expect(readlinkSync(join(home, ".claude/skills/beta"))).toBe(join(home, ".skm/skills/beta"));
  });

  test("replace-conflicts moves the real dir aside then links", async () => {
    const script = applyScript({
      skm: "~/.skm",
      agentDirs,
      replaceConflictsInto: "~/.skm/backups/T/conflicts",
      ops: [{ op: "conflict", host: "local", agent: "claude", skill: "real", entry: { kind: "dir", name: "real" } }],
    });
    // 'real' is not in the store; the link will dangle, which is fine for this test of the move
    const r = await sh(script, home);
    expect(r.code).toBe(0);
    expect(existsSync(join(home, ".skm/backups/T/conflicts/claude__real"))).toBe(true);
    expect(lstatSync(join(home, ".claude/skills/real")).isSymbolicLink()).toBe(true);
  });

  test("backup then restore returns to the snapshot state", async () => {
    const paths = ["~/.skm/skills", "~/.claude/skills", "~/.agents/skills", "~/.cursor/skills"]; // cursor absent
    const b = await sh(backupScript({ skm: "~/.skm", ts: "20260906-000000", paths }), home);
    expect(b.code).toBe(0);
    expect(b.out).toContain("backup\t");
    const bdir = join(home, ".skm/backups/20260906-000000");
    expect(existsSync(join(bdir, "restore.sh"))).toBe(true);
    const manifest = await Bun.file(join(bdir, "manifest.txt")).text();
    expect(manifest).toContain("present\t.claude/skills");
    expect(manifest).toContain("absent\t.cursor/skills");
    // mutate: delete a link, add a dir that did not exist
    rmSync(join(home, ".claude/skills/beta"));
    mkdirSync(join(home, ".cursor/skills/junk"), { recursive: true });
    writeFileSync(join(home, ".skm/skills/alpha/SKILL.md"), "changed");
    const r = await sh(await Bun.file(join(bdir, "restore.sh")).text().then((t) => t.replace('$(cd "$(dirname "$0")" && pwd)', bdir)), home);
    expect(r.code).toBe(0);
    expect(readlinkSync(join(home, ".claude/skills/beta"))).toBe(join(home, ".skm/skills/beta"));
    expect(existsSync(join(home, ".cursor/skills"))).toBe(false);
    expect(await Bun.file(join(home, ".skm/skills/alpha/SKILL.md")).text()).toContain("name: alpha");
  });
});
