import { parse as parseYaml } from "yaml";
import { type Option, type Result, err, fromNullable, none, ok, some } from "../lib/result";

export type Frontmatter = {
  readonly name: Option<string>;
  readonly description: Option<string>;
  readonly whenToUse: Option<string>;
  /** Every other frontmatter key, untouched (metadata, allowed-tools, model, ...). */
  readonly extra: Readonly<Record<string, unknown>>;
};

export type FrontmatterError =
  | { readonly kind: "no-frontmatter" }
  | { readonly kind: "yaml"; readonly message: string }
  | { readonly kind: "not-object" };

export type ParsedSkillMd = { readonly frontmatter: Frontmatter; readonly body: string };

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

const asString = (v: unknown): Option<string> =>
  typeof v === "string" ? some(v) : typeof v === "number" || typeof v === "boolean" ? some(String(v)) : none;

/** Parse `---\nyaml\n---\nbody`. Pure. */
export const parseSkillMd = (text: string): Result<ParsedSkillMd, FrontmatterError> => {
  const m = FM_RE.exec(text);
  if (!m) return err({ kind: "no-frontmatter" });
  const [, yamlText = "", body = ""] = m;
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (e) {
    return err({ kind: "yaml", message: e instanceof Error ? e.message : String(e) });
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return err({ kind: "not-object" });
  const obj = doc as Record<string, unknown>;
  const { name, description, when_to_use, ...extra } = obj;
  return ok({
    frontmatter: {
      name: asString(name),
      description: asString(description),
      whenToUse: asString(when_to_use ?? extra["whenToUse"]),
      extra,
    },
    body: body.replace(/\r\n/g, "\n"),
  });
};

export type SpecViolation = {
  readonly field: "name" | "description";
  readonly kind: "missing" | "too-long" | "bad-chars" | "dir-mismatch" | "empty";
  readonly detail: string;
};

export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const nameViolations = (name: Option<string>, dirName: string): SpecViolation[] => {
  if (!name.some) return [{ field: "name", kind: "missing", detail: "frontmatter has no name" }];
  const n = name.value;
  return [
    ...(n.length === 0 ? [{ field: "name", kind: "empty", detail: "name is empty" } as const] : []),
    ...(n.length > NAME_MAX ? [{ field: "name", kind: "too-long", detail: `${n.length} > ${NAME_MAX}` } as const] : []),
    ...(n.length > 0 && !NAME_RE.test(n)
      ? [{ field: "name", kind: "bad-chars", detail: "only a-z 0-9 and single hyphens, not at the ends" } as const]
      : []),
    ...(n !== dirName ? [{ field: "name", kind: "dir-mismatch", detail: `name "${n}" ≠ directory "${dirName}"` } as const] : []),
  ];
};

const descriptionViolations = (d: Option<string>): SpecViolation[] => {
  if (!d.some) return [{ field: "description", kind: "missing", detail: "frontmatter has no description" }];
  const s = d.value.trim();
  return [
    ...(s.length === 0 ? [{ field: "description", kind: "empty", detail: "description is empty" } as const] : []),
    ...(s.length > DESCRIPTION_MAX
      ? [{ field: "description", kind: "too-long", detail: `${s.length} > ${DESCRIPTION_MAX}` } as const]
      : []),
  ];
};

/** Agent Skills spec checks (name format/length/dir match, description presence/length). */
export const validateSpec = (fm: Frontmatter, dirName: string): SpecViolation[] => [
  ...nameViolations(fm.name, dirName),
  ...descriptionViolations(fm.description),
];

export const descriptionText = (fm: Frontmatter): string => (fm.description.some ? fm.description.value : "");
export const listingText = (fm: Frontmatter): string =>
  [descriptionText(fm), fm.whenToUse.some ? fm.whenToUse.value : ""].filter((s) => s.length > 0).join(" ");
