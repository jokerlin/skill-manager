import { emptyInventory, type Entry } from "../src/core/inventory";
import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { cleanup, render } from "./ink";
import { Box } from "ink";
import { App } from "../src/tui/App";
import type { TuiIo } from "../src/tui/io";
import { ALL, type Config, defaultConfig } from "../src/core/config";
import { pluginWanted } from "../src/core/scope";
import { buildSkill } from "../src/core/skill";
import { agentById } from "../src/core/agents";
import { none, some } from "../src/lib/result";
import type { AppState } from "../src/shell/app";
import { inferRules, compressGlobs } from "../src/cli/rules";
import { pullCandidates } from "../src/cli/pull";
import { HostsView, clampOffset, findingLine, findingSummary, hostLines, toolStatus } from "../src/tui/views/Hosts";
import { toolVersions } from "../src/core/harness";
import type { HarnessHost } from "../src/shell/harness";
import { SkillsView } from "../src/tui/views/Skills";
import { cellGlyph, fitCount, harnessTools, initialState, pendingTotal, reduce, skillCoverage, visibleSkills } from "../src/tui/state";
import { coverageText, listTitle, upstreamMark, upstreamPrompt } from "../src/tui/views/Skills";
import type { StateKind, UpstreamPolicy } from "../src/core/upstream";
import type { SkillReport, UpstreamResult } from "../src/shell/upstreamOps";
import type { Op } from "../src/core/plan";
import { buildHostView } from "../src/core/view";

const mk = (name: string, desc: string) => buildSkill(name, `/s/${name}`, `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\nbody\n`, [{ rel: "SKILL.md", bytes: 10 }]);
const skills = [mk("pdf-tools", "Extract text from PDFs. Use when the user mentions PDFs."), mk("kb-doc", "飞书文档操作。当用户提供文档 URL 时使用。")];

const app = (): AppState => {
  const claude = agentById("claude"); const codex = agentById("codex");
  if (!claude.some || !codex.some) throw new Error();
  return {
    skmHome: "/tmp/skm", configPath: "/tmp/skm/config.yaml", config: { ...defaultConfig(), agents: ["claude", "codex"], hosts: [{ id: "local", ssh: none, agents: none, skm: "~/.skm" }, { id: "dev", ssh: some("dev"), agents: none, skm: "~/.skm" }] },
    storeDir: "/tmp/skm/skills", skills, ignoredDirs: [], agents: [claude.value, codex.value], unknownAgents: [], claudeOverrides: {}, hubMarketplaces: {},
  };
};

const io: TuiIo = {
  probe: async (h) => ({ ok: true, value: { ...emptyInventory("/h"), agentDirs: { claude: { exists: true, entries: [{ kind: "managed", name: "pdf-tools", direct: true }] }, codex: { exists: false, entries: [] } }, alsoReads: {} } }),
  plan: () => [{ op: "link", host: "dev", agent: "codex", skill: "pdf-tools" }],
  saveConfig: async () => {},
  backup: async () => ({ ok: true, value: "/h/.skm/backups/x" }),
  apply: async (h) => ({ host: h.id, rsynced: [], applied: ["link codex/pdf-tools"], skipped: [], conflicts: [], commands: [], error: undefined }),
  now: () => "20260906-000000",
  upstreams: async () => ({ ok: true, value: [] }),
  upstreamUpdate: async () => ({ ok: true, value: { backup: null, outcomes: [] } }),
  loadSkills: async () => ({ ok: true, value: skills }),
  harness: async () => [],
  harnessUpdate: async (h) => ({ host: h.id, at: "", error: null, results: [] }),
};

const tick = () => new Promise((r) => setTimeout(r, 30));
afterEach(cleanup);

test("target cells show a loaded shared skill instead of absent or pending", () => {
  const pi = agentById("pi");
  if (!pi.some) throw new Error("missing Pi");
  const inv = {
    ...emptyInventory("/h"),
    agentDirs: { pi: { exists: true, entries: [] } },
    alsoReads: { pi: [{ kind: "dir" as const, name: "acme", hash: "shared-acme" }] },
    alsoDirs: { pi: { acme: "/h/.agents/skills" } },
    docs: { "shared-acme": "---\nname: acme\ndescription: Use corp tools.\n---\n" },
  };
  const view = buildHostView("local", [pi.value], inv, 1_000_000);
  const s = { ...initialState(defaultConfig(), []), hosts: { local: { kind: "ready" as const, inventory: inv, ops: [], view } } };
  expect(cellGlyph(s, "acme", "local", "pi", true)).toEqual({ glyph: "✓", color: "green" });
  expect(cellGlyph(s, "acme", "local", "pi", false)).toEqual({ glyph: "✓", color: "yellow" });
  expect(cellGlyph(s, "missing", "local", "pi", true)).toEqual({ glyph: "◌", color: "yellow" });
  expect(cellGlyph(s, "missing", "local", "pi", false)).toEqual({ glyph: "○", color: "gray" });
});

test("target availability uses the same checkmark for real directories and links, and requires a loaded skill", () => {
  const claude = agentById("claude");
  if (!claude.some) throw new Error("missing Claude");
  const cases: { entry: Entry; glyph: string; color: "green" | "yellow" | "red" }[] = [
    { entry: { kind: "dir", name: "acme", hash: "available-acme" }, glyph: "✓", color: "green" },
    { entry: { kind: "managed", name: "acme", direct: true, hash: "available-acme" }, glyph: "✓", color: "green" },
    { entry: { kind: "foreign-link", name: "acme", target: "/cli/acme", hash: "available-acme" }, glyph: "✓", color: "green" },
    { entry: { kind: "dir", name: "acme" }, glyph: "◌", color: "yellow" },
    { entry: { kind: "broken-link", name: "acme", target: "/gone" }, glyph: "✗", color: "red" },
  ];
  for (const { entry, glyph, color } of cases) {
    const inv = { ...emptyInventory("/h"), agentDirs: { claude: { exists: true, entries: [entry] } }, docs: { "available-acme": "---\nname: acme\ndescription: Use corp tools.\n---\n" } };
    const view = buildHostView("local", [claude.value], inv, 1_000_000);
    const s = { ...initialState(defaultConfig(), []), hosts: { local: { kind: "ready" as const, inventory: inv, ops: [], view } } };
    expect(cellGlyph(s, "acme", "local", "claude", true)).toEqual({ glyph, color });
    if (color === "green") expect(cellGlyph(s, "acme", "local", "claude", false)).toEqual({ glyph: "✓", color: "yellow" });
  }
});

describe("TUI sort", () => {
  test("o cycles name → listing → body (costs descending first); O flips the direction; ties break by name", () => {
    const s0 = initialState(app().config, skills);
    expect(s0.sort).toEqual({ by: "name", dir: "asc" });
    expect(visibleSkills(s0).map((k) => k.name)).toEqual(["kb-doc", "pdf-tools"]);
    const byListingDesc = [...skills].sort((a, b) => b.cost.descTokens - a.cost.descTokens || a.name.localeCompare(b.name)).map((k) => k.name);
    const s1 = reduce(s0, { type: "cycleSort" });
    expect(s1.sort).toEqual({ by: "listing", dir: "desc" });
    expect(s1.selected).toBe(0);
    expect(visibleSkills(s1).map((k) => k.name)).toEqual(byListingDesc);
    const s2 = reduce(s1, { type: "flipSort" });
    expect(s2.sort).toEqual({ by: "listing", dir: "asc" });
    expect(visibleSkills(s2).map((k) => k.name)).toEqual([...byListingDesc].reverse());
    const s3 = reduce(s2, { type: "cycleSort" });
    expect(s3.sort).toEqual({ by: "body", dir: "desc" });
    expect(reduce(s3, { type: "cycleSort" }).sort).toEqual({ by: "name", dir: "asc" });
  });
});

describe("TUI", () => {
  test("renders skills, filters, and shows probe results in the header", async () => {
    const { lastFrame, stdin } = render(<App app={app()} io={io} />);
    await tick();
    expect(lastFrame()).toContain("pdf-tools");
    expect(lastFrame()).toContain("kb-doc");
    expect(lastFrame()).toContain("2 skills");
    stdin.write("/"); await tick();
    stdin.write("kb"); await tick();
    expect(lastFrame()).toContain("1 skills");
    expect(lastFrame()).not.toContain("pdf-tools ");
    stdin.write("\r"); await tick();
    stdin.write("\t"); await tick(); // hosts view
    expect(lastFrame()).toContain("hosts");
    stdin.write("4"); await tick(); // the changes view lists the plan
    expect(lastFrame()).toContain("link codex/pdf-tools");
  });
  test("targets grid toggle calls saveConfig", async () => {
    let saved = 0;
    const { lastFrame, stdin } = render(<App app={app()} io={{ ...io, saveConfig: async () => { saved += 1; } }} />);
    await tick();
    stdin.write("m"); await tick();
    stdin.write(" "); await tick();
    expect(saved).toBe(1);
    expect(lastFrame()).toContain("saved kb-doc local/claude"); // first in name order
  });
});

describe("rules infer", () => {
  test("common core gets no rule; subsets get only-rules with glob compression", () => {
    const hub = ["core", "corp-a", "corp-b", "corp-c", "solo"];
    const presence = new Map<string, Set<string>>([
      ["core", new Set(["local", "mini", "dev"])],
      ["corp-a", new Set(["mini", "dev"])], ["corp-b", new Set(["mini", "dev"])], ["corp-c", new Set(["mini", "dev"])],
      ["solo", new Set(["local"])],
    ]);
    const rules = inferRules(hub, presence, ["local", "mini", "dev"]);
    expect(rules.map((r) => [r.skills, r.hosts.some && r.hosts.value.kind === "only" ? r.hosts.value.globs : []])).toEqual([
      [["corp-*"], ["dev", "mini"]],
      [["solo"], ["local"]],
    ]);
    expect(compressGlobs(["corp-a", "corp-b"], ["corp-a", "corp-b", "corp-c"])).toEqual(["corp-a", "corp-b"]);
  });
});

describe("pull candidates", () => {
  test("store first, then unmanaged dirs, dedup, skip hub names", () => {
    const claude = agentById("claude"); const codex = agentById("codex");
    if (!claude.some || !codex.some) throw new Error();
    const inv = { ...emptyInventory("/h"), storeSkills: [{ name: "zeta", hash: "z" }], agentDirs: {
      claude: { exists: true, entries: [{ kind: "dir" as const, name: "zeta" }, { kind: "dir" as const, name: "only-claude" }, { kind: "managed" as const, name: "pdf", direct: true }, { kind: "dir" as const, name: "inhub" }] },
      codex: { exists: true, entries: [{ kind: "dir" as const, name: "only-claude" }, { kind: "foreign-link" as const, name: "repo", target: "/r" }] },
    } };
    const c = pullCandidates(inv, [claude.value, codex.value], "~/.skm", new Set(["inhub"]));
    expect(c).toEqual([
      { name: "zeta", source: ".skm/skills/zeta", via: "store" },
      { name: "only-claude", source: ".claude/skills/only-claude", via: "claude" },
    ]);
  });
});

describe("hosts view", () => {
  const hostsState = () => {
    const a = app();
    const inv = { ...emptyInventory("/h"), agentDirs: { claude: { exists: true, entries: [{ kind: "managed" as const, name: "pdf-tools", direct: true }] }, codex: { exists: true, entries: [{ kind: "dir" as const, name: "acme" }] } } };
    const view = buildHostView("local", a.agents, inv, 200000, {});
    const ready = { kind: "ready" as const, inventory: inv, ops: [], view };
    return { ...initialState(a.config, skills), hosts: { local: ready, dev: ready } };
  };
  test("renders one row per line and windows by height (no Yoga shrink overlap)", async () => {
    const s = hostsState();
    const lines = hostLines(s);
    // the agent CLIs section (title + one row per tool + gap), then per host: header + 2 agents × (row + loads) + gap
    expect(lines.length).toBe(harnessTools(s.config).length + 2 + 2 * (1 + 2 * 2 + 1));
    const full = render(<HostsView s={s} height={lines.length + 1} offset={0} />); await tick();
    const rows = (full.lastFrame() ?? "").split("\n");
    expect(rows.length).toBe(lines.length + 1);
    expect(rows.filter((r) => /loads \d+: user/.test(r)).length).toBe(4);
    expect(rows.filter((r) => r.includes("/h/.claude/skills")).length).toBe(2);
    full.unmount();
  });
  test("scrolls with a clamped offset and reports the window", async () => {
    const s = hostsState();
    const n = hostLines(s).length;
    const small = render(<HostsView s={s} height={5} offset={0} />); await tick();
    expect((small.lastFrame() ?? "").split("\n").length).toBe(5);
    expect(small.lastFrame()).toContain(`lines 1–4 of ${n}`);
    small.unmount();
    const scrolled = render(<HostsView s={s} height={5} offset={1_000} />); await tick();
    expect(scrolled.lastFrame()).toContain(`lines ${n - 3}–${n} of ${n}`);
    scrolled.unmount();
    expect(clampOffset(-5, 20, 5)).toBe(0);
    expect(clampOffset(99, 20, 5)).toBe(16);
  });
});

describe("skills view", () => {
  test("the list keeps its width next to a wide detail panel, and its header and rows stay on one line (no Yoga shrink)", async () => {
    const long = buildSkill("incident-runbook", `/private/tmp/${"very-long-directory-name/".repeat(6)}incident-runbook`, "---\nname: incident-runbook\ndescription: Walk through the on-call runbook.\n---\nbody\n", [{ rel: "SKILL.md", bytes: 10 }]);
    const s = initialState(app().config, [long, ...skills]);
    const r = render(<SkillsView s={s} width={100} height={20} />); await tick();
    const rows = (r.lastFrame() ?? "").split("\n");
    expect(rows.some((l) => /skill\s+listing\s+body/.test(l))).toBe(true);
    for (const name of ["incident-runbook", "pdf-tools", "kb-doc"]) expect(rows.some((l) => new RegExp(`${name}\\s+\\d+t\\s+\\S+t`).test(l))).toBe(true);
    expect(rows[0]?.indexOf("┐")).toBe(Math.floor(100 * 0.5) - 1); // the list keeps the width it asked for
    r.unmount();
  });
  test("names are cut to fit the narrowest list instead of wrapping the row", async () => {
    const s = initialState(app().config, [mk("a-skill-name-much-longer-than-the-list-allows", "Long name."), ...skills]);
    const r = render(<SkillsView s={s} width={60} height={12} />); await tick();
    const rows = (r.lastFrame() ?? "").split("\n");
    expect(rows[0]?.indexOf("┐")).toBe(34 - 1);
    expect(rows.some((l) => /a-skill-name\S*\s+\d+t\s+\S+t/.test(l))).toBe(true);
    expect(rows.some((l) => /skills · sort/.test(l) && /│$/.test(l.slice(0, 34)))).toBe(true);
    r.unmount();
  });
});

describe("skills detail in a short panel", () => {
  test("lines are cut at the border instead of drawn over each other (no Yoga shrink)", async () => {
    const desc = "Generate or update API reference docs from route handlers and types. Use when endpoints change or docs drift from the code.";
    const sk = buildSkill("api-docs", `/private/tmp/${"nested/".repeat(8)}api-docs`, `---\nname: api-docs\ndescription: ${desc}\n---\nbody\n`, [{ rel: "SKILL.md", bytes: 10 }]);
    const hosts = ["local", "studio", "laptop", "gpu-box"].map((id) => ({ id, ssh: id === "local" ? none : some(id), agents: none, skm: "~/.skm" }));
    const frame = async (h: number): Promise<string[]> => {
      const s = initialState({ ...app().config, agents: ["claude", "codex", "pi"], hosts }, [sk]);
      const r = render(<Box width={60} height={h}><SkillsView s={s} width={60} height={h} /></Box>); await tick();
      const lines = (r.lastFrame() ?? "").split("\n").map((l) => l.slice(l.indexOf("││") + 2));
      r.unmount();
      return lines;
    };
    const tall = await frame(60);
    const short = await frame(24);
    expect(short.length).toBe(24);
    expect(short.slice(1, 22)).toEqual(tall.slice(1, 22)); // the short panel shows the same first lines, nothing squeezed out
    expect(tall.some((l) => /^ code\.\s+│$/.test(l))).toBe(true);
  });
});

describe("one-line header and footer", () => {
  test("fitCount takes whole segments while they fit", () => {
    expect(fitCount([3, 4, 5], 12)).toBe(3);
    expect(fitCount([3, 4, 5], 11)).toBe(2);
    expect(fitCount([3, 9, 1], 5)).toBe(1); // stops at the first segment that does not fit
    expect(fitCount([], 10)).toBe(0);
  });
  test("with more hosts than the header can hold, it shows the ones that fit and +N, and every frame line stays one line", async () => {
    const base = app();
    const hosts = ["local", ...Array.from({ length: 7 }, (_, i) => `build-server-${i + 1}`)].map((id) => ({ id, ssh: id === "local" ? none : some(id), agents: none, skm: "~/.skm" }));
    const { lastFrame, unmount } = render(<App app={{ ...base, config: { ...base.config, hosts } }} io={io} />);
    await tick();
    const lines = (lastFrame() ?? "").split("\n");
    expect(lines[0]).toContain("5:help");
    expect(lines[0]).toMatch(/ \+6\s*$/); // 2 of 8 hosts fit next to the tabs in 100 columns
    expect(lines[0]).not.toContain("build-server-7");
    expect(lines[1]?.startsWith("┌")).toBe(true); // the header did not wrap onto a second line
    expect(lines.at(-1)).toMatch(/^j\/k move/); // the footer is still the last line
    unmount();
  });
});

describe("aligned with the desktop app", () => {
  // two hosts where superpowers is 6.3.0 on local and 6.1.1 on dev (Claude); Codex reads the Git marketplace "official"
  const pluginInv = (version: string, codexVersion = "6.3.0") => ({
    ...emptyInventory("/h"),
    tools: { claude: "/bin/claude", codex: "/bin/codex" },
    files: {
      "claude-settings": JSON.stringify({ enabledPlugins: { "superpowers@official": true } }),
      "claude-installed": JSON.stringify({ version: 2, plugins: { "superpowers@official": [{ scope: "user", installPath: `/h/.claude/plugins/cache/official/superpowers/${version}`, version }] } }),
      "codex-config": ['[marketplaces.official]', 'source_type = "git"', 'source = "https://example.com/official.git"', '[plugins."superpowers@official"]', 'enabled = true'].join("\n"),
    },
    pluginCache: [
      { agent: "claude", marketplace: "official", plugin: "superpowers", version, dir: `/h/.claude/plugins/cache/official/superpowers/${version}` },
      { agent: "codex", marketplace: "official", plugin: "superpowers", version: codexVersion, dir: `/h/.codex/plugins/cache/official/superpowers/${codexVersion}` },
    ],
  });
  const pluginIo = (applied: { host: string; ops: readonly Op[] }[], backups: string[]): TuiIo => ({
    ...io,
    probe: async (h) => ({ ok: true, value: pluginInv(h.id === "local" ? "6.3.0" : "6.1.1") }),
    backup: async (h) => { backups.push(h.id); return { ok: true, value: `/h/.skm/backups/${h.id}` }; },
    apply: async (h, ops) => { applied.push({ host: h.id, ops }); return { host: h.id, rsynced: [], applied: [], skipped: [], conflicts: [], commands: [], error: undefined }; },
  });

  test("view keys follow the app: 1 skills, 2 plugins, 3 hosts, 4 changes (with the pending count), 5 help", async () => {
    const { lastFrame, stdin, unmount } = render(<App app={app()} io={io} />); await tick();
    expect(lastFrame()?.split("\n")[0]).toMatch(/1:skills\s+2:plugins\s+3:hosts\s+4:changes 2\s+5:help/);
    stdin.write("4"); await tick();
    expect(lastFrame()).toContain("pending changes");
    expect(lastFrame()).toContain("dev: 1 change");
    stdin.write("\r"); await tick(); // Enter asks before applying
    expect(lastFrame()).toContain("apply now? y = yes");
    stdin.write("n"); await tick();
    expect(lastFrame()).not.toContain("apply now?");
    unmount();
  });

  test("plugins view shows drift; u asks, y backs up and updates the plugin on every host that has it", async () => {
    const applied: { host: string; ops: readonly Op[] }[] = [];
    const backups: string[] = [];
    const { lastFrame, stdin, unmount } = render(<App app={app()} io={pluginIo(applied, backups)} />); await tick();
    stdin.write("2"); await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("1 plugins · 1 drifting");
    expect(frame).toMatch(/superpowers\s+2 versions/);
    expect(frame).toContain("6.3.0 (newest)");
    expect(frame).toMatch(/dev\/claude\s+✓ on\s+6\.1\.1/);
    stdin.write("u"); await tick();
    expect(lastFrame()).toContain("update superpowers on local, dev? y = yes");
    stdin.write("y"); await tick(); await tick();
    expect(backups.sort()).toEqual(["dev", "local"]);
    expect(applied.map((a) => a.host).sort()).toEqual(["dev", "local"]);
    expect(applied.flatMap((a) => a.ops).some((o) => o.op === "plugin-update" && o.plugin === "superpowers@official")).toBe(true);
    expect(lastFrame()).toContain("pending changes"); // the log of what ran is in the changes view
    unmount();
  });

  test("m opens the plugin's cells; space flips one in config.yaml and keeps every other cell as it is", async () => {
    const saved: Config[] = [];
    const { lastFrame, stdin, unmount } = render(<App app={app()} io={{ ...pluginIo([], []), saveConfig: async (c) => { saved.push(c); } }} />); await tick();
    stdin.write("2"); await tick();
    stdin.write("m"); await tick();
    expect(lastFrame()).toContain("space toggles the highlighted cell");
    expect(lastFrame()).toMatch(/local\/claude\s+✓ on\s+6\.3\.0/);
    expect(lastFrame()).toMatch(/dev\/claude\s+✓ on\s+6\.1\.1/);
    stdin.write(" "); await tick(); await tick();
    expect(lastFrame()).toContain("saved plugin superpowers local/claude → off");
    expect(lastFrame()).toMatch(/local\/claude\s+◌ will disable\s+6\.3\.0/); // the version keeps its own column
    const policy = saved.at(-1)?.plugins.find((p) => p.name === "superpowers");
    expect(policy).toBeDefined();
    // a new policy lists today's enabled cells and leaves out the one switched off
    const wanted = (h: string, a: string) => (policy ? pluginWanted(policy, h, a) : undefined);
    expect([wanted("local", "claude"), wanted("local", "codex"), wanted("dev", "claude"), wanted("dev", "codex")]).toEqual([false, true, true, true]);
    stdin.write(" "); await tick(); await tick(); // flip back
    expect(lastFrame()).toMatch(/local\/claude\s+✓ on/);
    stdin.write("m"); await tick(); // back to the list: j moves plugins again
    expect(lastFrame()).toContain("(m to switch cells)");
    unmount();
  });

  test("a plugin with no policy cannot be flipped while a host is unreachable: its enabled cells there would be lost", async () => {
    const saved: Config[] = [];
    const halfIo: TuiIo = {
      ...pluginIo([], []),
      probe: async (h) => (h.id === "local" ? { ok: true, value: pluginInv("6.3.0") } : { ok: false, error: { kind: "ssh", host: "dev", message: "timeout" } as never }),
      saveConfig: async (c) => { saved.push(c); },
    };
    const { lastFrame, stdin, unmount } = render(<App app={app()} io={halfIo} />); await tick();
    stdin.write("2"); await tick();
    stdin.write("m"); await tick();
    stdin.write(" "); await tick();
    expect(lastFrame()).toContain("superpowers is not under plugins: yet, and dev is not probed");
    expect(saved).toEqual([]);
    unmount();
  });

  test("a plugin under plugins: that no host has yet is listed, with the cells the next apply enables", async () => {
    const base = app();
    const ghost = { name: "ghost", marketplace: { claude: "official" }, hosts: ALL, agents: ALL, enabled: true, on: [], off: [] };
    const { lastFrame, stdin, unmount } = render(<App app={{ ...base, config: { ...base.config, plugins: [ghost] } }} io={io} />); await tick();
    stdin.write("2"); await tick();
    expect(lastFrame()).toContain("ghost");
    expect(lastFrame()).toContain("not installed on any host yet");
    expect(lastFrame()).toMatch(/local\/claude\s+◌ will enable/);
    stdin.write("u"); await tick();
    expect(lastFrame()).toContain("ghost is not installed on any host");
    unmount();
  });

  test("plugins list shows a long version whole (Codex app plugins are 26.1027.51404, 13 characters)", async () => {
    const long = "26.1027.51404";
    const longIo: TuiIo = { ...io, probe: async () => ({ ok: true, value: pluginInv(long, long) }) };
    const { lastFrame, stdin, unmount } = render(<App app={app()} io={longIo} />); await tick();
    stdin.write("2"); await tick();
    expect(lastFrame()).toMatch(/superpowers\s+26\.1027\.51404/);
    unmount();
  });

  test("skills list shows where each skill is enabled, in the app's words, fitted to the column", () => {
    const base = app();
    const config = { ...base.config, rules: [{ skills: ["kb-doc"], hosts: some({ kind: "only" as const, globs: ["dev"] }), agents: none, on: [], off: [] }] };
    const s = initialState(config, skills);
    expect(skillCoverage(s, "pdf-tools")).toEqual({ kind: "everywhere" });
    expect(coverageText(skillCoverage(s, "kb-doc"), 20)).toBe("Only dev");
    expect(coverageText({ kind: "except-agents", agents: ["codex"] }, 20)).toBe("All but Codex");
    expect(coverageText({ kind: "only-hosts", hosts: ["studio", "gpu-box"] }, 12)).toBe("Only 2 hosts"); // names do not fit, so a count
    expect(coverageText({ kind: "partial", on: 7, total: 12 }, 20)).toBe("7 of 12");
    expect(pendingTotal(s)).toBe(0);
  });
});

describe("upstream state in the TUI", () => {
  const policy: UpstreamPolicy = { kind: "git", name: "waza", repo: "https://example.com/waza.git", ref: none, path: "skills/{skill}", skills: ["pdf-tools", "kb-doc"] };
  const change = (i: number) => ({ commit: `c${i}00000`, date: "2026-10-30", subject: `change ${i}` });
  const skillReport = (skill: string, kind: StateKind, changes: number): SkillReport => ({
    skill, state: { kind } as SkillReport["state"], base: some({ rev: "a".repeat(40), label: "v1.0.0", digest: "d" }), target: { rev: "b".repeat(40), label: "v1.2.0" }, targetDigest: some("t"), files: none,
    changes: Array.from({ length: changes }, (_, i) => change(i)),
  });
  const results: readonly UpstreamResult[] = [{
    policy,
    result: { ok: true, value: { policy, target: some({ rev: "b".repeat(40), label: "v1.2.0" }), warning: none, skills: [skillReport("pdf-tools", "behind", 7), skillReport("kb-doc", "modified", 1)], unlisted: [] } },
  }];
  /** The detail panel's text with its wrapping undone: the part of each row right of the list. */
  const detail = (frame: string | undefined): string =>
    (frame ?? "").split("\n").map((l) => l.split("││")[1] ?? "").map((l) => l.replace(/│\s*$/, "").trim()).filter((l) => l !== "").join(" ");
  const upApp = (): AppState => { const a = app(); return { ...a, config: { ...a.config, upstreams: [policy] } }; };

  test("marks each row, shows the upstream in the detail, and u on an edited copy asks to overwrite before writing", async () => {
    const checks: boolean[] = [];
    const updates: { skills: readonly string[]; force: boolean }[] = [];
    const planned: string[][] = [];
    let reloads = 0;
    const upIo: TuiIo = {
      ...io,
      plan: (_c, ks) => { planned.push(ks.map((k) => k.name)); return []; },
      upstreams: async (offline) => { checks.push(offline); return { ok: true, value: results }; },
      upstreamUpdate: async (ss, force, onEvent) => {
        updates.push({ skills: ss, force });
        onEvent({ kind: "updated", skill: ss[0] ?? "", label: "v1.2.0" });
        return { ok: true, value: { backup: "/h/.skm/backups/x", outcomes: [{ upstream: "waza", skill: ss[0] ?? "", from: "v1.0.0", to: "v1.2.0", result: "updated", reason: "" }] } };
      },
      loadSkills: async () => { reloads += 1; return { ok: true, value: [...skills, mk("new-one", "Use when testing.")] }; },
    };
    const { lastFrame, stdin, unmount } = render(<App app={upApp()} io={upIo} />); await tick(); await tick();
    expect(checks).toEqual([true, false]); // the cached mirror first, then a fetch
    const frame = lastFrame() ?? "";
    expect(frame).toContain("1 upstream update (U)");
    expect(frame).toMatch(/pdf-tools\s+↑/);
    expect(frame).toMatch(/kb-doc\s+✎/);
    expect(frame).toContain("upstream waza");
    expect(frame).toMatch(/v1\.0\.0 → v1\.2\.0\s+edited locally · 1 commit/);
    expect(frame).toContain("u  overwrite the edits");

    stdin.write("u"); await tick();
    expect(detail(lastFrame())).toContain("overwrite the edits in kb-doc with waza v1.2.0? y = yes (backup first: on), any other key = cancel");
    stdin.write("y"); await tick(); await tick();
    expect(updates).toEqual([{ skills: ["kb-doc"], force: true }]);
    expect(reloads).toBe(1);
    expect(planned.at(-1)).toContain("new-one"); // hosts are re-planned against the re-read store
    expect(lastFrame()).toContain("upstream: updated 1 · s to copy to every host");
    expect(lastFrame()).toContain("3 skills");

    stdin.write("j"); await tick(); // new-one, then pdf-tools
    stdin.write("j"); await tick();
    expect(lastFrame()).toContain("change 4");
    expect(lastFrame()).toContain("… 2 more (skm upstream --log)");
    expect(lastFrame()).toContain("u  update from upstream (backup first)");
    unmount();
  });

  test("U offers every skill an update writes without force; any other key cancels", async () => {
    const updates: (readonly string[])[] = [];
    const upIo: TuiIo = { ...io, upstreams: async () => ({ ok: true, value: results }), upstreamUpdate: async (ss) => { updates.push(ss); return { ok: true, value: { backup: null, outcomes: [] } }; } };
    const { lastFrame, stdin, unmount } = render(<App app={upApp()} io={upIo} />); await tick(); await tick();
    stdin.write("U"); await tick();
    expect(detail(lastFrame())).toContain("update pdf-tools to v1.2.0 from waza? y = yes");
    stdin.write("n"); await tick();
    expect(lastFrame()).toContain("1 upstream update (U)");
    expect(updates).toEqual([]);
    unmount();
  });

  test("a skills list with no upstreams configured has no mark column and no upstream check", async () => {
    let checked = 0;
    const { lastFrame, unmount } = render(<App app={app()} io={{ ...io, upstreams: async () => { checked += 1; return { ok: true, value: [] }; } }} />); await tick();
    expect(checked).toBe(0);
    expect(lastFrame()).toMatch(/kb-doc\s+\d+t/);
    unmount();
  });

  test("each state has its own mark; a failed check is named in the list title", () => {
    expect(["current", "behind", "absent", "modified", "unbased", "gone"].map((k) => upstreamMark(k as StateKind).glyph)).toEqual([" ", "↑", "+", "✎", "≠", "✗"]);
    const s = { ...initialState(upApp().config, skills), upstream: { checking: false, results: [{ policy, result: { ok: false as const, error: { upstream: "waza", step: "read cache", detail: "no mirror" } } }] } };
    expect(listTitle(s, 2)).toContain("upstream check failed: waza");
    expect(listTitle({ ...s, upstream: { results: [], checking: true } }, 2)).toContain("checking upstream…");
    expect(upstreamPrompt(s)).toEqual(none);
    expect(upstreamPrompt({ ...s, confirm: { kind: "upstream-update", skills: ["a", "b"], force: false } })).toEqual(some("update 2 skills from upstream (a, b)? y = yes (backup first: on), any other key = cancel"));
  });
});

describe("agent CLIs and findings in the hosts view", () => {
  const runs: readonly HarnessHost[] = [
    { host: "local", at: "t", error: null, results: [{ kind: "checked", agent: "claude", version: "2.1.3 (Claude Code)", latest: "" }, { kind: "checked", agent: "codex", version: "codex-cli 0.80.0", latest: "" }] },
    { host: "dev", at: "t", error: null, results: [{ kind: "checked", agent: "claude", version: "2.1.3 (Claude Code)", latest: "" }, { kind: "checked", agent: "codex", version: "codex-cli 0.79.0", latest: "" }] },
  ];
  // the same skill twice in claude's dir on both hosts: one same-name finding per host
  const dupInv = () => ({
    ...emptyInventory("/h"),
    agentDirs: { claude: { exists: true, entries: [{ kind: "managed" as const, name: "pdf-tools", direct: true }] }, codex: { exists: true, entries: [] } },
  });

  test("the section shows each tool's newest version and the hosts that are older; agent rows show each host's version", async () => {
    const harnessIo: TuiIo = { ...io, probe: async () => ({ ok: true, value: dupInv() }), harness: async (cached) => (cached ? [] : runs) };
    const { lastFrame, stdin, unmount } = render(<App app={app()} io={harnessIo} />); await tick(); await tick();
    stdin.write("3"); await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("agent CLIs  H update every CLI on every reachable host");
    expect(frame).toMatch(/claude\s+2\.1\.3\s+same version everywhere/);
    expect(frame).toMatch(/codex\s+0\.80\.0\s+2 versions · older on dev 0\.79\.0/);
    expect(frame).toMatch(/codex\s+0\.79\.0\s+●/); // dev's codex row
    unmount();
  });

  test("H asks, y runs each reachable host's CLI updates and logs the versions", async () => {
    const updated: string[] = [];
    const harnessIo: TuiIo = {
      ...io,
      harness: async () => runs,
      harnessUpdate: async (h, onLine) => {
        updated.push(h.id);
        onLine(">> codex update");
        return { host: h.id, at: "t2", error: null, results: [{ kind: "updated", agent: "codex", before: "codex-cli 0.79.0", after: "codex-cli 0.80.0", ok: true }] };
      },
    };
    const { lastFrame, stdin, unmount } = render(<App app={app()} io={harnessIo} />); await tick(); await tick();
    stdin.write("3"); await tick();
    stdin.write("H"); await tick();
    expect(lastFrame()).toContain("update every agent CLI on local, dev? y = yes, any other key = cancel");
    stdin.write("y"); await tick(); await tick();
    expect(updated.sort()).toEqual(["dev", "local"]);
    expect(lastFrame()).toContain("dev: >> codex update");
    expect(lastFrame()).toContain("dev: codex ok 0.79.0 → 0.80.0");
    stdin.write("3"); await tick();
    expect(lastFrame()).toMatch(/codex\s+0\.80\.0\s+same version everywhere/); // both hosts now on 0.80.0
    expect(lastFrame()).toMatch(/claude\s+2\.1\.3\s+same version everywhere/); // the update result only replaces codex
    unmount();
  });

  test("tool status covers unchecked, missing, app feed and drift", () => {
    const cli = { id: "codex", name: "codex", kind: "cli" as const };
    const app_ = { id: "chatgpt", name: "ChatGPT app", kind: "app" as const };
    expect(toolStatus(cli, toolVersions([], "codex"), true).text).toBe("checking…");
    expect(toolStatus(cli, toolVersions([], "codex"), false).text).toBe("not checked");
    expect(toolStatus(cli, toolVersions([{ host: "a", error: null, results: [{ kind: "missing", agent: "codex" }] }], "codex"), false).text).toBe("not installed");
    expect(toolStatus(cli, toolVersions([{ host: "a", error: "ssh failed", results: [] }], "codex"), false).text).toBe("not checked");
    const appRuns = [{ host: "a", error: null, results: [{ kind: "checked" as const, agent: "chatgpt", version: "1.2026.10", latest: "1.2026.20" }] }];
    expect(toolStatus(app_, toolVersions(appRuns, "chatgpt"), false)).toEqual({ text: "can update to 1.2026.20 on a 1.2026.10 (skm harness update --agent chatgpt)", color: "yellow" });
    expect(toolStatus(app_, toolVersions([{ host: "a", error: null, results: [{ kind: "checked", agent: "chatgpt", version: "1.2026.20", latest: "1.2026.20" }] }], "chatgpt"), false).text).toBe("up to date");
  });

  test("each host lists its findings under its agents", async () => {
    const a = app();
    const inv = dupInv();
    const view = buildHostView("dev", a.agents, inv, 200000, {});
    const withFindings = { ...view, findings: [{ kind: "disabled-cached" as const, host: "dev", agent: "claude", plugin: "x@m" }] };
    const s = { ...initialState(a.config, skills), hosts: { local: { kind: "ready" as const, inventory: inv, ops: [], view }, dev: { kind: "ready" as const, inventory: inv, ops: [], view: withFindings } } };
    const r = render(<HostsView s={s} height={hostLines(s).length + 1} offset={0} />); await tick();
    const frame = r.lastFrame() ?? "";
    expect(frame).toContain("findings 1: disabled-cached 1  (f to list)");
    expect(frame).not.toContain("x@m is cached");
    expect(frame.indexOf("findings 1")).toBeGreaterThan(frame.indexOf(" dev /h")); // under dev, not local
    r.unmount();
    const open = { ...s, allFindings: true };
    const all = render(<HostsView s={open} height={hostLines(open).length + 1} offset={0} />); await tick();
    expect(all.lastFrame()).toMatch(/disabled-cached\s+claude: x@m is cached but disabled/);
    all.unmount();
    expect(findingSummary([{ kind: "disabled-cached", host: "a", agent: "c", plugin: "p" }, { kind: "stale-cache", host: "a", agent: "c", plugin: "p", versions: [] }, { kind: "stale-cache", host: "a", agent: "c", plugin: "q", versions: [] }])).toBe("stale-cache 2 · disabled-cached 1");
  });

  test("findings drop the host prefix the view already shows", () => {
    expect(findingLine("mini", { kind: "disabled-cached", host: "mini", agent: "claude", plugin: "x@m" })).toBe("claude: x@m is cached but disabled");
    expect(findingLine("mini", { kind: "owned-drift", host: "mini", name: "s", owner: "skills", ownerPath: "/p", agents: ["pi"], storeHash: "a", ownerHash: "b" } as Parameters<typeof findingLine>[1])).toMatch(/^the store copy of s linked for pi differs/);
  });
});
