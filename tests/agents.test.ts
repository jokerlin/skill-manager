import { describe, expect, test } from "bun:test";
import { AGENTS, agentById } from "../src/core/agents";

describe("agent directory table", () => {
  test("pi loads user skills from ~/.pi/agent/skills and also scans ~/.agents/skills, user dir winning a name collision (pi docs/skills.md)", () => {
    const pi = agentById("pi");
    expect(pi.some).toBe(true);
    if (!pi.some) return;
    expect(pi.value.userDir("/Users/me")).toBe("/Users/me/.pi/agent/skills");
    expect(pi.value.alsoReads.map((f) => f("/Users/me"))).toEqual(["/Users/me/.agents/skills"]);
    expect(pi.value.duplicates).toBe("user-dir-first");
  });

  test("opencode also reads the claude and codex user dirs (vendor docs: opencode.ai/docs/skills)", () => {
    const oc = agentById("opencode");
    expect(oc.some).toBe(true);
    if (!oc.some) return;
    expect(oc.value.userDir("/h")).toBe("/h/.config/opencode/skills");
    expect(oc.value.alsoReads.map((f) => f("/h"))).toEqual(["/h/.claude/skills", "/h/.agents/skills"]);
  });

  test("dsh (DeepSeek Harness) loads user skills from ~/.dsh/skills and also scans ~/.agents/skills (skill-filesystem roots)", () => {
    const dsh = agentById("dsh");
    expect(dsh.some).toBe(true);
    if (!dsh.some) return;
    expect(dsh.value.userDir("/h")).toBe("/h/.dsh/skills");
    expect(dsh.value.alsoReads.map((f) => f("/h"))).toEqual(["/h/.agents/skills"]);
  });

  test("ids are unique", () => {
    expect(new Set(AGENTS.map((a) => a.id)).size).toBe(AGENTS.length);
  });
});
