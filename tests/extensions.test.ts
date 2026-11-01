import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgent } from "../src/core/agents";
import { parseConfig } from "../src/core/config";
import { BUILTIN_EXTENSIONS, buildRegistry, builtinRegistry, parseExtension } from "../src/core/extensions";
import { patchConfig } from "../src/core/patch";
import { withExtensions } from "../src/shell/extensions";

const OPENCODE = `
agents:
  - id: opencode
    name: OpenCode
    skillsDir: ~/.config/opencode/skills
    alsoReads: [~/.claude/skills]
    cli: { bin: opencode, update: opencode upgrade }
tools:
  - id: magpie
    update: magpie update
    onChange: magpie daemon restart
    hosts: { only: [mini] }
`;

describe("extensions", () => {
  test("parses agents and tools, with defaults filled in", () => {
    const r = parseExtension(OPENCODE, "/x/mine.yaml", "mine");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("mine");
    expect(r.value.agents[0]).toEqual({ id: "opencode", name: "OpenCode", skillsDir: "~/.config/opencode/skills", alsoReads: ["~/.claude/skills"], cli: { bin: "opencode", update: "opencode upgrade" } });
    expect(r.value.tools[0]).toMatchObject({ id: "magpie", bin: "magpie", onChange: "magpie daemon restart", hosts: { kind: "only", globs: ["mini"] } });
  });

  test("reports the first problem with its path", () => {
    expect(parseExtension("agents: [{ id: Bad }]", "f", "f")).toEqual({ ok: false, error: "agents[0].id: expected an id (lowercase letters, digits, dashes)" });
    expect(parseExtension("agents: [{ id: x }]", "f", "f")).toEqual({ ok: false, error: "agents[0].skillsDir: expected a non-empty string" });
    expect(parseExtension("hooks: {}", "f", "f")).toEqual({ ok: false, error: "unknown keys: hooks" });
    expect(parseExtension("apps: [{ id: a, agent: codex, bundle: /A.app, feed: http://x, marker: m }]", "f", "f")).toEqual({ ok: false, error: "apps[0].feed: expected an https URL" });
  });

  test("an extension agent resolves like a built-in one, as a plain-listing agent", () => {
    const ext = parseExtension(OPENCODE, "f", "mine");
    if (!ext.ok) throw new Error(ext.error);
    const reg = buildRegistry([...BUILTIN_EXTENSIONS, ext.value], []);
    const a = resolveAgent("opencode", {}, reg.agents);
    expect(a.some && a.value.userDir("/home/u")).toBe("/home/u/.config/opencode/skills");
    expect(a.some && a.value.alsoReads.map((f) => f("/home/u"))).toEqual(["/home/u/.claude/skills"]);
    expect(a.some && a.value.listing).toEqual({ kind: "plain" });
    expect(a.some && a.value.extension).toBe("mine");
    expect(reg.tools.map((t) => t.id)).toEqual(["magpie"]);
  });

  test("the built-in ChatGPT app attaches to Codex and can be switched off", () => {
    expect(builtinRegistry().agents.find((a) => a.id === "codex")?.app?.id).toBe("chatgpt");
    const off = builtinRegistry(["chatgpt-desktop"]);
    expect(off.agents.find((a) => a.id === "codex")?.app).toBeUndefined();
    expect(off.extensions.find((e) => e.name === "chatgpt-desktop")?.enabled).toBe(false);
  });

  test("an extension that reuses an id is skipped whole and says why", () => {
    const clash = parseExtension("agents: [{ id: claude, skillsDir: ~/x }]\ntools: [{ id: t1, update: x }]", "f", "clash");
    if (!clash.ok) throw new Error(clash.error);
    const reg = buildRegistry([clash.value], []);
    expect(reg.tools).toHaveLength(0);
    expect(reg.extensions[0]).toMatchObject({ name: "clash", enabled: false, error: "ids already in use: claude" });
  });

  test("config keeps extension agents through a patch, and rejects unknown ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skm-ext-"));
    await mkdir(join(dir, "extensions"));
    await writeFile(join(dir, "extensions", "mine.yaml"), OPENCODE);
    await writeFile(join(dir, "extensions", "broken.yml"), "agents: 3");
    const parsed = parseConfig("agents: [claude, opencode]\nhosts: { local: {} }\n");
    if (!parsed.ok) throw new Error("parse");
    const c = await withExtensions(dir, parsed.value);
    expect(c.registry.extensions.find((e) => e.name === "broken")).toMatchObject({ enabled: false, error: "agents: expected a list" });
    expect(patchConfig(c, { agents: ["claude", "opencode"] }).ok).toBe(true);
    expect(patchConfig(parsed.value, { agents: ["claude", "opencode"] }).ok).toBe(false);
  });
});
