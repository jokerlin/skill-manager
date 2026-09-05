import { describe, expect, test } from "bun:test";
import { findDuplicates, lintSkill, jaccard, shingles } from "../src/core/heuristics";
import { buildEvalPrompt, parseEvalResponse } from "../src/core/evalPrompt";
import { buildSkill } from "../src/core/skill";

const mk = (name: string, desc: string, body = "# x\n".repeat(3)) => buildSkill(name, `/s/${name}`, `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`, [{ rel: "SKILL.md", bytes: 1 }]);

describe("heuristics", () => {
  test("duplicates by description overlap, incl. CJK", () => {
    const a = mk("kb-doc-a", "飞书云文档内容操作：读取、创建、编辑文档，插入图片附件");
    const b = mk("kb-doc-b", "飞书云文档内容操作：读取、创建、编辑文档，插入图片附件，操作思维笔记");
    const c = mk("pdf", "Extract text from PDF files. Use when the user mentions PDFs.");
    const d = findDuplicates([a, b, c]);
    expect(d.map((i) => i.skill).sort()).toEqual(["kb-doc-a", "kb-doc-b"]);
    expect(d[0]?.related).toContain("kb-doc-b");
    expect(jaccard(shingles("alpha beta gamma"), shingles("alpha beta gamma"))).toBe(1);
  });
  test("lint: short, no-trigger, oversize", () => {
    expect(lintSkill(mk("s", "Helps with PDFs.")).map((i) => i.kind)).toEqual(["short-description"]);
    expect(lintSkill(mk("s", "A long description that explains what this does in detail but never says when.")).map((i) => i.kind)).toEqual(["no-trigger"]);
    expect(lintSkill(mk("s", "Does the X transformation on files. Use when the user asks for X.", "line\n".repeat(600))).map((i) => i.kind)).toEqual(["oversize-body"]);
    expect(lintSkill(mk("s", "Does the X transformation on files. Use when the user asks for X."))).toEqual([]);
  });
});

describe("eval prompt/response", () => {
  test("prompt lists every skill", () => {
    const p = buildEvalPrompt([mk("a", "Does a. Use when a."), mk("b", "Does b. Use when b.")]);
    expect(p).toContain("### a");
    expect(p).toContain("### b");
  });
  test("parses fenced and bare JSON, tolerates junk fields", () => {
    const fenced = "Here you go:\n```json\n{\"items\":[{\"name\":\"a\",\"usefulness\":9,\"description_quality\":2,\"overlaps\":[\"b\",3],\"verdict\":\"wat\",\"trim_suggestion\":\"\",\"reason\":\"r\"}]}\n```";
    const r = parseEvalResponse(fenced);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]).toEqual({ name: "a", usefulness: 5, description_quality: 2, overlaps: ["b"], verdict: "keep", trim_suggestion: "", reason: "r" });
    expect(parseEvalResponse("[{\"name\":\"z\"}]").ok).toBe(true);
    expect(parseEvalResponse("nothing here").ok).toBe(false);
  });
});
