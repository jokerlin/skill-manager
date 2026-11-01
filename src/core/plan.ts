import type { Option } from "../lib/result";
import type { PluginState } from "./effective";
import type { Entry, Inventory } from "./inventory";
import { type MarketplaceSource, marketplaceSourceText } from "./sources";

export type Op =
  | { readonly op: "mkdir"; readonly host: string; readonly path: string }
  | { readonly op: "rsync-skill"; readonly host: string; readonly skill: string }
  | { readonly op: "link"; readonly host: string; readonly agent: string; readonly skill: string }
  | { readonly op: "unlink"; readonly host: string; readonly agent: string; readonly skill: string }
  | { readonly op: "conflict"; readonly host: string; readonly agent: string; readonly skill: string; readonly entry: Entry }
  | { readonly op: "remote-only"; readonly host: string; readonly skill: string }
  // v2: delegated to the agent's own plugin CLI / config, or to the skill's owning tool
  | { readonly op: "marketplace-add"; readonly host: string; readonly agent: string; readonly marketplace: string; readonly source: string }
  | { readonly op: "plugin-install"; readonly host: string; readonly agent: string; readonly plugin: string }
  | { readonly op: "plugin-enable"; readonly host: string; readonly agent: string; readonly plugin: string }
  | { readonly op: "plugin-disable"; readonly host: string; readonly agent: string; readonly plugin: string }
  | { readonly op: "owned-ensure"; readonly host: string; readonly skill: string; readonly tool: string; readonly command: string }
  // an agent that reads another agent's dir (pi ← ~/.agents/skills) switches a skill off / back on in its own settings
  | { readonly op: "exclude"; readonly host: string; readonly agent: string; readonly skill: string }
  | { readonly op: "unexclude"; readonly host: string; readonly agent: string; readonly skill: string }
  | { readonly op: "blocked"; readonly host: string; readonly agent: string; readonly what: string; readonly reason: string }
  // `skm plugin update`: never produced by planHost (desired state has no "latest"); see core/pluginUpdate.ts
  | { readonly op: "marketplace-refresh"; readonly host: string; readonly agent: string; readonly marketplace: string }
  | { readonly op: "plugin-update"; readonly host: string; readonly agent: string; readonly plugin: string; readonly scope: string; readonly projectPath: Option<string>; readonly from: string };

/** One plugin's desired state for one agent on this host (marketplace resolved by the shell). */
export type PluginCell = { readonly agent: string; readonly name: string; readonly marketplace: string; readonly wanted: boolean };

/** One skill's exclusion state in an agent's settings on this host: `wanted` = it should be excluded, `present` = it is now. */
export type ExcludeCell = { readonly agent: string; readonly skill: string; readonly wanted: boolean; readonly present: boolean };

/** A CLI-owned skill as it applies to this host. */
export type OwnedRule = {
  readonly skill: string;
  readonly tool: string;
  readonly command: Option<string>;
  readonly fallback: "store" | "none";
  /** agents whose dirs the tool writes; none ⇒ all. Other agents get the store copy linked like any skill. */
  readonly agents: Option<readonly string[]>;
};

export type PlanInput = {
  readonly hostId: string;
  readonly isLocal: boolean;
  /** agent id → sorted skill names wanted there */
  readonly desired: Readonly<Record<string, readonly string[]>>;
  readonly inventory: Inventory;
  readonly hubSkills: readonly { readonly name: string; readonly hash: string }[];
  /** agent id → absolute skills dir on that host */
  readonly agentDirs: Readonly<Record<string, string>>;
  readonly plugins?: readonly PluginCell[];
  readonly pluginStates?: Readonly<Record<string, readonly PluginState[]>>;
  /** agent id → marketplaces configured on this host (name → source) */
  readonly marketplaces?: Readonly<Record<string, Readonly<Record<string, MarketplaceSource>>>>;
  /** marketplaces the hub knows a source for (name → source); a local-dir source only works on the hub itself */
  readonly hubMarketplaces?: Readonly<Record<string, MarketplaceSource>>;
  readonly owned?: readonly OwnedRule[];
  readonly tools?: Readonly<Record<string, string>>;
  readonly excludes?: readonly ExcludeCell[];
};

const ORDER: Record<Op["op"], number> = {
  mkdir: 0, "rsync-skill": 1, unlink: 2, link: 3,
  "marketplace-add": 4, "plugin-install": 5, "plugin-enable": 6, "plugin-disable": 7, "owned-ensure": 8, exclude: 9, unexclude: 10,
  "marketplace-refresh": 11, "plugin-update": 12,
  conflict: 13, blocked: 14, "remote-only": 15,
};

const entryFor = (inv: Inventory, agent: string, skill: string): Entry | undefined =>
  inv.agentDirs[agent]?.entries.find((e) => e.name === skill);

const linkOps = (host: string, agent: string, wanted: readonly string[], inv: Inventory): Op[] =>
  wanted
    .flatMap((skill): Op[] => {
      const e = entryFor(inv, agent, skill);
      if (e === undefined) return [{ op: "link", host, agent, skill }];
      switch (e.kind) {
        case "managed":
          return e.direct ? [] : [{ op: "link", host, agent, skill }]; // normalize chained links to direct store links
        case "broken-link":
          return [{ op: "link", host, agent, skill }];
        case "dir":
        case "foreign-link":
        case "file":
          return [{ op: "conflict", host, agent, skill, entry: e }];
      }
    });

/** Only links to skills the hub knows are ours to remove; links to remote-only store skills stay. */
const unlinkOps = (host: string, agent: string, wanted: ReadonlySet<string>, inv: Inventory, hubNames: ReadonlySet<string>): Op[] =>
  (inv.agentDirs[agent]?.entries ?? [])
    .filter((e) => e.kind === "managed" && !wanted.has(e.name) && hubNames.has(e.name))
    .map((e): Op => ({ op: "unlink", host, agent, skill: e.name }));

const without = (desired: Readonly<Record<string, readonly string[]>>, skill: string, agents?: readonly string[]): Record<string, readonly string[]> =>
  Object.fromEntries(Object.entries(desired).map(([a, names]) => [a, agents === undefined || agents.includes(a) ? names.filter((n) => n !== skill) : names]));

/**
 * CLI-owned skills: where the tool exists the tool writes the dirs it knows (skm stays out and asks the tool to ensure them)
 * and skm links the store copy for the other agents; where it is absent, either fall back to linking the store copy or leave the cells empty.
 */
const ownedAdjust = (
  host: string, desired: Readonly<Record<string, readonly string[]>>, inv: Inventory, owned: readonly OwnedRule[], tools: Readonly<Record<string, string>>, hubNames: ReadonlySet<string>,
): { desired: Readonly<Record<string, readonly string[]>>; ops: Op[] } =>
  owned.reduce<{ desired: Readonly<Record<string, readonly string[]>>; ops: Op[] }>(
    (acc, o) => {
      const writes = (a: string): boolean => !o.agents.some || o.agents.value.includes(a);
      const wantedAgents = Object.entries(acc.desired).filter(([, names]) => names.includes(o.skill)).map(([a]) => a).filter(writes);
      if (wantedAgents.length === 0) return acc;
      if (tools[o.tool] === undefined) return o.fallback === "store" && hubNames.has(o.skill) ? acc : { ...acc, desired: without(acc.desired, o.skill) };
      const missing = wantedAgents.filter((a) => entryFor(inv, a, o.skill)?.kind !== "dir");
      const ops: Op[] =
        missing.length === 0 ? []
        : o.command.some ? [{ op: "owned-ensure", host, skill: o.skill, tool: o.tool, command: o.command.value }]
        : [{ op: "blocked", host, agent: missing.join("+"), what: `owned ${o.skill}`, reason: `no ensure command known for ${o.tool}; add owned.${o.skill}.ensure` }];
      return { desired: without(acc.desired, o.skill, wantedAgents), ops: [...acc.ops, ...ops] };
    },
    { desired, ops: [] },
  );

const pluginOps = (
  host: string, isLocal: boolean, cells: readonly PluginCell[], states: Readonly<Record<string, readonly PluginState[]>>,
  marketplaces: Readonly<Record<string, Readonly<Record<string, MarketplaceSource>>>>, hubMarketplaces: Readonly<Record<string, MarketplaceSource>>, tools: Readonly<Record<string, string>>,
): Op[] =>
  cells.flatMap((c): Op[] => {
    const id = `${c.name}@${c.marketplace}`;
    const st = (states[c.agent] ?? []).find((p) => p.id === id);
    const present = st?.active.some ?? false;
    const enabled = st?.enabled ?? "off";
    const blocked = (reason: string): Op => ({ op: "blocked", host, agent: c.agent, what: `plugin ${id}`, reason });
    if (c.wanted) {
      if (c.marketplace.length === 0) return [blocked("marketplace unknown; set plugins.<name>.marketplace")];
      if (tools[c.agent] === undefined) return [blocked(`${c.agent} CLI not found on ${host}`)];
      if (!present) {
        const known = marketplaces[c.agent]?.[c.marketplace] !== undefined;
        const source = hubMarketplaces[c.marketplace];
        const install: Op = { op: "plugin-install", host, agent: c.agent, plugin: id };
        if (known) return [install];
        if (source === undefined) return [blocked(`marketplace ${c.marketplace} is not configured for ${c.agent} on ${host} and the hub knows no source`)];
        // a directory on the hub does not exist on another host; adding it there would only fail
        if (source.kind === "local-dir" && !isLocal) return [blocked(`marketplace ${c.marketplace} is not configured for ${c.agent} on ${host}; the hub only has it as a local directory (${source.path}), so add it on ${host} by hand`)];
        return [{ op: "marketplace-add", host, agent: c.agent, marketplace: c.marketplace, source: marketplaceSourceText(source) }, install];
      }
      return enabled === "off" ? [{ op: "plugin-enable", host, agent: c.agent, plugin: id }] : [];
    }
    if (st === undefined || enabled === "off") return [];
    if (c.agent === "claude" && tools[c.agent] === undefined) return [blocked(`${c.agent} CLI not found on ${host}; cannot disable`)];
    return [{ op: "plugin-disable", host, agent: c.agent, plugin: id }];
  });

/** Settings edits run through node on the host (it is there wherever pi is, but say so when it is not). */
const excludeOps = (host: string, cells: readonly ExcludeCell[], tools: Readonly<Record<string, string>>): Op[] =>
  cells
    .filter((c) => c.wanted !== c.present)
    .map((c): Op => {
      const op = c.wanted ? "exclude" : "unexclude";
      return tools["node"] === undefined
        ? { op: "blocked", host, agent: c.agent, what: `${op} ${c.skill}`, reason: `node not found on ${host}; cannot edit ${c.agent} settings` }
        : { op, host, agent: c.agent, skill: c.skill };
    });

/** Diff desired state against a host inventory. Pure; deterministic order. */
export const planHost = (input: PlanInput): Op[] => {
  const { hostId, isLocal, inventory, hubSkills, agentDirs } = input;
  const tools = input.tools ?? inventory.tools;
  const hubNames = new Set(hubSkills.map((s) => s.name));
  const hubHash = new Map(hubSkills.map((s) => [s.name, s.hash]));
  const remoteHash = new Map(inventory.storeSkills.map((s) => [s.name, s.hash]));
  const agents = Object.keys(agentDirs);

  const adjusted = ownedAdjust(hostId, input.desired, inventory, input.owned ?? [], tools, hubNames);
  const desired = adjusted.desired;
  const wantedAnywhere = new Set(agents.flatMap((a) => desired[a] ?? []));

  const mkdirs: Op[] = agents
    .filter((a) => (desired[a] ?? []).length > 0 && inventory.agentDirs[a]?.exists !== true)
    .flatMap((a) => { const p = agentDirs[a]; return p ? [{ op: "mkdir", host: hostId, path: p } as const] : []; });

  const rsyncs: Op[] = isLocal
    ? []
    : [...wantedAnywhere]
        .filter((s) => hubNames.has(s) && remoteHash.get(s) !== hubHash.get(s))
        .sort()
        .map((skill): Op => ({ op: "rsync-skill", host: hostId, skill }));

  const perAgent: Op[] = agents.flatMap((a) => {
    const wanted = desired[a] ?? [];
    return [...unlinkOps(hostId, a, new Set(wanted), inventory, hubNames), ...linkOps(hostId, a, wanted, inventory)];
  });

  const plugins = pluginOps(hostId, isLocal, input.plugins ?? [], input.pluginStates ?? {}, input.marketplaces ?? {}, input.hubMarketplaces ?? {}, tools);

  const remoteOnly: Op[] = isLocal
    ? []
    : inventory.storeSkills.filter((s) => !hubNames.has(s.name)).map((s): Op => ({ op: "remote-only", host: hostId, skill: s.name }));

  const excludes = excludeOps(hostId, input.excludes ?? [], tools);

  return [...mkdirs, ...rsyncs, ...perAgent, ...plugins, ...adjusted.ops, ...excludes, ...remoteOnly].sort((a, b) => ORDER[a.op] - ORDER[b.op]);
};

export const opText = (o: Op): string => {
  switch (o.op) {
    case "mkdir":
      return `mkdir ${o.path}`;
    case "rsync-skill":
      return `rsync ${o.skill} → ${o.host}`;
    case "link":
      return `link ${o.agent}/${o.skill}`;
    case "unlink":
      return `unlink ${o.agent}/${o.skill}`;
    case "conflict":
      return `conflict ${o.agent}/${o.skill} (${o.entry.kind})`;
    case "remote-only":
      return `remote-only ${o.skill} (in ${o.host} store, not in hub)`;
    case "marketplace-add":
      return `${o.agent}: marketplace add ${o.marketplace} (${o.source})`;
    case "plugin-install":
      return `${o.agent}: plugin install ${o.plugin}`;
    case "plugin-enable":
      return `${o.agent}: plugin enable ${o.plugin}`;
    case "plugin-disable":
      return `${o.agent}: plugin disable ${o.plugin}`;
    case "owned-ensure":
      return `${o.tool}: ensure ${o.skill} (${o.command})`;
    case "exclude":
      return `${o.agent}: exclude ${o.skill} (settings)`;
    case "unexclude":
      return `${o.agent}: unexclude ${o.skill} (settings)`;
    case "blocked":
      return `blocked ${o.agent} ${o.what}: ${o.reason}`;
    case "marketplace-refresh":
      return `${o.agent}: marketplace refresh ${o.marketplace}`;
    case "plugin-update":
      return `${o.agent}: plugin update ${o.plugin} (${o.from || "?"}${o.scope === "user" ? "" : `, ${o.scope}${o.projectPath.some ? ` ${o.projectPath.value}` : ""}`})`;
  }
};

/** Ops that change the host (file ops applied by apply.sh + command ops run through the owning CLI). */
export const isMutation = (o: Op): boolean => isFileOp(o) || isCommandOp(o);

export const isFileOp = (o: Op): boolean => o.op === "mkdir" || o.op === "rsync-skill" || o.op === "link" || o.op === "unlink";

export const isCommandOp = (o: Op): boolean =>
  o.op === "marketplace-add" || o.op === "plugin-install" || o.op === "plugin-enable" || o.op === "plugin-disable" || o.op === "owned-ensure" || o.op === "exclude" || o.op === "unexclude"
  || o.op === "marketplace-refresh" || o.op === "plugin-update";

/** Informational ops: nothing is executed for these. */
export const isReport = (o: Op): boolean => o.op === "conflict" || o.op === "blocked" || o.op === "remote-only";
