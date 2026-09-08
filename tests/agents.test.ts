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

  test("ids are unique", () => {
    expect(new Set(AGENTS.map((a) => a.id)).size).toBe(AGENTS.length);
  });
});
