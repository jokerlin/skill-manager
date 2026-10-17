import { type Option, none, some } from "../lib/result";
import { estimateTokens } from "../lib/tokens";
import type { Agent } from "./agents";
import type { CodexModels } from "./codex-model";
import { descriptionText, listingText, parseSkillMd } from "./frontmatter";
import { type Entry, type Inventory, entryHash } from "./inventory";
import {
  type ClaudeInstalled,
  type CodexConfig,
  EMPTY_CLAUDE_SETTINGS,
  EMPTY_CODEX,
  type Enabled,
  type Locks,
  type MarketplaceSource,
  type Owner,
  type Source,
  type Storage,
  highestVersion,
  ownerOf,
  parseAgentsLock,
  parseAcmeLock,
  parseClaudeInstalled,
  parseClaudeMarketplaces,
  parseCodexModels,
  parseClaudeSettings,
  parseCodexConfig,
  parseErrorText,
  parsePiSettings,
} from "./sources";

/**
 * "Effective" view of a host: what each agent will actually load, derived purely from a v2 Inventory.
 */

export type HostFacts = {
  readonly claudeEnabled: Readonly<Record<string, boolean>>;
  readonly claudeInstalled: ClaudeInstalled;
  readonly claudeMarketplaces: Readonly<Record<string, MarketplaceSource>>;
  readonly claudeOverrides: { readonly fraction?: number; readonly maxDescChars?: number; readonly fixedChars?: number };
  /** `model` from settings.json — sizes the window the listing budget is 1% of. */
  readonly claudeModel: Option<string>;
  readonly claudeDisable1m: boolean;
  readonly codex: CodexConfig;
  /** ~/.codex/models_cache.json — slug → context window, sizes the Codex skills budget */
  readonly codexModels: CodexModels;
  readonly locks: Locks;
  readonly acmeVersions: Readonly<Record<string, string>>;
  /** agent id → skill names its settings force-exclude (pi: `-skills/<name>` in ~/.pi/agent/settings.json); the agent skips them in every dir it scans */
  readonly excluded: Readonly<Record<string, ReadonlySet<string>>>;
  readonly errors: readonly string[];
};


/** Parse every config/lock file the probe shipped. Parse failures become `errors`, never exceptions. */
export const hostFacts = (inv: Inventory): HostFacts => {
  const errors: string[] = [];
  const use = <T>(id: string, parse: (t: string) => { ok: true; value: T } | { ok: false; error: { kind: string; file: string; message: string } }, fallback: T): T => {
    const text = inv.files[id];
    if (text === undefined) return fallback;
    const r = parse(text);
    if (r.ok) return r.value;
    errors.push(`${id}: ${parseErrorText(r.error as Parameters<typeof parseErrorText>[0])}`);
    return fallback;
  };
  const settings = use("claude-settings", parseClaudeSettings, EMPTY_CLAUDE_SETTINGS);
  const acme = use("acme-lock", parseAcmeLock, {});
  const agentsLock = use("agents-lock", parseAgentsLock, {});
  return {
    claudeEnabled: settings.enabledPlugins,
    claudeInstalled: use("claude-installed", parseClaudeInstalled, {}),
    claudeMarketplaces: use("claude-marketplaces", parseClaudeMarketplaces, {}),
    claudeOverrides: {
      ...(settings.fraction !== undefined ? { fraction: settings.fraction } : {}),
      ...(settings.maxDescChars !== undefined ? { maxDescChars: settings.maxDescChars } : {}),
      ...(settings.fixedChars !== undefined ? { fixedChars: settings.fixedChars } : {}),
    },
    claudeModel: settings.model,
    claudeDisable1m: settings.disable1m,
    codex: use("codex-config", parseCodexConfig, EMPTY_CODEX),
    codexModels: use("codex-models", parseCodexModels, {}),
    locks: { acme: new Set(Object.keys(acme)), skillsCli: new Set(Object.keys(agentsLock)) },
    acmeVersions: acme,
    excluded: { pi: use("pi-settings", parsePiSettings, new Set<string>()) },
    errors,
  };
};

// ---------- plugins ----------

export type PluginState = {
  readonly agent: string;
  readonly marketplace: string;
  readonly name: string;
  readonly id: string;                        // name@marketplace
  readonly enabled: Enabled;
  /** the agent's own config names this plugin at all (Claude: enabledPlugins or installed_plugins.json; Codex: a [plugins."id"] table); false ⇒ a bare cache leftover the agent never loads */
  readonly configured: boolean;
  /** the plugin's marketplace is configured for the agent on this host */
  readonly marketplaceKnown: boolean;
  readonly active: Option<{ readonly version: string; readonly dir: string; readonly skills: readonly string[] }>;
  readonly cachedVersions: readonly string[];
};

const splitId = (id: string): { name: string; marketplace: string } => {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: "" };
};

const skillsIn = (inv: Inventory, agent: string, dir: string): string[] =>
  inv.pluginSkills.filter((p) => p.agent === agent && p.dir === dir).map((p) => p.name).sort();

/** Every plugin an agent knows about on this host (configured, installed, or merely cached). */
export const pluginStates = (inv: Inventory, facts: HostFacts, agentId: string): PluginState[] => {
  const cache = inv.pluginCache.filter((p) => p.agent === agentId);
  const cachedIds = new Set(cache.map((p) => `${p.plugin}@${p.marketplace}`));
  const versionsOf = (id: string) => cache.filter((p) => `${p.plugin}@${p.marketplace}` === id).map((p) => p.version).sort();
  const dirOf = (id: string, version: string) => cache.find((p) => `${p.plugin}@${p.marketplace}` === id && p.version === version)?.dir;
  switch (agentId) {
    case "claude": {
      const ids = [...new Set([...Object.keys(facts.claudeEnabled), ...Object.keys(facts.claudeInstalled), ...cachedIds])].sort();
      return ids.map((id) => {
        const inst = facts.claudeInstalled[id];
        return {
          agent: agentId, ...splitId(id), id,
          enabled: facts.claudeEnabled[id] === true ? "on" : "off",
          configured: facts.claudeEnabled[id] !== undefined || inst !== undefined,
          marketplaceKnown: facts.claudeMarketplaces[splitId(id).marketplace] !== undefined,
          active: inst ? some({ version: inst.version, dir: inst.installPath, skills: skillsIn(inv, agentId, inst.installPath) }) : none,
          cachedVersions: versionsOf(id),
        };
      });
    }
    case "codex": {
      const ids = [...new Set([...Object.keys(facts.codex.plugins), ...cachedIds])].sort();
      return ids.map((id) => {
        const configured = facts.codex.plugins[id];
        const versions = versionsOf(id);
        const top = highestVersion(versions);
        const dir = top === undefined ? undefined : dirOf(id, top);
        // cached without a config.toml entry ⇒ not installed: Codex 0.153.4 leaves such plugins out of the model-visible catalog (verified 2026-09-06)
        const enabled: Enabled = !facts.codex.pluginsFeature ? "off" : configured === undefined ? "off" : configured ? "on" : "off";
        return {
          agent: agentId, ...splitId(id), id, enabled,
          configured: configured !== undefined,
          marketplaceKnown: facts.codex.marketplaces[splitId(id).marketplace] !== undefined,
          active: top !== undefined && dir !== undefined ? some({ version: top, dir, skills: skillsIn(inv, agentId, dir) }) : none,
          cachedVersions: versions,
        };
      });
    }
    default:
      return [];
  }
};

// ---------- effective entries ----------

export type Effective = {
  readonly agent: string;
  readonly name: string;
  readonly source: Source;
  readonly storage: Storage;
  readonly owner: Owner;
  readonly path: string;
  readonly version: Option<string>;
  readonly enabled: "on";
  /** false when Codex hides the skill from the model-visible catalog (agents/openai.yaml policy.allow_implicit_invocation: false); it still loads and answers `$skill`, but costs nothing at startup */
  readonly promptVisible: boolean;
  readonly listing: string;
  /** frontmatter `description` alone — what Codex lists; Claude lists `listing` (description + when_to_use) */
  readonly description: string;
  readonly listingChars: number;
  /** o200k estimate of `listing` — agent-agnostic; each agent's own accounting lives in its BudgetReport */
  readonly listingTokens: number;
  readonly bodyTokens: number;
  readonly hash: string;
};

type DocInfo = { readonly listing: string; readonly description: string; readonly listingTokens: number; readonly bodyTokens: number };
const docMemo = new Map<string, DocInfo>();

/** Listing text + body token estimate for a SKILL.md, memoized by content hash (the same plugin docs recur on every host). */
export const docInfo = (hash: string, text: string | undefined): DocInfo => {
  if (text === undefined) return { listing: "", description: "", listingTokens: 0, bodyTokens: 0 };
  const hit = docMemo.get(hash);
  if (hit) return hit;
  const parsed = parseSkillMd(text);
  const listing = parsed.ok ? listingText(parsed.value.frontmatter) : "";
  const info: DocInfo = parsed.ok
    ? { listing, description: descriptionText(parsed.value.frontmatter), listingTokens: estimateTokens(listing), bodyTokens: estimateTokens(parsed.value.body) }
    : { listing, description: "", listingTokens: 0, bodyTokens: estimateTokens(text) };
  if (hash.length > 0) docMemo.set(hash, info);
  return info;
};

const storageOf = (e: Entry): Storage | undefined => {
  switch (e.kind) {
    case "managed":
      return { kind: "store-link", direct: e.direct };
    case "dir":
      return { kind: "real-dir" };
    case "foreign-link":
      return { kind: "link-elsewhere", target: e.target };
    case "broken-link":
    case "file":
      return undefined;
  }
};

/** Only Codex honours agents/openai.yaml; every other agent lists everything it loads. */
const visibleFor = (inv: Inventory, agentId: string, path: string): boolean => agentId !== "codex" || !inv.hidden.some((h) => h.agent === agentId && h.dir === path);

const fromEntry = (inv: Inventory, facts: HostFacts, agentId: string, e: Entry, path: string, source: Source): Effective | undefined => {
  const storage = storageOf(e);
  if (storage === undefined) return undefined;
  const hash = entryHash(e);
  if (hash === "") return undefined; // no SKILL.md: agents skip the directory, so it costs nothing
  const owner = ownerOf(agentId, storage, e.name, facts.locks);
  const info = docInfo(hash, inv.docs[hash]);
  const v = owner === "acme" ? facts.acmeVersions[e.name] : undefined;
  return { agent: agentId, name: e.name, source, storage, owner, path, version: v ? some(v) : none, enabled: "on", promptVisible: visibleFor(inv, agentId, path), listing: info.listing, description: info.description, listingChars: info.listing.length, listingTokens: info.listingTokens, bodyTokens: info.bodyTokens, hash };
};

const SOURCE_ORDER: Record<Source["kind"], number> = { user: 0, legacy: 1, builtin: 2, plugin: 3 };

/** A copy in an alsoReads dir that the agent skips because the user dir already has that name (agents with `duplicates: "user-dir-first"`). */
export type Shadowed = {
  readonly agent: string;
  readonly name: string;
  readonly path: string;    // the skipped copy
  readonly winner: string;  // the user-dir copy that loads instead
  readonly sameContent: boolean;
};

const partition = <T>(xs: readonly T[], keep: (x: T) => boolean): [T[], T[]] =>
  xs.reduce<[T[], T[]]>(([yes, no], x) => (keep(x) ? [[...yes, x], no] : [yes, [...no, x]]), [[], []]);

/** What `agent` loads on this host (source order, then name) and the alsoReads copies it skips. Pure. */
export const loadedFor = (inv: Inventory, facts: HostFacts, agent: Agent): { readonly loaded: Effective[]; readonly shadowed: Shadowed[] } => {
  const home = inv.home;
  const excluded = facts.excluded[agent.id] ?? new Set<string>();
  const kept = (es: readonly Entry[]): Entry[] => es.filter((e) => !excluded.has(e.name));
  const user = kept(inv.agentDirs[agent.id]?.entries ?? []).flatMap((e) => {
    const x = fromEntry(inv, facts, agent.id, e, `${agent.userDir(home)}/${e.name}`, { kind: "user" });
    return x ? [x] : [];
  });
  const alsoRead = kept(inv.alsoReads[agent.id] ?? []).flatMap((e) => {
    const dir = inv.alsoDirs[agent.id]?.[e.name] ?? agent.alsoReads[0]?.(home) ?? "";
    const x = fromEntry(inv, facts, agent.id, e, `${dir}/${e.name}`, { kind: "legacy", dir });
    return x ? [x] : [];
  });
  const byName = new Map(user.map((e) => [e.name, e]));
  const [legacy, skipped] = agent.duplicates === "user-dir-first" ? partition(alsoRead, (e) => !byName.has(e.name)) : [alsoRead, []];
  const shadowed = skipped.flatMap((e): Shadowed[] => {
    const w = byName.get(e.name);
    return w === undefined ? [] : [{ agent: agent.id, name: e.name, path: e.path, winner: w.path, sameContent: w.hash === e.hash }];
  });
  const builtin = inv.builtins.filter((b) => b.agent === agent.id).map((b): Effective => {
    const info = docInfo(b.hash, inv.docs[b.hash]);
    return { agent: agent.id, name: b.name, source: { kind: "builtin" }, storage: { kind: "builtin" }, owner: "codex-builtin", path: b.dir, version: none, enabled: "on", promptVisible: visibleFor(inv, agent.id, b.dir), listing: info.listing, description: info.description, listingChars: info.listing.length, listingTokens: info.listingTokens, bodyTokens: info.bodyTokens, hash: b.hash };
  });
  const plugin = pluginStates(inv, facts, agent.id).flatMap((p): Effective[] => {
    if (p.enabled === "off" || !p.active.some) return [];
    const { version, dir } = p.active.value;
    return inv.pluginSkills
      .filter((s) => s.agent === agent.id && s.dir === dir)
      .map((s) => {
        const info = docInfo(s.hash, inv.docs[s.hash]);
        return {
          agent: agent.id, name: s.name, source: { kind: "plugin", marketplace: p.marketplace, plugin: p.name, version }, storage: { kind: "plugin-cache" },
          owner: ownerOf(agent.id, { kind: "plugin-cache" }, s.name, facts.locks), path: s.skillDir, version: some(version), enabled: "on", promptVisible: visibleFor(inv, agent.id, s.skillDir),
          listing: info.listing, description: info.description, listingChars: info.listing.length, listingTokens: info.listingTokens, bodyTokens: info.bodyTokens, hash: s.hash,
        };
      });
  });
  return { loaded: [...user, ...legacy, ...builtin, ...plugin].sort((a, b) => SOURCE_ORDER[a.source.kind] - SOURCE_ORDER[b.source.kind] || a.name.localeCompare(b.name)), shadowed };
};

/** Everything `agent` loads on this host. */
export const effectiveFor = (inv: Inventory, facts: HostFacts, agent: Agent): Effective[] => loadedFor(inv, facts, agent).loaded;

/** The alsoReads copies `agent` skips on this host. */
export const shadowedFor = (inv: Inventory, facts: HostFacts, agent: Agent): Shadowed[] => loadedFor(inv, facts, agent).shadowed;

// ---------- findings ----------

export type Finding =
  | { readonly kind: "same-name"; readonly host: string; readonly agent: string; readonly name: string; readonly paths: readonly string[] }
  | { readonly kind: "linked-twice"; readonly host: string; readonly agent: string; readonly names: readonly string[]; readonly dirs: readonly string[] }
  /** copies under `dir` the agent skips because `winner` already has the name; `differing` = those whose SKILL.md is not identical to the winner's */
  | { readonly kind: "shadowed"; readonly host: string; readonly agent: string; readonly names: readonly string[]; readonly differing: readonly string[]; readonly winner: string; readonly dir: string }
  | { readonly kind: "same-content"; readonly host: string; readonly agent: string; readonly hash: string; readonly names: readonly string[]; readonly paths: readonly string[] }
  | { readonly kind: "stale-cache"; readonly host: string; readonly agent: string; readonly plugin: string; readonly versions: readonly string[] }
  | { readonly kind: "disabled-cached"; readonly host: string; readonly agent: string; readonly plugin: string }
  | { readonly kind: "unloaded-cache"; readonly host: string; readonly agent: string; readonly plugin: string; readonly marketplaceKnown: boolean }
  | { readonly kind: "version-drift"; readonly plugin: string; readonly cells: readonly { readonly host: string; readonly agent: string; readonly version: string }[] }
  | { readonly kind: "owned-drift"; readonly host: string; readonly name: string; readonly owner: Owner; readonly ownerPath: string; readonly agents: readonly string[]; readonly storeHash: string; readonly ownerHash: string };

const groupBy = <T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> =>
  xs.reduce((m, x) => { const k = key(x); m.set(k, [...(m.get(k) ?? []), x]); return m; }, new Map<string, T[]>());

const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/"));

/** Findings visible from one host: duplicates within an agent, shadowed alsoReads copies, plugin cache hygiene. */
export const hostFindings = (
  host: string,
  effective: Readonly<Record<string, readonly Effective[]>>,
  states: Readonly<Record<string, readonly PluginState[]>>,
  shadowed: Readonly<Record<string, readonly Shadowed[]>> = {},
): Finding[] => {
  const perAgent = Object.entries(effective).flatMap(([agent, es]): Finding[] => {
    const byName = [...groupBy(es, (e) => e.name).entries()].filter(([, g]) => new Set(g.map((e) => e.path)).size > 1);
    // the same store skill linked from two dirs the agent scans (e.g. ~/.pi/agent/skills + ~/.agents/skills): one finding, not one per skill
    const twice = byName.filter(([, g]) => g.every((e) => e.storage.kind === "store-link"));
    const distinct = byName.filter(([, g]) => !g.every((e) => e.storage.kind === "store-link"));
    const namePathSets = new Set(byName.map(([, g]) => g.map((e) => e.path).sort().join("|")));
    const byHash = [...groupBy(es.filter((e) => e.hash.length > 0), (e) => e.hash).entries()]
      .filter(([, g]) => new Set(g.map((e) => e.path)).size > 1)
      .filter(([, g]) => !namePathSets.has(g.map((e) => e.path).sort().join("|"))); // already reported as same-name
    return [
      ...(twice.length > 0 ? [{ kind: "linked-twice" as const, host, agent, names: twice.map(([name]) => name), dirs: [...new Set(twice.flatMap(([, g]) => g.map((e) => dirOf(e.path))))] }] : []),
      ...distinct.map(([name, g]): Finding => ({ kind: "same-name", host, agent, name, paths: g.map((e) => e.path) })),
      ...byHash.map(([hash, g]): Finding => ({ kind: "same-content", host, agent, hash, names: [...new Set(g.map((e) => e.name))], paths: g.map((e) => e.path) })),
    ];
  });
  const plugins = Object.entries(states).flatMap(([agent, ps]): Finding[] =>
    ps.flatMap((p): Finding[] => {
      const stale = p.cachedVersions.filter((v) => !(p.active.some && p.active.value.version === v));
      return [
        ...(stale.length > 0 ? [{ kind: "stale-cache" as const, host, agent, plugin: p.id, versions: stale }] : []),
        // cached + switched off in the agent's config ⇒ disabled-cached; cached + never mentioned in that config ⇒ unloaded-cache (a leftover the agent never loads)
        ...(p.enabled === "off" && p.cachedVersions.length > 0
          ? [p.configured ? { kind: "disabled-cached" as const, host, agent, plugin: p.id } : { kind: "unloaded-cache" as const, host, agent, plugin: p.id, marketplaceKnown: p.marketplaceKnown }]
          : []),
      ];
    }),
  );
  // a CLI-owned skill (real dir the tool wrote) that other agents load as a store link: the two copies should match, or the store copy is stale
  const all = Object.entries(effective).flatMap(([agent, es]) => es.map((e) => ({ agent, e })));
  const drift = [...groupBy(all, ({ e }) => e.name).entries()].flatMap(([name, g]): Finding[] => {
    const written = g.find(({ e }) => e.storage.kind === "real-dir" && e.owner !== "skm" && e.owner !== "manual" && e.hash.length > 0);
    if (written === undefined) return [];
    const linked = g.filter(({ e }) => e.storage.kind === "store-link" && e.hash.length > 0 && e.hash !== written.e.hash);
    if (linked.length === 0) return [];
    return [{ kind: "owned-drift", host, name, owner: written.e.owner, ownerPath: written.e.path, agents: [...new Set(linked.map(({ agent }) => agent))].sort(), storeHash: linked[0]?.e.hash ?? "", ownerHash: written.e.hash }];
  });
  const skipped = Object.entries(shadowed).flatMap(([agent, ss]): Finding[] =>
    [...groupBy(ss, (x) => `${dirOf(x.winner)}|${dirOf(x.path)}`).values()].map((g): Finding => ({
      kind: "shadowed", host, agent,
      names: g.map((x) => x.name).sort(),
      differing: g.filter((x) => !x.sameContent).map((x) => x.name).sort(),
      winner: dirOf(g[0]?.winner ?? ""),
      dir: dirOf(g[0]?.path ?? ""),
    })),
  );
  return [...perAgent, ...skipped, ...plugins, ...drift];
};

/** A plugin (by name) active at different versions across hosts or agents. */
export const driftFindings = (perHost: readonly { readonly host: string; readonly states: Readonly<Record<string, readonly PluginState[]>> }[]): Finding[] => {
  const cells = perHost.flatMap((h) =>
    Object.entries(h.states).flatMap(([agent, ps]) => ps.flatMap((p) => (p.active.some && p.enabled !== "off" ? [{ plugin: p.name, host: h.host, agent, version: p.active.value.version }] : []))),
  );
  return [...groupBy(cells, (c) => c.plugin).entries()]
    .filter(([, g]) => new Set(g.map((c) => c.version)).size > 1)
    .map(([plugin, g]): Finding => ({ kind: "version-drift", plugin, cells: g.map(({ host, agent, version }) => ({ host, agent, version })) }));
};

/** Findings that concern one agent's view (host-wide ones such as version-drift are excluded; owned-drift names the agents that hold the stale link). */
export const findingConcerns = (f: Finding, agentId: string): boolean =>
  f.kind === "version-drift" ? false : f.kind === "owned-drift" ? f.agents.includes(agentId) : f.agent === agentId;

export const findingText = (f: Finding): string => {
  switch (f.kind) {
    case "same-name":
      return `${f.host}/${f.agent}: "${f.name}" appears ${f.paths.length}× — ${f.paths.join(", ")}`;
    case "linked-twice":
      return `${f.host}/${f.agent}: ${f.names.length} store skills load twice (${f.dirs.join(" and ")} both link to the store): ${f.names.join(", ")}`;
    case "shadowed":
      return `${f.host}/${f.agent}: ${f.names.length} copies under ${f.dir} are shadowed by ${f.winner} (${f.agent} keeps the first root's copy per name, nothing loads twice): ${f.names.join(", ")}${f.differing.length > 0 ? ` — content differs from the loaded copy: ${f.differing.join(", ")}` : ""}`;
    case "same-content":
      return `${f.host}/${f.agent}: identical SKILL.md (${f.names.join("/")}) at ${f.paths.join(", ")}`;
    case "stale-cache":
      return `${f.host}/${f.agent}: ${f.plugin} has unused cached versions ${f.versions.join(", ")}`;
    case "disabled-cached":
      return `${f.host}/${f.agent}: ${f.plugin} is cached but disabled`;
    case "unloaded-cache":
      return `${f.host}/${f.agent}: ${f.plugin} is a cache leftover — no entry in ${f.agent === "codex" ? "config.toml [plugins]" : "settings.json enabledPlugins / installed_plugins.json"}, so ${f.agent} never loads it${f.marketplaceKnown ? "" : " (its marketplace is not configured either)"}`;
    case "version-drift":
      return `${f.plugin}: ${f.cells.map((c) => `${c.host}/${c.agent}=${c.version}`).join("  ")}`;
    case "owned-drift":
      return `${f.host}: the store copy of ${f.name} linked for ${f.agents.join("/")} differs from the ${f.owner}-written ${f.ownerPath} — refresh the store from that dir`;
  }
};

export const sourceCounts = (es: readonly Effective[]): Record<Source["kind"], number> =>
  es.reduce((acc, e) => ({ ...acc, [e.source.kind]: acc[e.source.kind] + 1 }), { user: 0, legacy: 0, builtin: 0, plugin: 0 });
