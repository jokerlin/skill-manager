import { emptyInventory } from "../src/core/inventory";
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/tui/App";
import type { TuiIo } from "../src/tui/io";
import { defaultConfig } from "../src/core/config";
import { buildSkill } from "../src/core/skill";
import { agentById } from "../src/core/agents";
import { none, some } from "../src/lib/result";
import type { AppState } from "../src/shell/app";
import { inferRules, compressGlobs } from "../src/cli/rules";
import { pullCandidates } from "../src/cli/pull";

const mk = (name: string, desc: string) => buildSkill(name, `/s/${name}`, `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\nbody\n`, [{ rel: "SKILL.md", bytes: 10 }]);
const skills = [mk("pdf-tools", "Extract text from PDFs. Use when the user mentions PDFs."), mk("kb-doc", "飞书文档操作。当用户提供文档 URL 时使用。")];

const app = (): AppState => {
  const claude = agentById("claude"); const codex = agentById("codex");
  if (!claude.some || !codex.some) throw new Error();
  return {
    skmHome: "/tmp/skm", configPath: "/tmp/skm/config.yaml", config: { ...defaultConfig(), hosts: [{ id: "local", ssh: none, agents: none, skm: "~/.skm" }, { id: "dev", ssh: some("dev"), agents: none, skm: "~/.skm" }] },
    storeDir: "/tmp/skm/skills", skills, ignoredDirs: [], agents: [claude.value, codex.value], unknownAgents: [], claudeOverrides: {}, hubMarketplaces: {},
  };
};

const io: TuiIo = {
  probe: async (h) => ({ ok: true, value: { ...emptyInventory("/h"), agentDirs: { claude: { exists: true, entries: [{ kind: "managed", name: "pdf-tools", direct: true }] }, codex: { exists: false, entries: [] } }, alsoReads: {} } }),
  plan: () => [{ op: "link", host: "dev", agent: "codex", skill: "pdf-tools" }],
  saveConfig: async () => {},
  backup: async () => ({ ok: true, value: "/h/.skm/backups/x" }),
  apply: async (h) => ({ host: h.id, rsynced: [], applied: ["link codex/pdf-tools"], skipped: [], conflicts: [], commands: [], error: undefined }),
  evaluate: async () => ({ ok: true, value: {} }),
  now: () => "20260906-000000",
};

const tick = () => new Promise((r) => setTimeout(r, 30));

describe("TUI", () => {
  test("renders skills, filters, and shows probe results in the header", async () => {
    const { lastFrame, stdin } = render(<App app={app()} io={io} evals={{}} />);
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
    stdin.write("3"); await tick(); // sync view shows the plan
    expect(lastFrame()).toContain("link codex/pdf-tools");
  });
  test("targets grid toggle calls saveConfig", async () => {
    let saved = 0;
    const { lastFrame, stdin } = render(<App app={app()} io={{ ...io, saveConfig: async () => { saved += 1; } }} evals={{}} />);
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
