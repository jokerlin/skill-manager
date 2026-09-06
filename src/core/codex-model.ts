import { type Option, none, some } from "../lib/result";

/**
 * How Codex sizes the context window its skills budget is 2% of (codex-rs/models-manager/src/model_info.rs +
 * protocol/src/openai_models.rs): the model's `context_window` from ~/.codex/models_cache.json, else its
 * `max_context_window`; config.toml `model_context_window` overrides, clamped to `max_context_window`.
 */
export type CodexModelWindow = {
  readonly contextWindow: Option<number>;
  readonly maxContextWindow: Option<number>;
  readonly priority: Option<number>;   // catalog order; Codex sorts presets by it
  readonly listed: boolean;            // visibility "list" — the presets Codex offers (hidden ones never become the default)
};
/** slug → window, from `codex debug models` (or ~/.codex/models_cache.json when the CLI is absent) */
export type CodexModels = Readonly<Record<string, CodexModelWindow>>;

export type CodexWindow = { readonly contextTokens: number; readonly reason: string };

/**
 * The model Codex runs when config.toml names none (models-manager/src/manager.rs `default_model_from_available`,
 * verified on codex-cli 0.153.4): the first preset of the catalog sorted by priority, listed presets only.
 */
export const defaultCodexModel = (models: CodexModels): Option<string> => {
  const ranked = Object.entries(models)
    .flatMap(([slug, m]) => (m.listed && m.priority.some ? [{ slug, priority: m.priority.value }] : []))
    .sort((a, b) => a.priority - b.priority);
  const first = ranked[0];
  return first === undefined ? none : some(first.slug);
};

export const resolveCodexWindow = (model: Option<string>, configured: Option<number>, models: CodexModels): Option<CodexWindow> => {
  const chosen = model.some ? model : defaultCodexModel(models);
  if (!chosen.some) return none;
  const slug = chosen.value;
  const info = models[slug];
  if (info === undefined) return none;
  const native = info.contextWindow.some ? info.contextWindow : info.maxContextWindow;
  if (!native.some) return none;
  const origin = model.some ? slug : `no model in config.toml → Codex default ${slug}`;
  if (configured.some) {
    const clamped = info.maxContextWindow.some ? Math.min(configured.value, info.maxContextWindow.value) : configured.value;
    const clampText = clamped < configured.value ? ` clamped to max_context_window ${clamped}` : "";
    return some({ contextTokens: clamped, reason: `${origin}: model_context_window ${configured.value}${clampText} (config.toml)` });
  }
  return some({ contextTokens: native.value, reason: `${origin} → ${native.value} tokens (Codex model catalog)` });
};
