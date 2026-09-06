import { describe, expect, test } from "bun:test";
import { defaultCodexModel, resolveCodexWindow } from "../src/core/codex-model";
import { none, some } from "../src/lib/result";

const models = {
  "hidden-first": { contextWindow: some(100_000), maxContextWindow: some(100_000), priority: some(0), listed: false },
  "gpt-5.3-codex-spark": { contextWindow: some(128_000), maxContextWindow: some(128_000), priority: some(26), listed: true },
  "gpt-6-astra": { contextWindow: some(272_000), maxContextWindow: some(872_000), priority: some(1), listed: true },
  "only-max": { contextWindow: none, maxContextWindow: some(200_000), priority: none, listed: true },
  "no-window": { contextWindow: none, maxContextWindow: none, priority: some(2), listed: true },
};

describe("resolveCodexWindow (model_info.rs / openai_models.rs semantics)", () => {
  test("context_window from models_cache.json", () => {
    const w = resolveCodexWindow(some("gpt-6-astra"), none, models);
    expect(w.some && w.value.contextTokens).toBe(272_000);
    expect(w.some && w.value.reason).toContain("Codex model catalog");
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
  test("unknown model, windowless entry, or no model and an empty catalog → none", () => {
    expect(resolveCodexWindow(some("gpt-9"), none, models).some).toBe(false);
    expect(resolveCodexWindow(some("no-window"), none, models).some).toBe(false);
    expect(resolveCodexWindow(none, none, {}).some).toBe(false);
  });
  test("no model in config.toml → Codex's default: lowest priority among listed presets, hidden ones skipped (manager.rs default_model_from_available)", () => {
    expect(defaultCodexModel(models)).toEqual(some("gpt-6-astra"));
    expect(defaultCodexModel({ "only-max": models["only-max"] })).toEqual(none);
    const w = resolveCodexWindow(none, none, models);
    expect(w.some && w.value.contextTokens).toBe(272_000);
    expect(w.some && w.value.reason).toContain("no model in config.toml → Codex default gpt-6-astra");
    const clamped = resolveCodexWindow(none, some(300_000), models);
    expect(clamped.some && clamped.value.contextTokens).toBe(300_000);
  });
});
