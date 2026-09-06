import { type Option, none, some } from "../lib/result";

/**
 * How Codex sizes the context window its skills budget is 2% of (codex-rs/models-manager/src/model_info.rs +
 * protocol/src/openai_models.rs): the model's `context_window` from ~/.codex/models_cache.json, else its
 * `max_context_window`; config.toml `model_context_window` overrides, clamped to `max_context_window`.
 */
export type CodexModelWindow = { readonly contextWindow: Option<number>; readonly maxContextWindow: Option<number> };
export type CodexModels = Readonly<Record<string, CodexModelWindow>>;

export type CodexWindow = { readonly contextTokens: number; readonly reason: string };

export const resolveCodexWindow = (model: Option<string>, configured: Option<number>, models: CodexModels): Option<CodexWindow> => {
  if (!model.some) return none;
  const info = models[model.value];
  if (info === undefined) return none;
  const native = info.contextWindow.some ? info.contextWindow : info.maxContextWindow;
  if (!native.some) return none;
  if (configured.some) {
    const clamped = info.maxContextWindow.some ? Math.min(configured.value, info.maxContextWindow.value) : configured.value;
    const clampText = clamped < configured.value ? ` clamped to max_context_window ${clamped}` : "";
    return some({ contextTokens: clamped, reason: `${model.value}: model_context_window ${configured.value}${clampText} (config.toml)` });
  }
  return some({ contextTokens: native.value, reason: `${model.value} → ${native.value} tokens (~/.codex/models_cache.json)` });
};
