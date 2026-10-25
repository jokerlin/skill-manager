import { type Option, type Result, err, none, ok, some } from "../lib/result";
import type { CodexModels } from "./codex-model";

/**
 * Where a skill an agent loads comes from, how it is stored, and who owns it.
 * Pure types + parsers for the config/lock files the probe ships back verbatim.
 */

export type Source =
  | { readonly kind: "user" }
  | { readonly kind: "legacy"; readonly dir: string }
  | { readonly kind: "builtin" }
  | { readonly kind: "plugin"; readonly marketplace: string; readonly plugin: string; readonly version: string };

export type Storage =
  | { readonly kind: "store-link"; readonly direct: boolean }
  | { readonly kind: "real-dir" }
  | { readonly kind: "link-elsewhere"; readonly target: string }
  | { readonly kind: "plugin-cache" }
  | { readonly kind: "builtin" };

/** Built-in owners, or the `tool` of the owned: policy that names the skill. */
export type Owner = "skm" | "skills-cli" | "claude-plugins" | "codex-plugins" | "codex-builtin" | "manual" | (string & {});

export type Enabled = "on" | "off";

export type ParseError = { readonly kind: "bad-json" | "bad-toml" | "bad-shape"; readonly file: string; readonly message: string };

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

const json = (file: string, text: string): Result<unknown, ParseError> => {
  try {
    return ok(JSON.parse(text));
  } catch (e) {
    return err({ kind: "bad-json", file, message: e instanceof Error ? e.message : String(e) });
  }
};

// ---------- Claude Code ----------

export type ClaudeSettings = {
  readonly enabledPlugins: Readonly<Record<string, boolean>>;
  readonly fraction?: number;
  readonly maxDescChars?: number;
  /** `model` setting — drives the context window the listing budget is 1% of. */
  readonly model: Option<string>;
  /** env.CLAUDE_CODE_DISABLE_1M_CONTEXT truthy → every window held to 200K. */
  readonly disable1m: boolean;
  /** env.SLASH_COMMAND_TOOL_CHAR_BUDGET → fixed listing budget in chars. */
  readonly fixedChars?: number;
};

export const EMPTY_CLAUDE_SETTINGS: ClaudeSettings = { enabledPlugins: {}, model: none, disable1m: false };

const envTruthy = (v: unknown): boolean => (typeof v === "string" ? ["1", "true", "yes", "on"].includes(v.trim().toLowerCase()) : typeof v === "number" ? v !== 0 : v === true);
const envPositiveInt = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number.parseInt(v.trim(), 10) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** ~/.claude/settings.json: enabledPlugins map + skill listing overrides + model/env that size the listing window. */
export const parseClaudeSettings = (text: string): Result<ClaudeSettings, ParseError> => {
  const r = json("settings.json", text);
  if (!r.ok) return r;
  if (!isRecord(r.value)) return err({ kind: "bad-shape", file: "settings.json", message: "not an object" });
  const ep = r.value["enabledPlugins"];
  const enabledPlugins = isRecord(ep) ? Object.fromEntries(Object.entries(ep).filter(([, v]) => typeof v === "boolean") as [string, boolean][]) : {};
  const f = r.value["skillListingBudgetFraction"];
  const m = r.value["skillListingMaxDescChars"];
  const modelRaw = r.value["model"];
  const model = typeof modelRaw === "string" && modelRaw.trim() !== "" ? some(modelRaw.trim()) : none;
  const env = isRecord(r.value["env"]) ? r.value["env"] : {};
  const fixedChars = envPositiveInt(env["SLASH_COMMAND_TOOL_CHAR_BUDGET"]);
  return ok({
    enabledPlugins,
    ...(typeof f === "number" ? { fraction: f } : {}),
    ...(typeof m === "number" ? { maxDescChars: m } : {}),
    model,
    disable1m: envTruthy(env["CLAUDE_CODE_DISABLE_1M_CONTEXT"]),
    ...(fixedChars !== undefined ? { fixedChars } : {}),
  });
};

export type ClaudeInstalled = Readonly<Record<string, { readonly version: string; readonly installPath: string }>>;

/** ~/.claude/plugins/installed_plugins.json (v2 shape: { version, plugins: { "name@mk": [{ installPath, version, ... }] } }). */
export const parseClaudeInstalled = (text: string): Result<ClaudeInstalled, ParseError> => {
  const r = json("installed_plugins.json", text);
  if (!r.ok) return r;
  if (!isRecord(r.value)) return err({ kind: "bad-shape", file: "installed_plugins.json", message: "not an object" });
  const plugins = r.value["plugins"];
  if (!isRecord(plugins)) return ok({});
  return ok(
    Object.fromEntries(
      Object.entries(plugins).flatMap(([id, v]) => {
        const first = Array.isArray(v) ? v[0] : v;
        if (!isRecord(first)) return [];
        const version = first["version"];
        const installPath = first["installPath"];
        return typeof installPath === "string" ? [[id, { version: typeof version === "string" ? version : "", installPath }] as const] : [];
      }),
    ),
  );
};

/**
 * Where a marketplace comes from. `portable` (git repo / URL) can be added on any host;
 * `local-dir` is a directory on the machine whose config named it, meaningless on another host.
 */
export type MarketplaceSource = { readonly kind: "portable"; readonly source: string } | { readonly kind: "local-dir"; readonly path: string };

export const marketplaceSourceText = (s: MarketplaceSource): string => (s.kind === "portable" ? s.source : s.path);

/** ~/.claude/plugins/known_marketplaces.json → name → source (`directory` / `file` entries are local dirs). */
export const parseClaudeMarketplaces = (text: string): Result<Readonly<Record<string, MarketplaceSource>>, ParseError> => {
  const r = json("known_marketplaces.json", text);
  if (!r.ok) return r;
  if (!isRecord(r.value)) return err({ kind: "bad-shape", file: "known_marketplaces.json", message: "not an object" });
  return ok(
    Object.fromEntries(
      Object.entries(r.value).flatMap(([name, v]) => {
        const src = isRecord(v) ? v["source"] : undefined;
        if (!isRecord(src)) return [];
        const local = src["source"] === "directory" || src["source"] === "file";
        const s = local ? src["path"] : src["repo"] ?? src["url"];
        if (typeof s !== "string") return [];
        const source: MarketplaceSource = local ? { kind: "local-dir", path: s } : { kind: "portable", source: s };
        return [[name, source] as const];
      }),
    ),
  );
};

// ---------- Codex ----------

export type CodexConfig = {
  readonly plugins: Readonly<Record<string, boolean>>;        // "name@mk" → enabled
  readonly marketplaces: Readonly<Record<string, MarketplaceSource>>; // name → source (`source_type = "local"` ⇒ local dir)
  readonly pluginsFeature: boolean;                            // [features] plugins (default true)
  /** top-level `model` — named in budget notes; skm does not read the model's context window */
  readonly model: Option<string>;
  /** `[skills] max_context_tokens` — fixed token budget for the skills catalog (Codex caps it at 10,000) */
  readonly skillsMaxContextTokens: Option<number>;
  /** top-level `model_context_window` — overrides the model's window (clamped to its max) */
  readonly modelContextWindow: Option<number>;
};

export const EMPTY_CODEX: CodexConfig = { plugins: {}, marketplaces: {}, pluginsFeature: true, model: none, skillsMaxContextTokens: none, modelContextWindow: none };

const positiveInt = (v: unknown): Option<number> => (typeof v === "number" && Number.isInteger(v) && v > 0 ? some(v) : none);

/** Codex model catalog (`codex debug models`, else ~/.codex/models_cache.json): slug → context_window / max_context_window (what Codex budgets skills against), priority and visibility (what it defaults to). */
export const parseCodexModels = (text: string): Result<CodexModels, ParseError> => {
  const r = json("models_cache.json", text);
  if (!r.ok) return r;
  if (!isRecord(r.value)) return err({ kind: "bad-shape", file: "models_cache.json", message: "not an object" });
  const models = r.value["models"];
  if (!Array.isArray(models)) return err({ kind: "bad-shape", file: "models_cache.json", message: "no models array" });
  return ok(Object.fromEntries(models.flatMap((m) => (isRecord(m) && typeof m["slug"] === "string"
    ? [[m["slug"], { contextWindow: positiveInt(m["context_window"]), maxContextWindow: positiveInt(m["max_context_window"]), priority: positiveInt(m["priority"]), listed: m["visibility"] === "list" }] as const]
    : []))));
};

/** ~/.codex/config.toml: plugin switches and marketplace sources. Uses Bun's TOML parser. */
export const parseCodexConfig = (text: string): Result<CodexConfig, ParseError> => {
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
  } catch (e) {
    return err({ kind: "bad-toml", file: "config.toml", message: e instanceof Error ? e.message : String(e) });
  }
  if (!isRecord(doc)) return err({ kind: "bad-shape", file: "config.toml", message: "not a table" });
  const plugins = isRecord(doc["plugins"])
    ? Object.fromEntries(Object.entries(doc["plugins"]).map(([id, v]) => [id, isRecord(v) && v["enabled"] === false ? false : true] as const))
    : {};
  const marketplaces = isRecord(doc["marketplaces"])
    ? Object.fromEntries(Object.entries(doc["marketplaces"]).flatMap(([name, v]): [string, MarketplaceSource][] => {
        if (!isRecord(v) || typeof v["source"] !== "string") return [];
        return [[name, v["source_type"] === "local" ? { kind: "local-dir", path: v["source"] } : { kind: "portable", source: v["source"] }]];
      }))
    : {};
  const features = doc["features"];
  const pluginsFeature = isRecord(features) && features["plugins"] === false ? false : true;
  const modelRaw = doc["model"];
  const model = typeof modelRaw === "string" && modelRaw.trim() !== "" ? some(modelRaw.trim()) : none;
  const skills = doc["skills"];
  const mct = isRecord(skills) ? skills["max_context_tokens"] : undefined;
  const skillsMaxContextTokens = positiveInt(mct);
  return ok({ plugins, marketplaces, pluginsFeature, model, skillsMaxContextTokens, modelContextWindow: positiveInt(doc["model_context_window"]) });
};

// ---------- CLI-owned skill locks ----------

/** An owned: lock file → the string at the dotted key `path` (`{skill}` = skill name); "" when the key is absent or not a string. */
export const lockVersion = (text: string, file: string, path: string, skill: string): Result<string, ParseError> => {
  const r = json(file, text);
  if (!r.ok) return r;
  const v = path.split(".").map((k) => k.replaceAll("{skill}", skill)).reduce<unknown>((o, k) => (isRecord(o) ? o[k] : undefined), r.value);
  return ok(typeof v === "string" ? v : "");
};

/** ~/.agents/.skill-lock.json (Vercel `skills` CLI) → skill name → source. */
export const parseAgentsLock = (text: string): Result<Readonly<Record<string, string>>, ParseError> => {
  const r = json(".skill-lock.json", text);
  if (!r.ok) return r;
  if (!isRecord(r.value)) return err({ kind: "bad-shape", file: ".skill-lock.json", message: "not an object" });
  const skills = r.value["skills"];
  if (!isRecord(skills)) return ok({});
  return ok(Object.fromEntries(Object.entries(skills).map(([name, v]) => [name, isRecord(v) && typeof v["source"] === "string" ? v["source"] : ""] as const)));
};

/**
 * ~/.pi/agent/settings.json `skills` → names force-excluded by skm's exact form (`-skills/<name>`, see agents.excludePattern).
 * Other entries (globs, `!pattern`, absolute paths) are left to pi and not modelled.
 */
export const parsePiSettings = (text: string): Result<ReadonlySet<string>, ParseError> => {
  const r = json("settings.json", text.replace(/^﻿/, ""));
  if (!r.ok) return r;
  if (!isRecord(r.value)) return err({ kind: "bad-shape", file: "settings.json", message: "not an object" });
  const skills = r.value["skills"];
  if (!Array.isArray(skills)) return ok(new Set());
  return ok(new Set(skills.flatMap((s) => {
    const m = typeof s === "string" ? /^-(?:\.\/)?skills\/([^/]+)(?:\/SKILL\.md)?$/.exec(s) : null;
    return m?.[1] ? [m[1]] : [];
  })));
};

// ---------- helpers ----------

const NUMERIC = /^\d+(\.\d+)*$/;

/** Natural version order: dotted numerics compare numerically and beat labels like "latest", "local", "unknown", hashes. */
export const compareVersions = (a: string, b: string): number => {
  const na = NUMERIC.test(a);
  const nb = NUMERIC.test(b);
  if (na && nb) {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    const n = Math.max(pa.length, pb.length);
    return Array.from({ length: n }, (_, i) => (pa[i] ?? 0) - (pb[i] ?? 0)).find((d) => d !== 0) ?? 0;
  }
  if (na !== nb) return na ? 1 : -1;
  return a.localeCompare(b);
};

export const highestVersion = (vs: readonly string[]): string | undefined => [...vs].sort(compareVersions).at(-1);

/** owned: skill → its tool, and the skills the Vercel `skills` CLI lock lists. */
export type Locks = { readonly owned: Readonly<Record<string, string>>; readonly skillsCli: ReadonlySet<string> };

export const ownerOf = (agentId: string, storage: Storage, name: string, locks: Locks): Owner => {
  switch (storage.kind) {
    case "store-link":
      return "skm";
    case "link-elsewhere":
      return "manual";
    case "real-dir":
      return locks.owned[name] ?? (locks.skillsCli.has(name) ? "skills-cli" : "manual");
    case "plugin-cache":
      return agentId === "claude" ? "claude-plugins" : "codex-plugins";
    case "builtin":
      return "codex-builtin";
  }
};

export const sourceText = (s: Source): string => {
  switch (s.kind) {
    case "user":
      return "user";
    case "legacy":
      return `legacy ${s.dir}`;
    case "builtin":
      return "builtin";
    case "plugin":
      return `plugin ${s.plugin}@${s.marketplace} ${s.version}`;
  }
};

export const storageText = (s: Storage): string => {
  switch (s.kind) {
    case "store-link":
      return s.direct ? "link→store" : "link→…→store";
    case "real-dir":
      return "real dir";
    case "link-elsewhere":
      return `link→${s.target}`;
    case "plugin-cache":
      return "plugin cache";
    case "builtin":
      return "builtin";
  }
};

export const parseErrorText = (e: ParseError): string => `${e.file}: ${e.kind} (${e.message})`;
