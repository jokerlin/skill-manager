import { readFile } from "node:fs/promises";
import { withExtensions } from "./extensions";
import { type Agent, resolveAgent } from "../core/agents";
import { type Config, type ConfigError, configErrorText, parseConfig } from "../core/config";
import type { Skill } from "../core/skill";
import type { BudgetOverrides } from "../core/budget";
import { type MarketplaceSource, parseClaudeMarketplaces, parseClaudeSettings, parseCodexConfig } from "../core/sources";
import { type Result, err, ok } from "../lib/result";
import { expandHome, homeDir, skmHome } from "./paths";
import { type StoreError, loadStore } from "./store";

export type AppState = {
  readonly skmHome: string;
  readonly configPath: string;
  readonly config: Config;
  readonly storeDir: string;          // absolute
  readonly skills: readonly Skill[];
  readonly ignoredDirs: readonly string[];
  readonly agents: readonly Agent[];  // config.agents resolved
  readonly unknownAgents: readonly string[];
  /** overrides read from ~/.claude/settings.json, if any */
  readonly claudeOverrides: BudgetOverrides;
  /** marketplace name → source, from the hub's own claude/codex config (used to add marketplaces on hosts that lack them) */
  readonly hubMarketplaces: Readonly<Record<string, MarketplaceSource>>;
};

export type AppError =
  | { readonly kind: "no-config"; readonly path: string }
  | { readonly kind: "config"; readonly path: string; readonly error: ConfigError }
  | { readonly kind: "store"; readonly error: StoreError };

export const appErrorText = (e: AppError): string => {
  switch (e.kind) {
    case "no-config":
      return `no config at ${e.path} — run \`skm init\` first`;
    case "config":
      return `${e.path}: ${configErrorText(e.error)}`;
    case "store":
      return `cannot read store ${e.error.dir}: ${e.error.message}`;
  }
};

export const readClaudeOverrides = async (home: string = homeDir()): Promise<AppState["claudeOverrides"]> => {
  const text = await readFile(`${home}/.claude/settings.json`, "utf8").catch(() => undefined);
  if (text === undefined) return {};
  const r = parseClaudeSettings(text);
  if (!r.ok) return {};
  return {
    ...(r.value.fraction !== undefined ? { fraction: r.value.fraction } : {}),
    ...(r.value.maxDescChars !== undefined ? { maxDescChars: r.value.maxDescChars } : {}),
    ...(r.value.fixedChars !== undefined ? { fixedChars: r.value.fixedChars } : {}),
  };
};

/** Marketplaces the hub machine knows, from both agents' config files. Codex entries win on name clashes (they carry full URLs). */
export const readHubMarketplaces = async (home: string = homeDir()): Promise<Readonly<Record<string, MarketplaceSource>>> => {
  const claudeText = await readFile(`${home}/.claude/plugins/known_marketplaces.json`, "utf8").catch(() => undefined);
  const codexText = await readFile(`${home}/.codex/config.toml`, "utf8").catch(() => undefined);
  const claude = claudeText === undefined ? undefined : parseClaudeMarketplaces(claudeText);
  const codex = codexText === undefined ? undefined : parseCodexConfig(codexText);
  return { ...(claude?.ok ? claude.value : {}), ...(codex?.ok ? codex.value.marketplaces : {}) };
};

export const configPathFor = (skm: string = skmHome()): string => `${skm}/config.yaml`;

export const loadApp = async (skm: string = skmHome()): Promise<Result<AppState, AppError>> => {
  const configPath = configPathFor(skm);
  const text = await readFile(configPath, "utf8").catch(() => undefined);
  if (text === undefined) return err({ kind: "no-config", path: configPath });
  const cfg = parseConfig(text);
  if (!cfg.ok) return err({ kind: "config", path: configPath, error: cfg.error });
  return loadWith(skm, configPath, await withExtensions(skm, cfg.value));
};

/** Build AppState from an already-parsed config (used after in-memory edits). */
export const loadWith = async (skm: string, configPath: string, config: Config): Promise<Result<AppState, AppError>> => {
  const storeDir = expandHome(config.store);
  const scan = await loadStore(storeDir);
  if (!scan.ok) return err({ kind: "store", error: scan.error });
  const resolved = config.agents.map((id) => ({ id, agent: resolveAgent(id, config.agentOverrides, config.registry.agents) }));
  const agents = resolved.flatMap((r) => (r.agent.some ? [r.agent.value] : []));
  return ok({
    skmHome: skm,
    configPath,
    // All clients (CLI, TUI, macOS) use this list for their target columns.
    config: { ...config, agents: agents.map((a) => a.id) },
    storeDir,
    skills: scan.value.skills,
    ignoredDirs: scan.value.ignored,
    agents,
    unknownAgents: resolved.flatMap((r) => (r.agent.some ? [] : [r.id])),
    claudeOverrides: await readClaudeOverrides(),
    hubMarketplaces: await readHubMarketplaces(),
  });
};
