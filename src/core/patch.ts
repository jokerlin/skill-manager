import { type Option, type Result, all, err, none, ok, some } from "../lib/result";
import type { AgentOverride } from "./agents";
import type { Cell, Config, HostConfig, PluginPolicy, Rule, Selector } from "./config";

export type HostPatch = {
  /** the host's current id when it is renamed (rules, defaults and plugin policies follow the new id); absent for a new host */
  readonly from?: string;
  readonly id: string;
  readonly ssh: string | null;
  readonly agents: readonly string[] | null;
  /** skm home on that host; absent keeps the current value (default ~/.skm) */
  readonly skm?: string;
};

/** One agent's overrides as the app sends them: null or "" restores the built-in value. */
export type AgentOverridePatch = { readonly dir: string | null; readonly update: string | null };

/**
 * The settings the desktop app edits, as a partial patch. Absent keys keep their value.
 * `hosts` replaces the whole list (its order is the display order).
 */
export type ConfigPatch = {
  readonly hosts?: readonly HostPatch[];
  readonly agents?: readonly string[];
  readonly agentOverrides?: Readonly<Record<string, AgentOverridePatch>>;
  readonly store?: string;
  readonly disabledExtensions?: readonly string[];
  readonly backupBeforeApply?: boolean;
  readonly contextTokens?: number;
};

export type PatchError =
  | { readonly kind: "bad-json"; readonly message: string }
  | { readonly kind: "invalid"; readonly field: string; readonly message: string };

export const patchErrorText = (e: PatchError): string => {
  switch (e.kind) {
    case "bad-json":
      return `patch is not valid JSON: ${e.message}`;
    case "invalid":
      return `${e.field}: ${e.message}`;
  }
};

const invalid = (field: string, message: string): PatchError => ({ kind: "invalid", field, message });
const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Parse the JSON the app sends on stdin into a ConfigPatch. Pure. */
export const parsePatch = (text: string): Result<ConfigPatch, PatchError> => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return err({ kind: "bad-json", message: e instanceof Error ? e.message : String(e) });
  }
  if (!isRecord(raw)) return err(invalid("<root>", "expected an object"));
  const { hosts, agents, backupBeforeApply, contextTokens, agentOverrides, store, disabledExtensions } = raw;
  if (disabledExtensions !== undefined && !(Array.isArray(disabledExtensions) && disabledExtensions.every((x) => typeof x === "string"))) return err(invalid("disabledExtensions", "expected a list of extension names"));
  if (store !== undefined && (typeof store !== "string" || store.trim() === "")) return err(invalid("store", "expected a directory path"));
  if (agentOverrides !== undefined && !isRecord(agentOverrides)) return err(invalid("agentOverrides", "expected { agent: { dir, update } }"));
  const parsedOverrides = agentOverrides === undefined ? ok(undefined) : all(Object.entries(agentOverrides).map(([id, v]): Result<readonly [string, AgentOverridePatch], PatchError> => {
    if (!isRecord(v)) return err(invalid(`agentOverrides.${id}`, "expected { dir, update }"));
    const dir = v["dir"] ?? null;
    const update = v["update"] ?? null;
    if (dir !== null && typeof dir !== "string") return err(invalid(`agentOverrides.${id}.dir`, "expected a string or null"));
    if (update !== null && typeof update !== "string") return err(invalid(`agentOverrides.${id}.update`, "expected a string or null"));
    return ok([id, { dir, update }]);
  }));
  if (!parsedOverrides.ok) return parsedOverrides;
  if (agents !== undefined && !isStringList(agents)) return err(invalid("agents", "expected a list of agent ids"));
  if (backupBeforeApply !== undefined && typeof backupBeforeApply !== "boolean") return err(invalid("backupBeforeApply", "expected true or false"));
  if (contextTokens !== undefined && !(typeof contextTokens === "number" && Number.isInteger(contextTokens) && contextTokens > 0)) return err(invalid("contextTokens", "expected a positive integer"));
  if (hosts !== undefined && !Array.isArray(hosts)) return err(invalid("hosts", "expected a list"));
  const parsedHosts = hosts === undefined ? ok(undefined) : all((hosts as unknown[]).map((h, i): Result<NonNullable<ConfigPatch["hosts"]>[number], PatchError> => {
    if (!isRecord(h) || typeof h["id"] !== "string") return err(invalid(`hosts[${i}]`, "expected { id, ssh, agents }"));
    const ssh = h["ssh"] ?? null;
    const ag = h["agents"] ?? null;
    if (ssh !== null && typeof ssh !== "string") return err(invalid(`hosts[${i}].ssh`, "expected a string or null"));
    if (ag !== null && !isStringList(ag)) return err(invalid(`hosts[${i}].agents`, "expected a list or null"));
    const from = h["from"];
    const skm = h["skm"];
    if (from !== undefined && typeof from !== "string") return err(invalid(`hosts[${i}].from`, "expected the current host id"));
    if (skm !== undefined && typeof skm !== "string") return err(invalid(`hosts[${i}].skm`, "expected a path"));
    return ok({ id: h["id"], ssh, agents: ag, ...(from !== undefined ? { from } : {}), ...(skm !== undefined ? { skm } : {}) });
  }));
  if (!parsedHosts.ok) return parsedHosts;
  return ok({
    ...(parsedHosts.value !== undefined ? { hosts: parsedHosts.value } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(backupBeforeApply !== undefined ? { backupBeforeApply } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(parsedOverrides.value !== undefined ? { agentOverrides: Object.fromEntries(parsedOverrides.value) } : {}),
    ...(typeof store === "string" ? { store: store.trim() } : {}),
    ...(Array.isArray(disabledExtensions) ? { disabledExtensions: disabledExtensions as string[] } : {}),
  });
};

// ---------- host rename (pure) ----------

const renameGlobs = (globs: readonly string[], from: string, to: string): readonly string[] => globs.map((g) => (g === from ? to : g));
const renameSelector = (s: Selector, from: string, to: string): Selector => (s.kind === "all" ? s : { ...s, globs: renameGlobs(s.globs, from, to) });
const renameCells = (cells: readonly Cell[], from: string, to: string): readonly Cell[] => cells.map((x) => (x.host === from ? { ...x, host: to } : x));
const renameRule = (r: Rule, from: string, to: string): Rule => ({
  ...r,
  hosts: r.hosts.some ? some(renameSelector(r.hosts.value, from, to)) : r.hosts,
  on: renameCells(r.on, from, to),
  off: renameCells(r.off, from, to),
});
const renamePlugin = (p: PluginPolicy, from: string, to: string): PluginPolicy => ({
  ...p, hosts: renameSelector(p.hosts, from, to), on: renameCells(p.on, from, to), off: renameCells(p.off, from, to),
});

/** Point every exact host reference (selector globs equal to the id, host/agent cells) at the new id. Glob patterns such as `mini*` stay as written. */
export const renameHostRefs = (c: Config, from: string, to: string): Config =>
  from === to ? c : {
    ...c,
    defaults: { ...c.defaults, hosts: renameSelector(c.defaults.hosts, from, to) },
    rules: c.rules.map((r) => renameRule(r, from, to)),
    plugins: c.plugins.map((p) => renamePlugin(p, from, to)),
  };

const opt = <T>(v: T | null): Option<T> => (v === null ? none : some(v));

/** Apply a patch to a config, enforcing the invariants parseConfig relies on. Pure. */
export const patchConfig = (c: Config, p: ConfigPatch): Result<Config, PatchError> => {
  const agents = p.agents ?? c.agents;
  const known = (a: string): boolean => c.registry.agents.some((x) => x.id === a);
  const unknown = agents.filter((a) => !known(a));
  if (unknown.length > 0) return err(invalid("agents", `unknown agent ids: ${unknown.join(", ")}`));
  if (agents.length === 0) return err(invalid("agents", "at least one agent is required"));
  if (new Set(agents).size !== agents.length) return err(invalid("agents", "duplicate agent ids"));

  const hosts: Result<readonly HostConfig[], PatchError> = p.hosts === undefined
    ? ok(c.hosts)
    : all(p.hosts.map((h, i): Result<HostConfig, PatchError> => {
        const id = h.id.trim();
        if (!HOST_ID.test(id)) return err(invalid(`hosts[${i}].id`, `"${h.id}" is not a valid host id (letters, digits, . _ -)`));
        const ssh = h.ssh === null || h.ssh.trim() === "" ? null : h.ssh.trim();
        const bad = (h.agents ?? []).filter((a) => !agents.includes(a));
        if (bad.length > 0) return err(invalid(`hosts[${i}].agents`, `not in the agent list: ${bad.join(", ")}`));
        if (h.from !== undefined && !c.hosts.some((x) => x.id === h.from)) return err(invalid(`hosts[${i}].from`, `no host named ${h.from}`));
        const prev = c.hosts.find((x) => x.id === (h.from ?? id));
        const skm = h.skm === undefined || h.skm.trim() === "" ? prev?.skm ?? "~/.skm" : h.skm.trim();
        // a host that enables every agent needs no override
        const subset = h.agents === null || agents.every((a) => h.agents?.includes(a)) ? null : h.agents;
        return ok({ id, ssh: opt(ssh), agents: opt(subset), skm });
      }));
  if (!hosts.ok) return hosts;
  const ids = hosts.value.map((h) => h.id);
  if (new Set(ids).size !== ids.length) return err(invalid("hosts", "duplicate host ids"));
  const hubs = hosts.value.filter((h) => !h.ssh.some).length;
  if (hubs !== 1) return err(invalid("hosts", hubs === 0 ? "one host must have no ssh alias: the machine skm runs on" : "only one host may omit the ssh alias (the machine skm runs on); give the others an ssh alias"));

  const renames = (p.hosts ?? []).flatMap((h) => (h.from !== undefined && h.from !== h.id.trim() ? [{ from: h.from, to: h.id.trim() }] : []));
  // two-step through placeholders so swaps (a→b, b→a) do not collide
  const staged = renames.reduce((acc, r, i) => renameHostRefs(acc, r.from, `\u0000${i}`), c);
  const renamed = renames.reduce((acc, r, i) => renameHostRefs(acc, `\u0000${i}`, r.to), staged);

  const overrides = p.agentOverrides === undefined ? c.agentOverrides : mergeOverrides(c.agentOverrides, p.agentOverrides);
  const unknownOv = Object.keys(p.agentOverrides ?? {}).filter((a) => !known(a));
  if (unknownOv.length > 0) return err(invalid("agentOverrides", `unknown agent ids: ${unknownOv.join(", ")}`));

  return ok({
    ...renamed,
    agents,
    agentOverrides: overrides,
    store: p.store ?? c.store,
    disabledExtensions: p.disabledExtensions ?? c.disabledExtensions,
    hosts: hosts.value,
    backupBeforeApply: p.backupBeforeApply ?? c.backupBeforeApply,
    contextTokens: p.contextTokens ?? c.contextTokens,
  });
};

const blankToNone = (v: string | null): Option<string> => (v === null || v.trim() === "" ? none : some(v.trim()));

const mergeOverrides = (
  current: Readonly<Record<string, AgentOverride>>, p: Readonly<Record<string, AgentOverridePatch>>,
): Readonly<Record<string, AgentOverride>> => {
  const next: Record<string, AgentOverride> = { ...current };
  for (const [id, o] of Object.entries(p)) {
    const v: AgentOverride = { dir: blankToNone(o.dir), update: blankToNone(o.update) };
    if (v.dir.some || v.update.some) next[id] = v;
    else delete next[id];
  }
  return next;
};
