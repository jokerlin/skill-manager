import { describe, expect, test } from "bun:test";
import { buildSkill, descriptionOf } from "../src/core/skill";
import { estimateTokens } from "../src/lib/tokens";

const text = `---\nname: demo\ndescription: Does demo things. Use when demoing.\n---\n# Demo\nline two\nline three\n`;

describe("estimateTokens", () => {
  test("roughly proportional and non-zero", () => {
    expect(estimateTokens("")).toBe(0);
    const t = estimateTokens("hello world this is a test");
    expect(t).toBeGreaterThan(3);
    expect(t).toBeLessThan(10);
  });
});

describe("buildSkill", () => {
  const files = [{ rel: "SKILL.md", bytes: text.length }, { rel: "references/a.md", bytes: 100 }];
  const s = buildSkill("demo", "/tmp/demo", text, files);
  test("cost fields", () => {
    expect(s.cost.descChars).toBe("Does demo things. Use when demoing.".length);
    expect(s.cost.bodyLines).toBe(3);
    expect(s.cost.fileCount).toBe(2);
    expect(s.cost.totalBytes).toBe(text.length + 100);
    expect(s.cost.descTokens).toBeGreaterThan(0);
    expect(s.cost.bodyTokens).toBeGreaterThan(0);
  });
  test("stable hash, changes with content", () => {
    expect(buildSkill("demo", "/x", text, files).contentHash).toBe(s.contentHash);
    expect(buildSkill("demo", "/x", text + "!", files).contentHash).not.toBe(s.contentHash);
  });
  test("descriptionOf tolerates missing frontmatter", () => {
    expect(descriptionOf(s)).toContain("demo things");
    const bad = buildSkill("bad", "/x", "no frontmatter", [{ rel: "SKILL.md", bytes: 13 }]);
    expect(descriptionOf(bad)).toBe("");
    expect(bad.parsed.ok).toBe(false);
    expect(bad.cost.descChars).toBe(0);
    expect(bad.violations.length).toBeGreaterThan(0);
  });
});
