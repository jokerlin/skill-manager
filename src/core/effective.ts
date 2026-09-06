import { type Option, none, some } from "../lib/result";
import { estimateTokens } from "../lib/tokens";
import type { Agent } from "./agents";
import { listingText, parseSkillMd } from "./frontmatter";
import { type Entry, type Inventory, entryHash } from "./inventory";
import {
  type ClaudeInstalled,
  type CodexConfig,
  EMPTY_CLAUDE_SETTINGS,
  type Enabled,
  type Locks,
  type Owner,
  type Source,
  type Storage,
  highestVersion,
  ownerOf,
  parseAgentsLock,
  parseAcmeLock,
  parseClaudeInstalled,
  parseClaudeMarketplaces,
  parseClaudeSettings,
  parseCodexConfig,
  parseErrorText,
} from "./sources";

/**
 * "Effective" view of a host: what each agent will actually load, derived purely from a v2 Inventory.
 */

export type HostFacts = {
  readonly claudeEnabled: Readonly<Record<string, boolean>>;
  readonly claudeInstalled: ClaudeInstalled;
  readonly claudeMarketplaces: Readonly<Record<string, string>>;
  readonly claudeOverrides: { readonly fraction?: number; readonly maxDescChars?: number; readonly fixedChars?: number };
  /** `model` from settings.json — sizes the window the listing budget is 1% of. */
  readonly claudeModel: Option<string>;
  readonly claudeDisable1m: boolean;
  readonly codex: CodexConfig;
  readonly locks: Locks;
  readonly acmeVersions: Readonly<Record<string, string>>;
  readonly errors: readonly string[];
};

const EMPTY_CODEX: CodexConfig = { plugins: {}, marketplaces: {}, pluginsFeature: true };

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
    locks: { acme: new Set(Object.keys(acme)), skillsCli: new Set(Object.keys(agentsLock)) },
    acmeVersions: acme,
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
        const enabled: Enabled = !facts.codex.pluginsFeature ? "off" : configured === undefined ? (versions.length > 0 ? "implicit" : "off") : configured ? "on" : "off";
        return {
          agent: agentId, ...splitId(id), id, enabled,
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
  readonly enabled: "on" | "implicit";
  readonly listing: string;
  readonly listingChars: number;
  readonly bodyTokens: number;
  readonly hash: string;
};

type DocInfo = { readonly listing: string; readonly bodyTokens: number };
const docMemo = new Map<string, DocInfo>();

/** Listing text + body token estimate for a SKILL.md, memoized by content hash (the same plugin docs recur on every host). */
export const docInfo = (hash: string, text: string | undefined): DocInfo => {
  if (text === undefined) return { listing: "", bodyTokens: 0 };
  const hit = docMemo.get(hash);
  if (hit) return hit;
  const parsed = parseSkillMd(text);
  const info: DocInfo = parsed.ok ? { listing: listingText(parsed.value.frontmatter), bodyTokens: estimateTokens(parsed.value.body) } : { listing: "", bodyTokens: estimateTokens(text) };
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

const fromEntry = (inv: Inventory, facts: HostFacts, agentId: string, e: Entry, path: string, source: Source): Effective | undefined => {
  const storage = storageOf(e);
  if (storage === undefined) return undefined;
  const hash = entryHash(e);
  if (hash === "") return undefined; // no SKILL.md: agents skip the directory, so it costs nothing
  const owner = ownerOf(agentId, storage, e.name, facts.locks);
  const info = docInfo(hash, inv.docs[hash]);
  const v = owner === "acme" ? facts.acmeVersions[e.name] : undefined;
  return { agent: agentId, name: e.name, source, storage, owner, path, version: v ? some(v) : none, enabled: "on", listing: info.listing, listingChars: info.listing.length, bodyTokens: info.bodyTokens, hash };
};

const SOURCE_ORDER: Record<Source["kind"], number> = { user: 0, legacy: 1, builtin: 2, plugin: 3 };

/** Everything `agent` loads on this host, in source order then by name. Pure. */
export const effectiveFor = (inv: Inventory, facts: HostFacts, agent: Agent): Effective[] => {
  const home = inv.home;
  const user = (inv.agentDirs[agent.id]?.entries ?? []).flatMap((e) => {
    const x = fromEntry(inv, facts, agent.id, e, `${agent.userDir(home)}/${e.name}`, { kind: "user" });
    return x ? [x] : [];
  });
  const legacy = (inv.alsoReads[agent.id] ?? []).flatMap((e) => {
    const dir = inv.alsoDirs[agent.id]?.[e.name] ?? agent.alsoReads[0]?.(home) ?? "";
    const x = fromEntry(inv, facts, agent.id, e, `${dir}/${e.name}`, { kind: "legacy", dir });
    return x ? [x] : [];
  });
  const builtin = inv.builtins.filter((b) => b.agent === agent.id).map((b): Effective => {
    const info = docInfo(b.hash, inv.docs[b.hash]);
    return { agent: agent.id, name: b.name, source: { kind: "builtin" }, storage: { kind: "builtin" }, owner: "codex-builtin", path: b.dir, version: none, enabled: "on", listing: info.listing, listingChars: info.listing.length, bodyTokens: info.bodyTokens, hash: b.hash };
  });
  const plugin = pluginStates(inv, facts, agent.id).flatMap((p): Effective[] => {
    if (p.enabled === "off" || !p.active.some) return [];
    const { version, dir } = p.active.value;
    const enabled = p.enabled;
    return inv.pluginSkills
      .filter((s) => s.agent === agent.id && s.dir === dir)
      .map((s) => {
        const info = docInfo(s.hash, inv.docs[s.hash]);
        return {
          agent: agent.id, name: s.name, source: { kind: "plugin", marketplace: p.marketplace, plugin: p.name, version }, storage: { kind: "plugin-cache" },
          owner: ownerOf(agent.id, { kind: "plugin-cache" }, s.name, facts.locks), path: s.skillDir, version: some(version), enabled,
          listing: info.listing, listingChars: info.listing.length, bodyTokens: info.bodyTokens, hash: s.hash,
        };
      });
  });
  return [...user, ...legacy, ...builtin, ...plugin].sort((a, b) => SOURCE_ORDER[a.source.kind] - SOURCE_ORDER[b.source.kind] || a.name.localeCompare(b.name));
};

// ---------- findings ----------

export type Finding =
  | { readonly kind: "same-name"; readonly host: string; readonly agent: string; readonly name: string; readonly paths: readonly string[] }
  | { readonly kind: "linked-twice"; readonly host: string; readonly agent: string; readonly names: readonly string[]; readonly dirs: readonly string[] }
  | { readonly kind: "same-content"; readonly host: string; readonly agent: string; readonly hash: string; readonly names: readonly string[]; readonly paths: readonly string[] }
  | { readonly kind: "stale-cache"; readonly host: string; readonly agent: string; readonly plugin: string; readonly versions: readonly string[] }
  | { readonly kind: "disabled-cached"; readonly host: string; readonly agent: string; readonly plugin: string }
  | { readonly kind: "version-drift"; readonly plugin: string; readonly cells: readonly { readonly host: string; readonly agent: string; readonly version: string }[] };

const groupBy = <T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> =>
  xs.reduce((m, x) => { const k = key(x); m.set(k, [...(m.get(k) ?? []), x]); return m; }, new Map<string, T[]>());

/** Findings visible from one host: duplicates within an agent, plugin cache hygiene. */
export const hostFindings = (host: string, effective: Readonly<Record<string, readonly Effective[]>>, states: Readonly<Record<string, readonly PluginState[]>>): Finding[] => {
  const perAgent = Object.entries(effective).flatMap(([agent, es]): Finding[] => {
    const byName = [...groupBy(es, (e) => e.name).entries()].filter(([, g]) => new Set(g.map((e) => e.path)).size > 1);
    // the same store skill linked from two dirs the agent scans (e.g. ~/.dsh/skills + ~/.agents/skills): one finding, not one per skill
    const twice = byName.filter(([, g]) => g.every((e) => e.storage.kind === "store-link"));
    const distinct = byName.filter(([, g]) => !g.every((e) => e.storage.kind === "store-link"));
    const namePathSets = new Set(byName.map(([, g]) => g.map((e) => e.path).sort().join("|")));
    const byHash = [...groupBy(es.filter((e) => e.hash.length > 0), (e) => e.hash).entries()]
      .filter(([, g]) => new Set(g.map((e) => e.path)).size > 1)
      .filter(([, g]) => !namePathSets.has(g.map((e) => e.path).sort().join("|"))); // already reported as same-name
    const dirOf = (p: string) => p.slice(0, p.lastIndexOf("/"));
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
        ...(p.enabled === "off" && p.cachedVersions.length > 0 ? [{ kind: "disabled-cached" as const, host, agent, plugin: p.id }] : []),
      ];
    }),
  );
  return [...perAgent, ...plugins];
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

export const findingText = (f: Finding): string => {
  switch (f.kind) {
    case "same-name":
      return `${f.host}/${f.agent}: "${f.name}" appears ${f.paths.length}× — ${f.paths.join(", ")}`;
    case "linked-twice":
      return `${f.host}/${f.agent}: ${f.names.length} store skills load twice (${f.dirs.join(" and ")} both link to the store): ${f.names.join(", ")}`;
    case "same-content":
      return `${f.host}/${f.agent}: identical SKILL.md (${f.names.join("/")}) at ${f.paths.join(", ")}`;
    case "stale-cache":
      return `${f.host}/${f.agent}: ${f.plugin} has unused cached versions ${f.versions.join(", ")}`;
    case "disabled-cached":
      return `${f.host}/${f.agent}: ${f.plugin} is cached but disabled`;
    case "version-drift":
      return `${f.plugin}: ${f.cells.map((c) => `${c.host}/${c.agent}=${c.version}`).join("  ")}`;
  }
};

export const sourceCounts = (es: readonly Effective[]): Record<Source["kind"], number> =>
  es.reduce((acc, e) => ({ ...acc, [e.source.kind]: acc[e.source.kind] + 1 }), { user: 0, legacy: 0, builtin: 0, plugin: 0 });
