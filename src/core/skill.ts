import { type FrontmatterError, type ParsedSkillMd, type SpecViolation, listingText, parseSkillMd, validateSpec } from "./frontmatter";
import type { Result } from "../lib/result";
import { estimateTokens } from "../lib/tokens";

export type FileStat = { readonly rel: string; readonly bytes: number };

export type SkillCost = {
  /** description + when_to_use characters — what an agent pays at startup for this skill */
  readonly descChars: number;
  readonly descTokens: number;
  /** SKILL.md body — what an agent pays when the skill activates */
  readonly bodyChars: number;
  readonly bodyTokens: number;
  readonly bodyLines: number;
  readonly totalBytes: number;
  readonly fileCount: number;
};

export type Skill = {
  readonly name: string;
  readonly dir: string;
  readonly parsed: Result<ParsedSkillMd, FrontmatterError>;
  readonly violations: readonly SpecViolation[];
  readonly cost: SkillCost;
  readonly files: readonly FileStat[];
  /** sha1 of SKILL.md text; used for change detection across hosts and eval caching */
  readonly contentHash: string;
};

const sha1 = (text: string): string => new Bun.CryptoHasher("sha1").update(text).digest("hex");

const countLines = (s: string): number => (s.length === 0 ? 0 : s.replace(/\n$/, "").split("\n").length);

const emptyFrontmatter = { name: { some: false }, description: { some: false }, whenToUse: { some: false }, extra: {} } as const;

/** Pure constructor: given the SKILL.md text and file stats, derive everything else. */
export const buildSkill = (name: string, dir: string, skillMdText: string, files: readonly FileStat[]): Skill => {
  const parsed = parseSkillMd(skillMdText);
  const fm = parsed.ok ? parsed.value.frontmatter : emptyFrontmatter;
  const body = parsed.ok ? parsed.value.body : skillMdText;
  const listing = listingText(fm);
  const violations = parsed.ok
    ? validateSpec(fm, name)
    : [{ field: "name", kind: "missing", detail: describeError(parsed.error) } as const];
  return {
    name,
    dir,
    parsed,
    violations,
    cost: {
      descChars: listing.length,
      descTokens: estimateTokens(listing),
      bodyChars: body.length,
      bodyTokens: estimateTokens(body),
      bodyLines: countLines(body),
      totalBytes: files.reduce((n, f) => n + f.bytes, 0),
      fileCount: files.length,
    },
    files,
    contentHash: sha1(skillMdText),
  };
};

const describeError = (e: FrontmatterError): string => {
  switch (e.kind) {
    case "no-frontmatter":
      return "SKILL.md has no YAML frontmatter";
    case "yaml":
      return `frontmatter YAML error: ${e.message}`;
    case "not-object":
      return "frontmatter is not a key/value map";
  }
};

export const frontmatterErrorText = describeError;

export const descriptionOf = (s: Skill): string =>
  s.parsed.ok && s.parsed.value.frontmatter.description.some ? s.parsed.value.frontmatter.description.value : "";

export const listingOf = (s: Skill): string => (s.parsed.ok ? listingText(s.parsed.value.frontmatter) : "");

export const bodyOf = (s: Skill): string => (s.parsed.ok ? s.parsed.value.body : "");

/** Convenience for callers that only need the two hashes-of-record. */
export const skillRef = (s: Skill): { name: string; hash: string } => ({ name: s.name, hash: s.contentHash });

