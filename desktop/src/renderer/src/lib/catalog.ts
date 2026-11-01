import type { EffectiveEntry, HostStatus, SkillRow } from "@shared/types";

/** Where a catalog row comes from. */
export type Group =
  | { readonly kind: "store" }
  | { readonly kind: "plugin"; readonly plugin: string; readonly marketplace: string }
  | { readonly kind: "builtin" }
  | { readonly kind: "unmanaged"; readonly owner: string };

export type GroupKind = Group["kind"];

/** host → agent → the entry that agent loads */
export type Loads = Readonly<Record<string, Readonly<Record<string, EffectiveEntry>>>>;

/** One row of the skills catalog: the union of the hub store and everything any agent on any host loads. */
export type CatalogItem = {
  readonly id: string;
  readonly name: string;
  readonly group: Group;
  readonly description: string;
  readonly listingChars: number;
  readonly listingTokens: number;
  readonly bodyTokens: number;
  readonly versions: readonly string[];
  readonly loads: Loads;
  readonly store: SkillRow | null;
};

export const groupText = (g: Group): string => {
  switch (g.kind) {
    case "store":
      return "store";
    case "plugin":
      return `${g.plugin}@${g.marketplace}`;
    case "builtin":
      return "codex builtin";
    case "unmanaged":
      return g.owner;
  }
};

const GROUP_ORDER: Readonly<Record<GroupKind, number>> = { store: 0, unmanaged: 1, builtin: 2, plugin: 3 };
export const groupRank = (g: Group): number => GROUP_ORDER[g.kind];

const keyOf = (e: EffectiveEntry, storeNames: ReadonlySet<string>): { readonly key: string; readonly group: Group } => {
  switch (e.source) {
    case "plugin": {
      const plugin = e.plugin ?? "?";
      const marketplace = e.marketplace ?? "?";
      return { key: `plugin:${plugin}@${marketplace}:${e.name}`, group: { kind: "plugin", plugin, marketplace } };
    }
    case "builtin":
      return { key: `builtin:${e.name}`, group: { kind: "builtin" } };
    case "user":
    case "legacy":
      return storeNames.has(e.name) ? { key: `store:${e.name}`, group: { kind: "store" } } : { key: `other:${e.owner}:${e.name}`, group: { kind: "unmanaged", owner: e.owner } };
  }
};

/** Store rows first (with their live loads), then everything else agents load. Pure. */
export const buildCatalog = (skills: readonly SkillRow[], hosts: readonly HostStatus[]): CatalogItem[] => {
  const storeNames = new Set(skills.map((s) => s.name));
  const loads = new Map<string, Record<string, Record<string, EffectiveEntry>>>();
  const groups = new Map<string, { name: string; group: Group }>();
  hosts.forEach((h) =>
    Object.entries(h.agents ?? {}).forEach(([agent, st]) =>
      st.effective.forEach((e) => {
        const { key, group } = keyOf(e, storeNames);
        const byHost = loads.get(key) ?? {};
        byHost[h.host] = { ...(byHost[h.host] ?? {}), [agent]: e };
        loads.set(key, byHost);
        groups.set(key, { name: e.name, group });
      }),
    ),
  );
  const storeItems = skills.map((s): CatalogItem => ({
    id: `store:${s.name}`, name: s.name, group: { kind: "store" }, description: s.description,
    listingChars: s.descChars, listingTokens: s.descTokens, bodyTokens: s.bodyTokens, versions: [], loads: loads.get(`store:${s.name}`) ?? {}, store: s,
  }));
  const rest = [...groups.entries()].filter(([k]) => !k.startsWith("store:")).map(([key, g]): CatalogItem => {
    const byHost = loads.get(key) ?? {};
    const entries = Object.values(byHost).flatMap((a) => Object.values(a));
    const sample = entries.reduce<EffectiveEntry | undefined>((best, e) => (best === undefined || e.listing.length > best.listing.length ? e : best), undefined);
    return {
      id: key, name: g.name, group: g.group, description: sample?.listing ?? "",
      listingChars: sample?.listingChars ?? 0, listingTokens: sample?.listingTokens ?? 0, bodyTokens: sample?.bodyTokens ?? 0,
      versions: [...new Set(entries.flatMap((e) => (e.version === null ? [] : [e.version])))].sort(), loads: byHost, store: null,
    };
  });
  return [...storeItems, ...rest.sort((a, b) => a.id.localeCompare(b.id))];
};

export const loadCount = (i: CatalogItem): number => Object.values(i.loads).reduce((n, a) => n + Object.keys(a).length, 0);

/** State of one host × agent cell for a catalog row, as the matrix shows it. */
export type CellState =
  | "loaded"        // loaded and wanted (or not managed by skm)
  | "pending-add"   // wanted, not loaded yet
  | "pending-remove"// loaded, not wanted
  | "off"           // neither
  | "unknown"       // host not probed / unreachable
  | "absent";       // agent not enabled on that host

export const cellState = (i: CatalogItem, host: HostStatus | undefined, agent: string): CellState => {
  const enabledHere = host?.agents?.[agent] !== undefined;
  const wanted = i.store?.targets[host?.host ?? ""]?.[agent];
  if (host === undefined || !host.reachable) return wanted === undefined && i.store !== null ? "absent" : "unknown";
  if (!enabledHere && wanted === undefined) return "absent";
  const loaded = i.loads[host.host]?.[agent] !== undefined;
  if (i.store === null) return loaded ? "loaded" : "off";
  if (wanted === undefined) return "absent";
  return loaded ? (wanted ? "loaded" : "pending-remove") : wanted ? "pending-add" : "off";
};

export const LISTING_CAP_CHARS = 1536;
export const BODY_WARN_TOKENS = 5000;
