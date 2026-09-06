import { describe, expect, test } from "bun:test";
import { none, some } from "../src/lib/result";
import { resolveClaudeWindow } from "../src/core/claude-model";

const win = (model: string, disable1m = false) => {
  const r = resolveClaudeWindow(some(model), disable1m);
  if (!r.some) throw new Error(`unresolved: ${model}`);
  return r.value;
};

describe("resolveClaudeWindow (Claude Code 2.1.263 semantics)", () => {
  test("fable alias → native 1M, 3 chars per token", () => {
    expect(win("fable")).toMatchObject({ contextTokens: 1_000_000, bytesPerToken: 3 });
  });
  test("opus / sonnet aliases resolve to the 5-family → 1M, 3 chars per token", () => {
    expect(win("opus")).toMatchObject({ contextTokens: 1_000_000, bytesPerToken: 3 });
    expect(win("sonnet")).toMatchObject({ contextTokens: 1_000_000, bytesPerToken: 3 });
    expect(win("opusplan")).toMatchObject({ contextTokens: 1_000_000, bytesPerToken: 3 });
  });
  test("haiku alias → Haiku 4.5: 200K, 4 chars per token", () => {
    expect(win("haiku")).toMatchObject({ contextTokens: 200_000, bytesPerToken: 4 });
  });
  test("legacy ids (Opus ≤4.6, Sonnet ≤4.6, 3.x) → 200K, 4 chars per token; [1m] suffix lifts to 1M", () => {
    expect(win("claude-opus-4-6")).toMatchObject({ contextTokens: 200_000, bytesPerToken: 4 });
    expect(win("claude-opus-4-6[1m]")).toMatchObject({ contextTokens: 1_000_000, bytesPerToken: 4 });
    expect(win("claude-sonnet-4-5-20250929")).toMatchObject({ contextTokens: 200_000, bytesPerToken: 4 });
    expect(win("claude-3-5-haiku-latest")).toMatchObject({ contextTokens: 200_000, bytesPerToken: 4 });
  });
  test("provider-prefixed ids are normalised", () => {
    expect(win("us.anthropic.claude-opus-4-6-v1:0")).toMatchObject({ contextTokens: 200_000, bytesPerToken: 4 });
    expect(win("anthropic/claude-fable-5-1[1m]")).toMatchObject({ contextTokens: 1_000_000, bytesPerToken: 3 });
  });
  test("explicit native-1M ids", () => {
    expect(win("claude-opus-4-8")).toMatchObject({ contextTokens: 1_000_000, bytesPerToken: 3 });
    expect(win("claude-opus-5")).toMatchObject({ contextTokens: 1_000_000, bytesPerToken: 3 });
    expect(win("claude-sonnet-5")).toMatchObject({ contextTokens: 1_000_000, bytesPerToken: 3 });
    expect(win("claude-fable-5-1")).toMatchObject({ contextTokens: 1_000_000, bytesPerToken: 3 });
  });
  test("CLAUDE_CODE_DISABLE_1M_CONTEXT holds every window to 200K without changing chars per token", () => {
    expect(win("fable", true)).toMatchObject({ contextTokens: 200_000, bytesPerToken: 3 });
    expect(win("claude-opus-4-6[1m]", true)).toMatchObject({ contextTokens: 200_000, bytesPerToken: 4 });
  });
  test("reason names the model and the window", () => {
    expect(win("fable").reason).toContain("1M");
    expect(win("fable", true).reason).toContain("DISABLE_1M");
  });
  test("unknown or unset model → none", () => {
    expect(resolveClaudeWindow(some("gpt-5"), false).some).toBe(false);
    expect(resolveClaudeWindow(some(""), false).some).toBe(false);
    expect(resolveClaudeWindow(none, false).some).toBe(false);
  });
});
