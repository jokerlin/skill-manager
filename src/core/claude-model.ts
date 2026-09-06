import { type Option, none, some } from "../lib/result";

/**
 * How Claude Code sizes the skill-listing budget for a model. Reverse-engineered from
 * Claude Code 2.1.263 (2026-09-06): budget chars = contextWindowTokens × charsPerToken × skillListingBudgetFraction,
 * where the window comes from the main-loop model (not from autoCompactWindow) and charsPerToken is 4 for the
 * legacy families below and 3 for everything newer.
 */
export type ClaudeWindow = {
  readonly contextTokens: number;
  readonly bytesPerToken: 3 | 4;
  /** Human explanation: "fable → claude-fable-5-1, native 1M, 3 chars/token" */
  readonly reason: string;
};

const ONE_M = 1_000_000;
const TWO_HUNDRED_K = 200_000;

/** Ids Claude Code budgets at 4 chars/token (its legacy set); anything newer is 3. */
const LEGACY_4_CHARS: ReadonlySet<string> = new Set([
  "claude-3-opus", "claude-3-sonnet", "claude-3-haiku", "claude-3-5-sonnet", "claude-3-5-haiku", "claude-3-7-sonnet",
  "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-5", "claude-opus-4-6",
  "claude-sonnet-4-0", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-haiku-4-5",
]);

/** Aliases as Claude Code resolves them against the Anthropic API today (opus/sonnet → the 5 family). */
const ALIASES: Readonly<Record<string, string>> = {
  fable: "claude-fable-5-1",
  opus: "claude-opus-5",
  opusplan: "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

/** Families that ship with a native 1M window: Fable, Opus ≥4.7, Sonnet ≥5. */
const NATIVE_1M = /^claude-(fable-\d|opus-(4-[7-9]|[5-9])|sonnet-[5-9])(-|$)/;

/** "us.anthropic.claude-opus-4-6-v1:0[1m]" → { id: "claude-opus-4-6", oneM: true } */
const normalise = (raw: string): { readonly id: string; readonly oneM: boolean } => {
  const lower = raw.trim().toLowerCase();
  const oneM = lower.includes("[1m]");
  const bare = lower.replace("[1m]", "");
  const at = bare.indexOf("claude-");
  const id = (at >= 0 ? bare.slice(at) : bare)
    .replace(/[._]/g, "-")
    .replace(/-v\d+:\d+$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  return { id: ALIASES[id] ?? id, oneM };
};

/** Resolve a `model` setting to the window Claude Code will budget against; `none` when the id is unknown or unset. */
export const resolveClaudeWindow = (model: Option<string>, disable1m: boolean): Option<ClaudeWindow> => {
  if (!model.some || model.value.trim() === "") return none;
  const { id, oneM } = normalise(model.value);
  const legacy = LEGACY_4_CHARS.has(id);
  const native = NATIVE_1M.test(id);
  if (!legacy && !native) return none;
  const bytesPerToken = legacy ? 4 : 3;
  const full = native || oneM ? ONE_M : TWO_HUNDRED_K;
  const held = disable1m && full > TWO_HUNDRED_K;
  const contextTokens = held ? TWO_HUNDRED_K : full;
  const windowText = full === ONE_M ? (native ? "native 1M" : "1M via [1m]") : "200K";
  const heldText = held ? " held to 200K by CLAUDE_CODE_DISABLE_1M_CONTEXT" : "";
  return some({ contextTokens, bytesPerToken, reason: `${model.value.trim()} → ${id}, ${windowText}${heldText}, ${bytesPerToken} chars/token` });
};
