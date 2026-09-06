import { type Option, type Result, err, none, ok, some } from "../lib/result";

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

export type Owner = "skm" | "acme" | "skills-cli" | "claude-plugins" | "codex-plugins" | "codex-builtin" | "manual";

export type Enabled = "on" | "off" | "implicit";

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

/** ~/.claude/plugins/known_marketplaces.json → name → source usable by `claude plugin marketplace add`. */
export const parseClaudeMarketplaces = (text: string): Result<Readonly<Record<string, string>>, ParseError> => {
  const r = json("known_marketplaces.json", text);
  if (!r.ok) return r;
  if (!isRecord(r.value)) return err({ kind: "bad-shape", file: "known_marketplaces.json", message: "not an object" });
  return ok(
    Object.fromEntries(
      Object.entries(r.value).flatMap(([name, v]) => {
        const src = isRecord(v) ? v["source"] : undefined;
        if (!isRecord(src)) return [];
        const s = src["repo"] ?? src["url"] ?? src["path"];
        return typeof s === "string" ? [[name, s] as const] : [];
      }),
    ),
  );
};

// ---------- Codex ----------

export type CodexConfig = {
  readonly plugins: Readonly<Record<string, boolean>>;        // "name@mk" → enabled
  readonly marketplaces: Readonly<Record<string, string>>;    // name → source
  readonly pluginsFeature: boolean;                            // [features] plugins (default true)
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
    ? Object.fromEntries(Object.entries(doc["marketplaces"]).flatMap(([name, v]) => (isRecord(v) && typeof v["source"] === "string" ? [[name, v["source"]] as const] : [])))
    : {};
  const features = doc["features"];
  const pluginsFeature = isRecord(features) && features["plugins"] === false ? false : true;
  return ok({ plugins, marketplaces, pluginsFeature });
};

// ---------- CLI-owned skill locks ----------

/** ~/.local/share/acme/data/skill-lock.json → skill name → acme version that wrote it. */
export const parseAcmeLock = (text: string): Result<Readonly<Record<string, string>>, ParseError> => {
  const r = json("skill-lock.json", text);
  if (!r.ok) return r;
  if (!isRecord(r.value)) return err({ kind: "bad-shape", file: "skill-lock.json", message: "not an object" });
  const g = r.value["global"];
  const skills = isRecord(g) ? g["skills"] : undefined;
  if (!isRecord(skills)) return ok({});
  return ok(Object.fromEntries(Object.entries(skills).map(([name, v]) => [name, isRecord(v) && typeof v["acmeVersion"] === "string" ? v["acmeVersion"] : ""] as const)));
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

export type Locks = { readonly acme: ReadonlySet<string>; readonly skillsCli: ReadonlySet<string> };

export const ownerOf = (agentId: string, storage: Storage, name: string, locks: Locks): Owner => {
  switch (storage.kind) {
    case "store-link":
      return "skm";
    case "link-elsewhere":
      return "manual";
    case "real-dir":
      return locks.acme.has(name) ? "acme" : locks.skillsCli.has(name) ? "skills-cli" : "manual";
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
