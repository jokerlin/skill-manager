import { type Result, err, ok } from "../lib/result";
import { type Skill, bodyOf, descriptionOf } from "./skill";

export type Verdict = "keep" | "merge" | "trim" | "drop";
export type EvalItem = {
  readonly name: string;
  readonly usefulness: number;          // 1–5
  readonly description_quality: number; // 1–5
  readonly overlaps: readonly string[];
  readonly verdict: Verdict;
  readonly trim_suggestion: string;
  readonly reason: string;
};

export const EVAL_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          usefulness: { type: "integer", minimum: 1, maximum: 5 },
          description_quality: { type: "integer", minimum: 1, maximum: 5 },
          overlaps: { type: "array", items: { type: "string" } },
          verdict: { type: "string", enum: ["keep", "merge", "trim", "drop"] },
          trim_suggestion: { type: "string" },
          reason: { type: "string" },
        },
        required: ["name", "usefulness", "description_quality", "overlaps", "verdict", "trim_suggestion", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

const head = (text: string, lines: number): string => text.split("\n").slice(0, lines).join("\n");

/** One prompt covering all given skills so the model can judge overlap. Pure. */
export const buildEvalPrompt = (skills: readonly Skill[], bodyHeadLines = 40): string =>
  [
    "You are auditing a personal library of agent skills (SKILL.md files) used by coding agents such as Claude Code and Codex.",
    "For EACH skill below, judge:",
    "- usefulness (1–5): is this a capability an agent could not do well without instructions? generic advice = low.",
    "- description_quality (1–5): does the description say what it does AND when to use it, with concrete trigger words? agents choose skills by description only.",
    "- overlaps: names of other skills in this list whose purpose overlaps substantially.",
    "- verdict: keep | merge (into an overlapping skill) | trim (body too long / description too long; keep but shorten) | drop (not useful).",
    "- trim_suggestion: if trim or description_quality <= 3, a rewritten description under 300 characters; otherwise empty string.",
    "- reason: one sentence.",
    "Startup cost matters: every skill's description is loaded into context on every turn; Claude Code caps each at 1536 characters and the whole listing at ~1% of the context window.",
    "Return only JSON matching the schema: {\"items\": [...]}, one item per skill, names exactly as given.",
    "",
    "=== SKILLS ===",
    ...skills.map((s) =>
      [
        `### ${s.name}`,
        `description (${s.cost.descChars} chars): ${descriptionOf(s)}`,
        `body: ${s.cost.bodyTokens} tokens, ${s.cost.bodyLines} lines, ${s.cost.fileCount} files`,
        "body head:",
        "```",
        head(bodyOf(s), bodyHeadLines),
        "```",
        "",
      ].join("\n"),
    ),
  ].join("\n");

export type EvalError =
  | { readonly kind: "no-json"; readonly text: string }
  | { readonly kind: "bad-shape"; readonly detail: string }
  | { readonly kind: "run"; readonly detail: string };

const isVerdict = (v: unknown): v is Verdict => v === "keep" || v === "merge" || v === "trim" || v === "drop";

const toItem = (v: unknown): EvalItem | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const num = (x: unknown, d = 3) => (typeof x === "number" ? Math.max(1, Math.min(5, Math.round(x))) : d);
  return typeof o["name"] === "string"
    ? {
        name: o["name"],
        usefulness: num(o["usefulness"]),
        description_quality: num(o["description_quality"]),
        overlaps: Array.isArray(o["overlaps"]) ? o["overlaps"].filter((x): x is string => typeof x === "string") : [],
        verdict: isVerdict(o["verdict"]) ? o["verdict"] : "keep",
        trim_suggestion: typeof o["trim_suggestion"] === "string" ? o["trim_suggestion"] : "",
        reason: typeof o["reason"] === "string" ? o["reason"] : "",
      }
    : undefined;
};

/** Accepts raw JSON, JSON inside ``` fences, or an object with `items`. */
export const parseEvalResponse = (text: string): Result<EvalItem[], EvalError> => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf("{");
  const startArr = candidate.indexOf("[");
  const from = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
  if (from === -1) return err({ kind: "no-json", text: text.slice(0, 200) });
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(from, Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]")) + 1));
  } catch (e) {
    return err({ kind: "no-json", text: e instanceof Error ? e.message : String(e) });
  }
  const arr = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>)["items"]) ? ((parsed as Record<string, unknown>)["items"] as unknown[]) : undefined;
  if (!arr) return err({ kind: "bad-shape", detail: "expected {items: [...]}" });
  return ok(arr.map(toItem).flatMap((i) => (i ? [i] : [])));
};

export const evalErrorText = (e: EvalError): string => {
  switch (e.kind) {
    case "no-json": return `evaluator returned no JSON: ${e.text}`;
    case "bad-shape": return `evaluator JSON had the wrong shape: ${e.detail}`;
    case "run": return `evaluator failed: ${e.detail}`;
  }
};
