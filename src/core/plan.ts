import type { Entry, Inventory } from "./inventory";

export type Op =
  | { readonly op: "mkdir"; readonly host: string; readonly path: string }
  | { readonly op: "rsync-skill"; readonly host: string; readonly skill: string }
  | { readonly op: "link"; readonly host: string; readonly agent: string; readonly skill: string }
  | { readonly op: "unlink"; readonly host: string; readonly agent: string; readonly skill: string }
  | { readonly op: "conflict"; readonly host: string; readonly agent: string; readonly skill: string; readonly entry: Entry }
  | { readonly op: "remote-only"; readonly host: string; readonly skill: string };

export type PlanInput = {
  readonly hostId: string;
  readonly isLocal: boolean;
  /** agent id → sorted skill names wanted there */
  readonly desired: Readonly<Record<string, readonly string[]>>;
  readonly inventory: Inventory;
  readonly hubSkills: readonly { readonly name: string; readonly hash: string }[];
  /** agent id → absolute skills dir on that host */
  readonly agentDirs: Readonly<Record<string, string>>;
};

const ORDER: Record<Op["op"], number> = { mkdir: 0, "rsync-skill": 1, unlink: 2, link: 3, conflict: 4, "remote-only": 5 };

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

/** Diff desired state against a host inventory. Pure; deterministic order. */
export const planHost = (input: PlanInput): Op[] => {
  const { hostId, isLocal, desired, inventory, hubSkills, agentDirs } = input;
  const hubNames = new Set(hubSkills.map((s) => s.name));
  const hubHash = new Map(hubSkills.map((s) => [s.name, s.hash]));
  const remoteHash = new Map(inventory.storeSkills.map((s) => [s.name, s.hash]));
  const agents = Object.keys(agentDirs);

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

  const remoteOnly: Op[] = isLocal
    ? []
    : inventory.storeSkills.filter((s) => !hubNames.has(s.name)).map((s): Op => ({ op: "remote-only", host: hostId, skill: s.name }));

  return [...mkdirs, ...rsyncs, ...perAgent, ...remoteOnly].sort((a, b) => ORDER[a.op] - ORDER[b.op]);
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
  }
};

export const isMutation = (o: Op): boolean => o.op === "mkdir" || o.op === "rsync-skill" || o.op === "link" || o.op === "unlink";
