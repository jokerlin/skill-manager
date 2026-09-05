import { describe, expect, test } from "bun:test";
import { parseSkillMd, validateSpec } from "../src/core/frontmatter";
import { some, none } from "../src/lib/result";

const md = (fm: string, body = "Body here") => `---\n${fm}\n---\n${body}`;

describe("parseSkillMd", () => {
  test("parses name/description/body", () => {
    const r = parseSkillMd(md("name: kb-doc\ndescription: Reads docs", "# Title\nline2"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.frontmatter.name).toEqual(some("kb-doc"));
    expect(r.value.frontmatter.description).toEqual(some("Reads docs"));
    expect(r.value.frontmatter.whenToUse).toEqual(none);
    expect(r.value.body).toBe("# Title\nline2");
  });
  test("maps when_to_use and keeps extras", () => {
    const r = parseSkillMd(md("name: a\ndescription: b\nwhen_to_use: when c\nmetadata:\n  x: 1"));
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.frontmatter.whenToUse).toEqual(some("when c"));
    expect(r.value.frontmatter.extra.metadata).toEqual({ x: 1 });
  });
  test("no frontmatter", () => {
    expect(parseSkillMd("# just markdown")).toEqual({ ok: false, error: { kind: "no-frontmatter" } });
  });
  test("bad yaml", () => {
    const r = parseSkillMd(md("name: [unclosed"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("yaml");
  });
  test("frontmatter that is a scalar", () => {
    expect(parseSkillMd(md("just a string")).ok).toBe(false);
  });
  test("CRLF line endings", () => {
    const r = parseSkillMd("---\r\nname: a\r\ndescription: b\r\n---\r\nbody");
    expect(r.ok).toBe(true);
  });
});

describe("validateSpec", () => {
  const fm = (name?: string, description?: string) => ({
    name: name === undefined ? none : some(name),
    description: description === undefined ? none : some(description),
    whenToUse: none,
    extra: {},
  });
  test("valid passes", () => {
    expect(validateSpec(fm("pdf-x", "does things"), "pdf-x")).toEqual([]);
  });
  test("uppercase name → bad-chars", () => {
    expect(validateSpec(fm("PDF-x", "d"), "PDF-x").map((v) => v.kind)).toContain("bad-chars");
  });
  test("double hyphen / leading hyphen", () => {
    expect(validateSpec(fm("a--b", "d"), "a--b").map((v) => v.kind)).toContain("bad-chars");
    expect(validateSpec(fm("-ab", "d"), "-ab").map((v) => v.kind)).toContain("bad-chars");
  });
  test("name ≠ dir → dir-mismatch", () => {
    expect(validateSpec(fm("a", "d"), "b").map((v) => v.kind)).toContain("dir-mismatch");
  });
  test("missing description / too long", () => {
    expect(validateSpec(fm("a"), "a").map((v) => `${v.field}:${v.kind}`)).toContain("description:missing");
    expect(validateSpec(fm("a", "x".repeat(1025)), "a").map((v) => v.kind)).toContain("too-long");
    expect(validateSpec(fm("a".repeat(65), "d"), "a".repeat(65)).map((v) => v.kind)).toContain("too-long");
  });
});
