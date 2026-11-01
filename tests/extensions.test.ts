import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgent } from "../src/core/agents";
import { parseConfig } from "../src/core/config";
import { buildRegistry, builtinRegistry, parseExtension } from "../src/core/extensions";
import { patchConfig } from "../src/core/patch";
import { withExtensions } from "../src/shell/extensions";

const OPENCODE = `
agents:
  - id: opencode
    name: OpenCode
    skillsDir: ~/.config/opencode/skills
    alsoReads: [~/.claude/skills]
    cli: { bin: opencode, update: opencode upgrade }
`;

// a file written for skm 0.5, with the tools: key 0.6 dropped
const LEGACY_TOOLS = `${OPENCODE}tools:
  - id: magpie
    update: magpie update
`;

describe("extensions", () => {
  test("parses agents, with defaults filled in", () => {
    const r = parseExtension(OPENCODE, "/x/mine.yaml", "mine");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.name).toBe("mine");
    expect(r.value.agents[0]).toEqual({ id: "opencode", name: "OpenCode", skillsDir: "~/.config/opencode/skills", alsoReads: ["~/.claude/skills"], cli: { bin: "opencode", update: "opencode upgrade" } });
    expect(r.value.warnings).toEqual([]);
  });

  test("a retired tools: key loads with a warning and keeps the rest of the file", () => {
    const r = parseExtension(LEGACY_TOOLS, "/x/mine.yaml", "mine");
    if (!r.ok) throw new Error(r.error);
    expect(r.value.agents.map((a) => a.id)).toEqual(["opencode"]);
    expect(r.value.warnings).toEqual(["tools: is no longer read (skm 0.6 dropped extension tools); skm ignores it, delete it from this file"]);
    const reg = buildRegistry([r.value]);
    expect(reg.extensions[0]).toMatchObject({ name: "mine", enabled: true, error: null, warnings: r.value.warnings });
  });

  test("reports the first problem with its path", () => {
    expect(parseExtension("agents: [{ id: Bad }]", "f", "f")).toEqual({ ok: false, error: "agents[0].id: expected an id (lowercase letters, digits, dashes)" });
    expect(parseExtension("agents: [{ id: x }]", "f", "f")).toEqual({ ok: false, error: "agents[0].skillsDir: expected a non-empty string" });
    expect(parseExtension("hooks: {}", "f", "f")).toEqual({ ok: false, error: "unknown keys: hooks" });
  });

  test("an extension agent resolves like a built-in one, as a plain-listing agent", () => {
    const ext = parseExtension(OPENCODE, "f", "mine");
    if (!ext.ok) throw new Error(ext.error);
    const reg = buildRegistry([ext.value]);
    const a = resolveAgent("opencode", {}, reg.agents);
    expect(a.some && a.value.userDir("/home/u")).toBe("/home/u/.config/opencode/skills");
    expect(a.some && a.value.alsoReads.map((f) => f("/home/u"))).toEqual(["/home/u/.claude/skills"]);
    expect(a.some && a.value.listing).toEqual({ kind: "plain" });
    expect(a.some && a.value.extension).toBe("mine");
  });

  test("the Codex desktop app (ChatGPT.app) is part of the built-in codex agent, not an extension", () => {
    const reg = builtinRegistry();
    expect(reg.agents.find((a) => a.id === "codex")?.app).toMatchObject({ id: "chatgpt", bundle: "/Applications/ChatGPT.app", marketplaces: ["openai-bundled", "openai-primary-runtime"] });
    expect(reg.extensions).toEqual([]);
  });

  test("a retired apps: key loads with a warning and attaches nothing", () => {
    const r = parseExtension("apps: [{ id: myapp, agent: codex, bundle: /A.app, feed: https://x, marker: m }]", "f", "old");
    if (!r.ok) throw new Error(r.error);
    expect(r.value.warnings).toHaveLength(1);
    expect(r.value.warnings[0]).toStartWith("apps: is no longer read");
    expect(buildRegistry([r.value]).agents.find((a) => a.id === "codex")?.app?.id).toBe("chatgpt");
  });

  test("an extension that reuses an id is skipped whole and says why", () => {
    const clash = parseExtension("agents: [{ id: claude, skillsDir: ~/x }, { id: other, skillsDir: ~/y }]", "f", "clash");
    if (!clash.ok) throw new Error(clash.error);
    const reg = buildRegistry([clash.value]);
    expect(reg.agents.map((a) => a.id)).not.toContain("other");
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
