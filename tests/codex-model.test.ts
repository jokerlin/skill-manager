import { describe, expect, test } from "bun:test";
import { resolveCodexWindow } from "../src/core/codex-model";
import { none, some } from "../src/lib/result";

const models = {
  "gpt-6-astra": { contextWindow: some(272_000), maxContextWindow: some(872_000) },
  "gpt-5.3-codex-spark": { contextWindow: some(128_000), maxContextWindow: some(128_000) },
  "only-max": { contextWindow: none, maxContextWindow: some(200_000) },
  "no-window": { contextWindow: none, maxContextWindow: none },
};

describe("resolveCodexWindow (model_info.rs / openai_models.rs semantics)", () => {
  test("context_window from models_cache.json", () => {
    const w = resolveCodexWindow(some("gpt-6-astra"), none, models);
    expect(w.some && w.value.contextTokens).toBe(272_000);
    expect(w.some && w.value.reason).toContain("models_cache.json");
  });
  test("max_context_window when context_window is absent", () => {
    const w = resolveCodexWindow(some("only-max"), none, models);
    expect(w.some && w.value.contextTokens).toBe(200_000);
  });
  test("config.toml model_context_window overrides, clamped to max_context_window", () => {
    expect(resolveCodexWindow(some("gpt-6-astra"), some(400_000), models)).toMatchObject({ some: true, value: { contextTokens: 400_000 } });
    const clamped = resolveCodexWindow(some("gpt-6-astra"), some(2_000_000), models);
    expect(clamped.some && clamped.value.contextTokens).toBe(872_000);
    expect(clamped.some && clamped.value.reason).toContain("clamped");
  });
  test("unknown model, unset model or windowless entry → none", () => {
    expect(resolveCodexWindow(some("gpt-9"), none, models).some).toBe(false);
    expect(resolveCodexWindow(none, none, models).some).toBe(false);
    expect(resolveCodexWindow(some("no-window"), none, models).some).toBe(false);
  });
});
