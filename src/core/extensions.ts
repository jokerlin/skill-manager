import { parse as parseYaml } from "yaml";
import { type Result, err, ok } from "../lib/result";
import { AGENTS, type Agent, dirFn } from "./agents";
import { RESERVED_PARAMS } from "./upstream";

/**
 * Extensions: YAML files in `~/.skm/extensions/` that add what the built-in registry does not know: agents that
 * consume skills, and sources that serve them. They are data only (no code runs at load time); the commands they
 * name run when an update or an upstream check needs them.
 *
 *   name: my-setup                     # optional, defaults to the file name
 *   agents:                            # agents beyond claude / codex / pi
 *     - id: opencode
 *       name: OpenCode
 *       skillsDir: ~/.config/opencode/skills
 *       alsoReads: [~/.claude/skills]  # dirs it also loads (reported, never managed)
 *       cli: { bin: opencode, update: opencode upgrade }
 *   sources:                           # where `upstreams:` entries with `source: <id>` get their skills
 *     - id: my-registry
 *       params: [namespace]            # keys each upstream must set; reach the commands as $NAMESPACE
 *       latest: my-registry latest "$NAMESPACE/$SKILL"          # prints the newest version
 *       fetch: my-registry get "$NAMESPACE/$SKILL@$VERSION" -o "$OUT"   # writes the skill's files into $OUT
 *
 * A key skm used to read and no longer does (`tools:`, `apps:`) loads with a warning, so an old file keeps its other parts.
 */

/** Keys older versions read; skm ignores them now and says so. */
const RETIRED_KEYS: Readonly<Record<string, string>> = {
  tools: "tools: is no longer read (skm 0.6 dropped extension tools); skm ignores it, delete it from this file",
  apps: "apps: is no longer read (skm 0.6 builds the ChatGPT app into the codex agent and dropped extension apps); skm ignores it, delete it from this file",
};

export type ExtensionAgent = {
  readonly id: string;
  readonly name: string;
  readonly skillsDir: string;
  readonly alsoReads: readonly string[];
  readonly cli: { readonly bin: string; readonly update: string };
};

/**
 * A skill source run with shell commands. Both commands get $SKILL and the upstream's params (upper-cased).
 * `latest` prints the newest version of $SKILL (its last non-empty stdout line counts). `fetch` gets $VERSION,
 * an empty dir $OUT and a scratch dir $WORK, and writes the files of $SKILL at $VERSION into $OUT
 * (SKILL.md at its root, or in its only subdir).
 */
export type ExtensionSource = {
  readonly id: string;
  readonly name: string;
  readonly params: readonly string[];
  readonly latest: string;
  readonly fetch: string;
};

/** A source as the registry holds it: which extension defined it. */
export type RegistrySource = ExtensionSource & { readonly extension: string };

export type Extension = {
  readonly name: string;
  /** the file it came from */
  readonly source: string;
  readonly agents: readonly ExtensionAgent[];
  readonly sources: readonly ExtensionSource[];
  /** problems that did not stop the file from loading */
  readonly warnings: readonly string[];
};

/** What one extension contributed, or why it was not loaded. */
export type ExtensionInfo = {
  readonly name: string;
  readonly source: string;
  /** false when `error` is set */
  readonly enabled: boolean;
  readonly agents: readonly string[];
  readonly sources: readonly string[];
  readonly warnings: readonly string[];
  readonly error: string | null;
};

/** Every agent skm can use (built-in + extensions), and every skill source extensions define. */
export type Registry = {
  readonly agents: readonly Agent[];
  readonly sources: readonly RegistrySource[];
  readonly extensions: readonly ExtensionInfo[];
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ID = /^[a-z][a-z0-9-]{0,31}$/;

type Fail = string;

const str = (v: unknown, path: string, required = true): Result<string, Fail> =>
  typeof v === "string" && v.trim() !== "" ? ok(v.trim()) : v === undefined && !required ? ok("") : err(`${path}: expected a non-empty string`);

const strList = (v: unknown, path: string): Result<readonly string[], Fail> =>
  v === undefined ? ok([]) : Array.isArray(v) && v.every((x) => typeof x === "string") ? ok(v as string[]) : err(`${path}: expected a list of strings`);

const list = <T>(v: unknown, path: string, each: (x: unknown, p: string) => Result<T, Fail>): Result<readonly T[], Fail> => {
  if (v === undefined) return ok([]);
  if (!Array.isArray(v)) return err(`${path}: expected a list`);
  return v.reduce<Result<T[], Fail>>((acc, x, i) => (acc.ok ? (() => { const r = each(x, `${path}[${i}]`); return r.ok ? ok([...acc.value, r.value]) : r; })() : acc), ok([]));
};

const id = (v: unknown, path: string): Result<string, Fail> =>
  typeof v === "string" && ID.test(v) ? ok(v) : err(`${path}: expected an id (lowercase letters, digits, dashes)`);

const parseAgent = (v: unknown, path: string): Result<ExtensionAgent, Fail> => {
  if (!isRecord(v)) return err(`${path}: expected a map`);
  const i = id(v["id"], `${path}.id`);
  if (!i.ok) return i;
  const dir = str(v["skillsDir"], `${path}.skillsDir`);
  if (!dir.ok) return dir;
  const also = strList(v["alsoReads"], `${path}.alsoReads`);
  if (!also.ok) return also;
  const cli = v["cli"] === undefined ? {} : v["cli"];
  if (!isRecord(cli)) return err(`${path}.cli: expected { bin, update }`);
  const bin = str(cli["bin"], `${path}.cli.bin`, false);
  if (!bin.ok) return bin;
  const update = str(cli["update"], `${path}.cli.update`, false);
  if (!update.ok) return update;
  const name = typeof v["name"] === "string" && v["name"].trim() !== "" ? v["name"].trim() : i.value;
  return ok({ id: i.value, name, skillsDir: dir.value, alsoReads: also.value, cli: { bin: bin.value || i.value, update: update.value } });
};

const PARAM = /^[a-z][a-z0-9_]*$/;

const parseSource = (v: unknown, path: string): Result<ExtensionSource, Fail> => {
  if (!isRecord(v)) return err(`${path}: expected a map`);
  const i = id(v["id"], `${path}.id`);
  if (!i.ok) return i;
  const latest = str(v["latest"], `${path}.latest`);
  if (!latest.ok) return latest;
  const fetch = str(v["fetch"], `${path}.fetch`);
  if (!fetch.ok) return fetch;
  const params = strList(v["params"], `${path}.params`);
  if (!params.ok) return params;
  const bad = params.value.filter((p) => !PARAM.test(p) || (RESERVED_PARAMS as readonly string[]).includes(p));
  if (bad.length > 0) return err(`${path}.params: not a param name: ${bad.join(", ")} (lowercase letters, digits and '_'; not ${RESERVED_PARAMS.join(", ")})`);
  const name = typeof v["name"] === "string" && v["name"].trim() !== "" ? v["name"].trim() : i.value;
  return ok({ id: i.value, name, params: params.value, latest: latest.value, fetch: fetch.value });
};

/** One extension file → an Extension, or the first problem in it. Pure. */
export const parseExtension = (text: string, source: string, fallbackName: string): Result<Extension, Fail> => {
  let doc: unknown;
  try {
    doc = parseYaml(text) ?? {};
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  if (!isRecord(doc)) return err("expected a map with agents / sources");
  const unknownKeys = Object.keys(doc).filter((k) => !["name", "agents", "sources"].includes(k) && RETIRED_KEYS[k] === undefined);
  if (unknownKeys.length > 0) return err(`unknown keys: ${unknownKeys.join(", ")}`);
  const name = doc["name"] === undefined ? ok(fallbackName) : id(doc["name"], "name");
  if (!name.ok) return name;
  const agents = list(doc["agents"], "agents", parseAgent);
  if (!agents.ok) return agents;
  const sources = list(doc["sources"], "sources", parseSource);
  if (!sources.ok) return sources;
  const warnings = Object.keys(doc).flatMap((k) => (RETIRED_KEYS[k] !== undefined ? [RETIRED_KEYS[k]] : []));
  return ok({ name: name.value, source, agents: agents.value, sources: sources.value, warnings });
};

const agentOf = (e: ExtensionAgent, extension: string): Agent => ({
  id: e.id,
  name: e.name,
  userDir: dirFn(e.skillsDir),
  listing: { kind: "plain" },
  alsoReads: e.alsoReads.map(dirFn),
  cli: e.cli,
  extension,
});

const info = (e: Extension, error: string | null): ExtensionInfo => ({
  name: e.name, source: e.source, enabled: error === null, error, agents: e.agents.map((a) => a.id), sources: e.sources.map((x) => x.id), warnings: e.warnings,
});

/**
 * Built-in agents + every extension. An extension whose ids clash with something already registered
 * is skipped as a whole (with the reason), so one bad file never changes what another one means. Pure.
 */
export const buildRegistry = (
  extensions: readonly Extension[],
  failed: readonly { readonly name: string; readonly source: string; readonly error: string }[] = [],
): Registry => {
  type Acc = { readonly agents: readonly Agent[]; readonly sources: readonly RegistrySource[]; readonly infos: readonly ExtensionInfo[] };
  // agents and sources are separate id spaces: an upstream names a source, a rule names an agent
  const clashes = (taken: readonly string[], ids: readonly string[]) => ids.filter((x, i) => taken.includes(x) || ids.indexOf(x) !== i);
  const acc = extensions.reduce<Acc>((a, e) => {
    if (a.infos.some((i) => i.name === e.name)) return { ...a, infos: [...a.infos, info(e, `another extension is already named ${e.name}`)] };
    const clash = [
      ...clashes(a.agents.map((x) => x.id), e.agents.map((x) => x.id)),
      ...clashes(a.sources.map((x) => x.id), e.sources.map((x) => x.id)),
    ];
    if (clash.length > 0) return { ...a, infos: [...a.infos, info(e, `ids already in use: ${[...new Set(clash)].join(", ")}`)] };
    return {
      agents: [...a.agents, ...e.agents.map((x) => agentOf(x, e.name))],
      sources: [...a.sources, ...e.sources.map((x) => ({ ...x, extension: e.name }))],
      infos: [...a.infos, info(e, null)],
    };
  }, { agents: AGENTS, sources: [], infos: [] });
  return {
    agents: acc.agents,
    sources: acc.sources,
    extensions: [...acc.infos, ...failed.map((f): ExtensionInfo => ({ name: f.name, source: f.source, enabled: false, agents: [], sources: [], warnings: [], error: f.error }))],
  };
};

/** The registry with only the built-in agents (what pure code and tests see without reading ~/.skm/extensions). */
export const builtinRegistry = (): Registry => buildRegistry([]);
