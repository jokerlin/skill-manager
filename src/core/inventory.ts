import { type Result, err, ok } from "../lib/result";

/** One entry inside an agent's skills directory, as seen by the probe. `hash` = sha1 of its SKILL.md ("" when none). */
export type Entry =
  | { readonly kind: "managed"; readonly name: string; readonly direct: boolean; readonly hash?: string }         // resolves into the store; direct ⇒ raw target is store/<name>
  | { readonly kind: "foreign-link"; readonly name: string; readonly target: string; readonly hash?: string }     // symlink elsewhere
  | { readonly kind: "broken-link"; readonly name: string; readonly target: string }
  | { readonly kind: "dir"; readonly name: string; readonly hash?: string }                                       // real directory (unmanaged)
  | { readonly kind: "file"; readonly name: string };

export type AgentDirState = { readonly exists: boolean; readonly entries: readonly Entry[] };

export type PluginCacheDir = { readonly agent: string; readonly marketplace: string; readonly plugin: string; readonly version: string; readonly dir: string };
export type PluginSkillRef = PluginCacheDir & { readonly name: string; readonly skillDir: string; readonly hash: string };
export type BuiltinRef = { readonly agent: string; readonly name: string; readonly dir: string; readonly hash: string };

export type Inventory = {
  readonly home: string;
  readonly storeSkills: readonly { readonly name: string; readonly hash: string }[];
  readonly agentDirs: Readonly<Record<string, AgentDirState>>;
  /** extra directories an agent also reads (e.g. ~/.codex/skills): agent → entries */
  readonly alsoReads: Readonly<Record<string, readonly Entry[]>>;
  /** which alsoReads directory each legacy entry came from: agent → name → dir (v2 probes only) */
  readonly alsoDirs: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** tool name → resolved path (absent when not found on the host's augmented PATH) */
  readonly tools: Readonly<Record<string, string>>;
  /** config/lock files shipped back verbatim: id → text (claude-settings, claude-installed, claude-marketplaces, codex-config, codex-models, acme-lock, agents-lock) */
  readonly files: Readonly<Record<string, string>>;
  readonly pluginCache: readonly PluginCacheDir[];
  readonly pluginSkills: readonly PluginSkillRef[];
  readonly builtins: readonly BuiltinRef[];
  /** SKILL.md text by sha1 — every hash referenced by entries / pluginSkills / builtins that had a SKILL.md */
  readonly docs: Readonly<Record<string, string>>;
};

export const emptyInventory = (home = ""): Inventory => ({ home, storeSkills: [], agentDirs: {}, alsoReads: {}, alsoDirs: {}, tools: {}, files: {}, pluginCache: [], pluginSkills: [], builtins: [], docs: {} });

export type ProbeParseError = { readonly kind: "bad-probe"; readonly line: string };

const withHash = <T extends object>(e: T, hash: string): T & { readonly hash?: string } => (hash.length > 0 ? { ...e, hash } : e);

const classify = (name: string, kind: string, target: string, raw: string, hash: string, stores: readonly string[]): Entry | undefined => {
  switch (kind) {
    case "link":
      return stores.some((s) => target.startsWith(`${s}/`))
        ? withHash({ kind: "managed" as const, name, direct: stores.some((s) => raw === `${s}/${name}`) }, hash)
        : withHash({ kind: "foreign-link" as const, name, target }, hash);
    case "brokenlink":
      return { kind: "broken-link", name, target };
    case "dir":
      return withHash({ kind: "dir" as const, name }, hash);
    case "file":
      return { kind: "file", name };
    default:
      return undefined;
  }
};

const b64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");

type Acc = {
  home: string; stores: string[]; store: { name: string; hash: string }[];
  dirs: Record<string, { exists: boolean; entries: Entry[] }>; also: Record<string, Entry[]>; alsoDirs: Record<string, Record<string, string>>;
  tools: Record<string, string>; files: Record<string, string>;
  pcache: PluginCacheDir[]; pskills: PluginSkillRef[]; builtins: BuiltinRef[]; docs: Record<string, string>;
  bad: string[];
};

/** Parse the TSV emitted by `probeScript`. Pure. */
export const parseProbeOutput = (text: string, storePath: string | ((home: string) => string)): Result<Inventory, ProbeParseError> => {
  const storeFor = typeof storePath === "string" ? () => storePath : storePath;
  const acc = text
    .split("\n")
    .filter((l) => l.length > 0)
    .reduce<Acc>(
      (a, line) => {
        const [tag, ...f] = line.split("\t");
        const bad = { ...a, bad: [...a.bad, line] };
        switch (tag) {
          case "meta":
            if (f[0] === "home" && f[1]) return { ...a, home: f[1], stores: [...a.stores, storeFor(f[1])] };
            if (f[0] === "store" && f[1]) return { ...a, stores: [...a.stores, f[1]] };
            return bad;
          case "store":
            return f[0] ? { ...a, store: [...a.store, { name: f[0], hash: f[1] ?? "" }] } : bad;
          case "dir":
            return f[0] ? { ...a, dirs: { ...a.dirs, [f[0]]: { exists: f[1] === "1", entries: a.dirs[f[0]]?.entries ?? [] } } } : bad;
          case "entry": {
            const [agent, name, kind, target = "", raw = target, hash = ""] = f;
            const e = agent && name && kind ? classify(name, kind, target, raw === "" ? target : raw, hash, a.stores) : undefined;
            if (!e || !agent) return bad;
            const prev = a.dirs[agent] ?? { exists: true, entries: [] };
            return { ...a, dirs: { ...a.dirs, [agent]: { ...prev, entries: [...prev.entries, e] } } };
          }
          case "also": {
            const [agent, name, kind, target = "", raw = target, hash = "", dir = ""] = f;
            const e = agent && name && kind ? classify(name, kind, target, raw === "" ? target : raw, hash, a.stores) : undefined;
            if (!e || !agent) return bad;
            const dirs = dir.length > 0 ? { ...a.alsoDirs, [agent]: { ...(a.alsoDirs[agent] ?? {}), [e.name]: dir } } : a.alsoDirs;
            return { ...a, also: { ...a.also, [agent]: [...(a.also[agent] ?? []), e] }, alsoDirs: dirs };
          }
          case "tool": {
            const [name, path] = f;
            if (!name) return bad;
            return path && path !== "-" ? { ...a, tools: { ...a.tools, [name]: path } } : a;
          }
          case "file": {
            const [id, data] = f;
            return id ? { ...a, files: { ...a.files, [id]: b64(data ?? "") } } : bad;
          }
          case "pcache": {
            const [agent, marketplace, plugin, version, dir] = f;
            return agent && marketplace && plugin && version && dir ? { ...a, pcache: [...a.pcache, { agent, marketplace, plugin, version, dir }] } : bad;
          }
          case "pskill": {
            const [agent, marketplace, plugin, version, name, skillDir, hash = ""] = f;
            return agent && marketplace && plugin && version && name && skillDir
              ? { ...a, pskills: [...a.pskills, { agent, marketplace, plugin, version, name, dir: skillDir.slice(0, skillDir.lastIndexOf("/skills/")), skillDir, hash }] }
              : bad;
          }
          case "builtin": {
            const [agent, name, dir, hash = ""] = f;
            return agent && name && dir ? { ...a, builtins: [...a.builtins, { agent, name, dir, hash }] } : bad;
          }
          case "md": {
            const [hash, , data] = f;
            return hash ? { ...a, docs: { ...a.docs, [hash]: b64(data ?? "") } } : bad;
          }
          default:
            return bad;
        }
      },
      { home: "", stores: [], store: [], dirs: {}, also: {}, alsoDirs: {}, tools: {}, files: {}, pcache: [], pskills: [], builtins: [], docs: {}, bad: [] },
    );
  const firstBad = acc.bad[0];
  if (firstBad !== undefined) return err({ kind: "bad-probe", line: firstBad });
  return ok({
    home: acc.home, storeSkills: acc.store, agentDirs: acc.dirs, alsoReads: acc.also, alsoDirs: acc.alsoDirs,
    tools: acc.tools, files: acc.files, pluginCache: acc.pcache, pluginSkills: acc.pskills, builtins: acc.builtins, docs: acc.docs,
  });
};

export const entryName = (e: Entry): string => e.name;

export const entryHash = (e: Entry): string => (e.kind === "managed" || e.kind === "foreign-link" || e.kind === "dir" ? (e.hash ?? "") : "");
