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
    expect(c["alpha"]).toMatchObject({ kind: "managed", name: "alpha", direct: true });
    expect(c["alpha"]?.kind === "managed" && c["alpha"].hash?.length).toBeGreaterThan(8);
    expect(c["viarel"]).toMatchObject({ kind: "managed", name: "viarel", direct: false });
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

describe("probe v2: plugins, builtins, config files, tools, docs", () => {
  let home = "";
  const md = (n: string, body = "do it") => `---\nname: ${n}\ndescription: ${n} desc. Use when ${n}.\n---\n${body}\n`;
  beforeAll(() => {
    home = mkdtempSync(join(SCRATCH, "skm-v2-"));
    const w = (rel: string, text: string) => { mkdirSync(join(home, rel, ".."), { recursive: true }); writeFileSync(join(home, rel), text); };
    w(".claude/skills/acme/SKILL.md", md("acme"));
    w(".claude/plugins/cache/mk/superpowers/6.3.0/skills/brainstorming/SKILL.md", md("brainstorming"));
    w(".claude/plugins/cache/mk/superpowers/6.2.0/skills/brainstorming/SKILL.md", md("brainstorming", "old"));
    w(".claude/plugins/cache/mk/superpowers/6.3.0/node_modules/x/skills/hidden/SKILL.md", md("hidden"));
    w(".codex/plugins/cache/mk/superpowers/6.3.0/skills/brainstorming/SKILL.md", md("brainstorming")); // same content as claude's 6.3.0
    w(".codex/skills/.system/imagegen/SKILL.md", md("imagegen"));
    w(".codex/skills/hatch-pet/SKILL.md", md("hatch-pet"));
    w(".claude/settings.json", JSON.stringify({ enabledPlugins: { "superpowers@mk": true } }));
    w(".codex/config.toml", '[plugins."superpowers@mk"]\nenabled = true\n');
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, ".local/bin/claude"), "#!/bin/sh\necho fake\n", { mode: 0o755 });
  });
  test("probe emits every v2 line kind and dedupes docs by hash", async () => {
    const r = await sh(probeScript({
      skm: "~/.skm", agentDirs: { claude: "~/.claude/skills", codex: "~/.agents/skills" }, alsoReads: { codex: ["~/.codex/skills"] },
      pluginCaches: { claude: "~/.claude/plugins/cache", codex: "~/.codex/plugins/cache" }, builtinDirs: { codex: "~/.codex/skills/.system" },
      files: { "claude-settings": "~/.claude/settings.json", "codex-config": "~/.codex/config.toml", "agents-lock": "~/.agents/.skill-lock.json" },
      tools: ["claude", "definitely-not-a-tool"],
    }), home);
    expect(r.code).toBe(0);
    const inv = parseProbeOutput(r.out, join(home, ".skm/skills"));
    expect(inv.ok).toBe(true);
    if (!inv.ok) return;
    const v = inv.value;
    expect(v.tools).toEqual({ claude: join(home, ".local/bin/claude") });
    expect(Object.keys(v.files).sort()).toEqual(["claude-settings", "codex-config"]);
    expect(JSON.parse(v.files["claude-settings"] ?? "{}")).toEqual({ enabledPlugins: { "superpowers@mk": true } });
    expect(v.pluginCache.map((p) => `${p.agent}:${p.plugin}@${p.marketplace}/${p.version}`).sort()).toEqual(["claude:superpowers@mk/6.2.0", "claude:superpowers@mk/6.3.0", "codex:superpowers@mk/6.3.0"]);
    expect(v.pluginSkills.map((p) => `${p.agent}:${p.version}:${p.name}`).sort()).toEqual(["claude:6.2.0:brainstorming", "claude:6.3.0:brainstorming", "codex:6.3.0:brainstorming"]);
    expect(v.pluginSkills.every((p) => p.dir.endsWith(`/${p.version}`) && p.skillDir.endsWith("/skills/brainstorming"))).toBe(true);
    expect(v.builtins.map((b) => b.name)).toEqual(["imagegen"]);
    // .system is a dot dir → not an `also` entry; hatch-pet is
    expect(v.alsoReads["codex"]?.map((e) => e.name)).toEqual(["hatch-pet"]);
    // docs: acme, brainstorming(new), brainstorming(old), imagegen, hatch-pet = 5 distinct; claude+codex 6.3.0 share one hash
    expect(Object.keys(v.docs).length).toBe(5);
    const hashes = v.pluginSkills.filter((p) => p.version === "6.3.0").map((p) => p.hash);
    expect(new Set(hashes).size).toBe(1);
    expect(v.docs[hashes[0] ?? ""]).toContain("name: brainstorming");
    const acme = v.agentDirs["claude"]?.entries.find((e) => e.name === "acme");
    expect(acme?.kind === "dir" && v.docs[acme.hash ?? ""]).toContain("name: acme");
  });
});

describe("commandsScript: codex config.toml switch + per-op ok/fail lines", () => {
  let home = "";
  beforeAll(() => {
    home = mkdtempSync(join(SCRATCH, "skm-cmd-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex/config.toml"), 'model = "x"\n\n[plugins."a@mk"]\nenabled = true\n\n[plugins."b@mk"]\nmcp_servers = {}\n\n[projects."/p"]\ntrust_level = "trusted"\n');
  });
  test("disable existing, enable table without enabled key, append missing table; idempotent; failures reported per op", async () => {
    const { commandsScript, parseCommandOutput } = await import("../src/core/scripts");
    const script = commandsScript([
      { op: "plugin-disable", host: "h", agent: "codex", plugin: "a@mk" },
      { op: "plugin-enable", host: "h", agent: "codex", plugin: "b@mk" },
      { op: "plugin-enable", host: "h", agent: "codex", plugin: "c@mk" },
      { op: "owned-ensure", host: "h", skill: "s", tool: "t", command: "exit 3" },
      { op: "owned-ensure", host: "h", skill: "ok", tool: "t", command: "true" },
      { op: "link", host: "h", agent: "codex", skill: "ignored" },
    ]);
    const r1 = await sh(script, home);
    expect(r1.code).toBe(0);
    const res = parseCommandOutput(r1.out);
    expect(res.map((c) => `${c.ok ? "ok" : "fail"}:${c.label}`)).toEqual(["ok:codex: plugin disable a@mk", "ok:codex: plugin enable b@mk", "ok:codex: plugin enable c@mk", "fail:t: ensure s", "ok:t: ensure ok"]);
    const text = await Bun.file(join(home, ".codex/config.toml")).text();
    expect(text).toBe('model = "x"\n\n[plugins."a@mk"]\nenabled = false\n\n[plugins."b@mk"]\nmcp_servers = {}\nenabled = true\n\n[projects."/p"]\ntrust_level = "trusted"\n\n[plugins."c@mk"]\nenabled = true\n');
    const r2 = await sh(script, home);
    expect(r2.code).toBe(0);
    expect(await Bun.file(join(home, ".codex/config.toml")).text()).toBe(text);
  });
});
