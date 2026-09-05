import { type Result, err, ok } from "../lib/result";

/** One entry inside an agent's skills directory, as seen by the probe. */
export type Entry =
  | { readonly kind: "managed"; readonly name: string; readonly direct: boolean }         // resolves into the store; direct ⇒ raw target is store/<name>
  | { readonly kind: "foreign-link"; readonly name: string; readonly target: string }     // symlink elsewhere
  | { readonly kind: "broken-link"; readonly name: string; readonly target: string }
  | { readonly kind: "dir"; readonly name: string }                                       // real directory (unmanaged)
  | { readonly kind: "file"; readonly name: string };

export type AgentDirState = { readonly exists: boolean; readonly entries: readonly Entry[] };

export type Inventory = {
  readonly home: string;
  readonly storeSkills: readonly { readonly name: string; readonly hash: string }[];
  readonly agentDirs: Readonly<Record<string, AgentDirState>>;
  /** extra directories an agent also reads (e.g. ~/.codex/skills): agent → entries */
  readonly alsoReads: Readonly<Record<string, readonly Entry[]>>;
};

export type ProbeParseError = { readonly kind: "bad-probe"; readonly line: string };

const classify = (name: string, kind: string, target: string, raw: string, stores: readonly string[]): Entry | undefined => {
  switch (kind) {
    case "link":
      return stores.some((s) => target.startsWith(`${s}/`))
        ? { kind: "managed", name, direct: stores.some((s) => raw === `${s}/${name}`) }
        : { kind: "foreign-link", name, target };
    case "brokenlink":
      return { kind: "broken-link", name, target };
    case "dir":
      return { kind: "dir", name };
    case "file":
      return { kind: "file", name };
    default:
      return undefined;
  }
};

type Acc = { home: string; stores: string[]; store: { name: string; hash: string }[]; dirs: Record<string, { exists: boolean; entries: Entry[] }>; also: Record<string, Entry[]>; bad: string[] };

/** Parse the TSV emitted by `probeScript`. Pure. */
export const parseProbeOutput = (text: string, storePath: string): Result<Inventory, ProbeParseError> => {
  const acc = text
    .split("\n")
    .filter((l) => l.length > 0)
    .reduce<Acc>(
      (a, line) => {
        const [tag, ...f] = line.split("\t");
        switch (tag) {
          case "meta":
            if (f[0] === "home" && f[1]) return { ...a, home: f[1] };
            if (f[0] === "store" && f[1]) return { ...a, stores: [...a.stores, f[1]] };
            return { ...a, bad: [...a.bad, line] };
          case "store":
            return f[0] ? { ...a, store: [...a.store, { name: f[0], hash: f[1] ?? "" }] } : { ...a, bad: [...a.bad, line] };
          case "dir":
            return f[0] ? { ...a, dirs: { ...a.dirs, [f[0]]: { exists: f[1] === "1", entries: a.dirs[f[0]]?.entries ?? [] } } } : { ...a, bad: [...a.bad, line] };
          case "entry": {
            const [agent, name, kind, target = "", raw = target] = f;
            const e = agent && name && kind ? classify(name, kind, target, raw, a.stores) : undefined;
            if (!e || !agent) return { ...a, bad: [...a.bad, line] };
            const prev = a.dirs[agent] ?? { exists: true, entries: [] };
            return { ...a, dirs: { ...a.dirs, [agent]: { ...prev, entries: [...prev.entries, e] } } };
          }
          case "also": {
            const [agent, name, kind, target = "", raw = target] = f;
            const e = agent && name && kind ? classify(name, kind, target, raw, a.stores) : undefined;
            if (!e || !agent) return { ...a, bad: [...a.bad, line] };
            return { ...a, also: { ...a.also, [agent]: [...(a.also[agent] ?? []), e] } };
          }
          default:
            return { ...a, bad: [...a.bad, line] };
        }
      },
      { home: "", stores: [storePath], store: [], dirs: {}, also: {}, bad: [] },
    );
  const firstBad = acc.bad[0];
  if (firstBad !== undefined) return err({ kind: "bad-probe", line: firstBad });
  return ok({ home: acc.home, storeSkills: acc.store, agentDirs: acc.dirs, alsoReads: acc.also });
};

export const entryName = (e: Entry): string => e.name;
