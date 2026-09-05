import { parse as parseYaml, stringify as toYaml } from "yaml";
import { type Option, type Result, err, none, ok, some } from "../lib/result";

/** Which hosts/agents a rule or default applies to. */
export type Selector =
  | { readonly kind: "all" }
  | { readonly kind: "only"; readonly globs: readonly string[] }
  | { readonly kind: "except"; readonly globs: readonly string[] };

/** One (host, agent) grid cell. */
export type Cell = { readonly host: string; readonly agent: string };

export type Rule = {
  readonly skills: readonly string[];          // globs over skill names
  readonly hosts: Option<Selector>;            // replaces the effective hosts selector when present
  readonly agents: Option<Selector>;           // replaces the effective agents selector when present
  readonly on: readonly Cell[];                // cell-level overrides, applied after selectors
  readonly off: readonly Cell[];
};

export type HostConfig = {
  readonly id: string;
  readonly ssh: Option<string>;                // ~/.ssh/config alias; none ⇒ local machine
  readonly agents: Option<readonly string[]>;  // subset of config.agents present on this host
  readonly skm: string;                        // skm home on that host (default ~/.skm)
};

export type EvalAgent = "claude" | "codex";

export type Config = {
  readonly store: string;
  readonly agents: readonly string[];
  readonly hosts: readonly HostConfig[];
  readonly defaults: { readonly hosts: Selector; readonly agents: Selector };
  readonly rules: readonly Rule[];
  readonly eval: { readonly agent: EvalAgent; readonly model: Option<string> };
  readonly contextTokens: number;
  readonly backupBeforeApply: boolean;
};

export type ConfigError =
  | { readonly kind: "yaml"; readonly message: string }
  | { readonly kind: "shape"; readonly path: string; readonly message: string }
  | { readonly kind: "missing-local" };

export const ALL: Selector = { kind: "all" };

export const defaultConfig = (): Config => ({
  store: "~/.skm/skills",
  agents: ["claude", "codex"],
  hosts: [{ id: "local", ssh: none, agents: none, skm: "~/.skm" }],
  defaults: { hosts: ALL, agents: ALL },
  rules: [],
  eval: { agent: "claude", model: none },
  contextTokens: 200_000,
  backupBeforeApply: true,
});

// ---------- parsing (pure) ----------

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const shape = (path: string, message: string): ConfigError => ({ kind: "shape", path, message });

const parseStringList = (v: unknown, path: string): Result<readonly string[], ConfigError> =>
  Array.isArray(v) && v.every((x) => typeof x === "string")
    ? ok(v as string[])
    : err(shape(path, "expected a list of strings"));

const parseSelector = (v: unknown, path: string): Result<Selector, ConfigError> => {
  if (v === "all" || v === undefined) return ok(ALL);
  if (!isRecord(v)) return err(shape(path, "expected 'all' or { only: [...] } or { except: [...] }"));
  const keys = Object.keys(v);
  if (keys.length !== 1) return err(shape(path, "selector must have exactly one of only/except"));
  const [k] = keys;
  if (k !== "only" && k !== "except") return err(shape(path, `unknown selector key "${k}"`));
  const globs = parseStringList(v[k], `${path}.${k}`);
  return globs.ok ? ok({ kind: k, globs: globs.value }) : globs;
};

const parseOptionalSelector = (v: unknown, path: string): Result<Option<Selector>, ConfigError> => {
  if (v === undefined) return ok(none);
  const s = parseSelector(v, path);
  return s.ok ? ok(some(s.value)) : s;
};

export const parseCell = (s: string): Option<Cell> => {
  const m = /^([^/]+)\/([^/]+)$/.exec(s.trim());
  return m && m[1] && m[2] ? some({ host: m[1], agent: m[2] }) : none;
};
export const cellText = (c: Cell): string => `${c.host}/${c.agent}`;
export const cellEq = (a: Cell, b: Cell): boolean => a.host === b.host && a.agent === b.agent;

const parseCells = (v: unknown, path: string): Result<readonly Cell[], ConfigError> => {
  if (v === undefined) return ok([]);
  const list = parseStringList(v, path);
  if (!list.ok) return list;
  const cells = list.value.map(parseCell);
  const bad = list.value.filter((_, i) => !cells[i]?.some);
  return bad.length > 0
    ? err(shape(path, `cells must look like host/agent, got: ${bad.join(", ")}`))
    : ok(cells.flatMap((c) => (c.some ? [c.value] : [])));
};

const parseRule = (v: unknown, path: string): Result<Rule, ConfigError> => {
  if (!isRecord(v)) return err(shape(path, "rule must be a map"));
  const skills = parseStringList(v["skills"], `${path}.skills`);
  if (!skills.ok) return skills;
  const hosts = parseOptionalSelector(v["hosts"], `${path}.hosts`);
  if (!hosts.ok) return hosts;
  const agents = parseOptionalSelector(v["agents"], `${path}.agents`);
  if (!agents.ok) return agents;
  const on = parseCells(v["on"], `${path}.on`);
  if (!on.ok) return on;
  const off = parseCells(v["off"], `${path}.off`);
  if (!off.ok) return off;
  return ok({ skills: skills.value, hosts: hosts.value, agents: agents.value, on: on.value, off: off.value });
};

const parseHost = (id: string, v: unknown): Result<HostConfig, ConfigError> => {
  if (v === null || v === undefined) return ok({ id, ssh: none, agents: none, skm: "~/.skm" });
  if (!isRecord(v)) return err(shape(`hosts.${id}`, "host must be a map"));
  const ssh = v["ssh"];
  if (ssh !== undefined && typeof ssh !== "string") return err(shape(`hosts.${id}.ssh`, "expected string"));
  const skm = v["skm"] ?? "~/.skm";
  if (typeof skm !== "string") return err(shape(`hosts.${id}.skm`, "expected string"));
  const agentsRaw = v["agents"];
  if (agentsRaw === undefined) return ok({ id, ssh: ssh === undefined ? none : some(ssh), agents: none, skm });
  const agents = parseStringList(agentsRaw, `hosts.${id}.agents`);
  return agents.ok ? ok({ id, ssh: ssh === undefined ? none : some(ssh), agents: some(agents.value), skm }) : agents;
};

const sequence = <T>(rs: readonly Result<T, ConfigError>[]): Result<T[], ConfigError> =>
  rs.reduce<Result<T[], ConfigError>>((acc, r) => (acc.ok ? (r.ok ? ok([...acc.value, r.value]) : r) : acc), ok([]));

export const parseConfig = (text: string): Result<Config, ConfigError> => {
  let doc: unknown;
  try {
    doc = parseYaml(text) ?? {};
  } catch (e) {
    return err({ kind: "yaml", message: e instanceof Error ? e.message : String(e) });
  }
  if (!isRecord(doc)) return err(shape("", "config must be a map"));
  const d = defaultConfig();

  const store = doc["store"] ?? d.store;
  if (typeof store !== "string") return err(shape("store", "expected string"));

  const agents = doc["agents"] === undefined ? ok(d.agents) : parseStringList(doc["agents"], "agents");
  if (!agents.ok) return agents;

  const hostsRaw = doc["hosts"] ?? { local: {} };
  if (!isRecord(hostsRaw)) return err(shape("hosts", "expected a map of host id → settings"));
  const hosts = sequence(Object.entries(hostsRaw).map(([id, v]) => parseHost(id, v)));
  if (!hosts.ok) return hosts;
  if (!hosts.value.some((h) => h.id === "local")) return err({ kind: "missing-local" });

  const defaultsRaw = doc["defaults"] ?? {};
  if (!isRecord(defaultsRaw)) return err(shape("defaults", "expected a map"));
  const dh = parseSelector(defaultsRaw["hosts"], "defaults.hosts");
  if (!dh.ok) return dh;
  const da = parseSelector(defaultsRaw["agents"], "defaults.agents");
  if (!da.ok) return da;

  const rulesRaw = doc["rules"] ?? [];
  if (!Array.isArray(rulesRaw)) return err(shape("rules", "expected a list"));
  const rules = sequence(rulesRaw.map((r, i) => parseRule(r, `rules[${i}]`)));
  if (!rules.ok) return rules;

  const evalRaw = doc["eval"] ?? {};
  if (!isRecord(evalRaw)) return err(shape("eval", "expected a map"));
  const evalAgent = evalRaw["agent"] ?? d.eval.agent;
  if (evalAgent !== "claude" && evalAgent !== "codex") return err(shape("eval.agent", "expected claude or codex"));
  const model = evalRaw["model"];
  if (model !== undefined && typeof model !== "string") return err(shape("eval.model", "expected string"));

  const contextTokens = doc["contextTokens"] ?? d.contextTokens;
  if (typeof contextTokens !== "number" || contextTokens <= 0) return err(shape("contextTokens", "expected positive number"));
  const backupBeforeApply = doc["backupBeforeApply"] ?? d.backupBeforeApply;
  if (typeof backupBeforeApply !== "boolean") return err(shape("backupBeforeApply", "expected boolean"));

  return ok({
    store,
    agents: agents.value,
    hosts: hosts.value,
    defaults: { hosts: dh.value, agents: da.value },
    rules: rules.value,
    eval: { agent: evalAgent, model: model === undefined ? none : some(model) },
    contextTokens,
    backupBeforeApply,
  });
};

// ---------- serialization (pure) ----------

const selectorToRaw = (s: Selector): unknown => {
  switch (s.kind) {
    case "all":
      return "all";
    case "only":
      return { only: [...s.globs] };
    case "except":
      return { except: [...s.globs] };
  }
};

const ruleToRaw = (r: Rule): Raw => ({
  skills: [...r.skills],
  ...(r.hosts.some ? { hosts: selectorToRaw(r.hosts.value) } : {}),
  ...(r.agents.some ? { agents: selectorToRaw(r.agents.value) } : {}),
  ...(r.on.length > 0 ? { on: r.on.map(cellText) } : {}),
  ...(r.off.length > 0 ? { off: r.off.map(cellText) } : {}),
});

const hostToRaw = (h: HostConfig): Raw => ({
  ...(h.ssh.some ? { ssh: h.ssh.value } : {}),
  ...(h.agents.some ? { agents: [...h.agents.value] } : {}),
  ...(h.skm !== "~/.skm" ? { skm: h.skm } : {}),
});

export const serializeConfig = (c: Config): string =>
  toYaml({
    store: c.store,
    agents: [...c.agents],
    hosts: Object.fromEntries(c.hosts.map((h) => [h.id, hostToRaw(h)])),
    defaults: { hosts: selectorToRaw(c.defaults.hosts), agents: selectorToRaw(c.defaults.agents) },
    rules: c.rules.map(ruleToRaw),
    eval: { agent: c.eval.agent, ...(c.eval.model.some ? { model: c.eval.model.value } : {}) },
    contextTokens: c.contextTokens,
    backupBeforeApply: c.backupBeforeApply,
  });

export const hostById = (c: Config, id: string): Option<HostConfig> => {
  const h = c.hosts.find((x) => x.id === id);
  return h ? some(h) : none;
};

/** Agents enabled on a host: host override ∩ global list, else global list. */
export const hostAgents = (c: Config, h: HostConfig): readonly string[] =>
  h.agents.some ? h.agents.value.filter((a) => c.agents.includes(a)) : c.agents;

export const configErrorText = (e: ConfigError): string => {
  switch (e.kind) {
    case "yaml":
      return `config YAML error: ${e.message}`;
    case "shape":
      return `config error at ${e.path || "<root>"}: ${e.message}`;
    case "missing-local":
      return "config must declare a `local` host under hosts:";
  }
};
