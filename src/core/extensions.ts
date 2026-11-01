import { parse as parseYaml } from "yaml";
import { type Result, err, ok } from "../lib/result";
import { AGENTS, type Agent, type AgentApp, dirFn } from "./agents";
import type { Selector } from "./config";

const ALL: Selector = { kind: "all" };

/**
 * Extensions: YAML files in `~/.skm/extensions/` that add what the built-in registry does not know.
 * They are data only (no code runs at load time); the shell commands they name run the same way as an agent's
 * own update command, on the hosts they select.
 *
 *   name: my-setup                     # optional, defaults to the file name
 *   agents:                            # agents beyond claude / codex / pi
 *     - id: opencode
 *       name: OpenCode
 *       skillsDir: ~/.config/opencode/skills
 *       alsoReads: [~/.claude/skills]  # dirs it also loads (reported, never managed)
 *       cli: { bin: opencode, update: opencode upgrade }
 *   apps:                              # an agent's macOS desktop app that writes plugin marketplaces
 *     - { id: chatgpt, agent: codex, name: ChatGPT, bundle: /Applications/ChatGPT.app, feed: <appcast url>, marketplaces: [...], marker: <~/ file> }
 *   tools:                             # anything else `skm harness` should check and update on each host
 *     - id: magpie
 *       bin: magpie
 *       update: magpie update
 *       onChange: magpie daemon restart   # runs only when the version changed
 *       hosts: { only: [mini] }
 */

/** A tool from an extension: checked with `<bin> --version`, updated with `update`, then `onChange` when the version moved. */
export type ExtensionTool = {
  readonly id: string;
  readonly name: string;
  readonly bin: string;
  readonly update: string;
  readonly onChange: string;
  readonly hosts: Selector;
  readonly extension: string;
};

export type ExtensionAgent = {
  readonly id: string;
  readonly name: string;
  readonly skillsDir: string;
  readonly alsoReads: readonly string[];
  readonly cli: { readonly bin: string; readonly update: string };
};

export type ExtensionApp = AgentApp & { readonly agent: string };

export type Extension = {
  readonly name: string;
  /** file path, or "builtin" */
  readonly source: string;
  readonly agents: readonly ExtensionAgent[];
  readonly apps: readonly ExtensionApp[];
  readonly tools: readonly Omit<ExtensionTool, "extension">[];
};

/** What one extension contributed, or why it was not loaded. */
export type ExtensionInfo = {
  readonly name: string;
  readonly source: string;
  readonly enabled: boolean;
  readonly agents: readonly string[];
  readonly apps: readonly string[];
  readonly tools: readonly string[];
  readonly error: string | null;
};

/** Every agent skm can use (built-in + extensions, desktop apps attached) and the extra harness tools. */
export type Registry = {
  readonly agents: readonly Agent[];
  readonly tools: readonly ExtensionTool[];
  readonly extensions: readonly ExtensionInfo[];
};

/** Shipped with skm, switchable off with config `disabledExtensions: [chatgpt-desktop]`. */
export const BUILTIN_EXTENSIONS: readonly Extension[] = [
  {
    name: "chatgpt-desktop",
    source: "builtin",
    agents: [],
    // ChatGPT.app (bundle id com.openai.codex) materializes openai-bundled and installs the runtime that holds openai-primary-runtime
    apps: [{
      id: "chatgpt",
      agent: "codex",
      name: "ChatGPT",
      bundle: "/Applications/ChatGPT.app",
      feed: "https://persistent.oaistatic.com/codex-app-prod/appcast.xml",
      marketplaces: ["openai-bundled", "openai-primary-runtime"],
      marker: ".codex/.tmp/bundled-marketplaces/openai-bundled/.materialization-key",
      settle: { file: ".cache/codex-runtimes/codex-primary-runtime/runtime.json", busy: ".cache/codex-runtimes/codex-runtime-install-*" },
    }],
    tools: [],
  },
];

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

const hostsSel = (v: unknown, path: string): Result<Selector, Fail> => {
  if (v === undefined || v === "all") return ok(ALL);
  if (isRecord(v) && Array.isArray(v["only"]) && v["only"].every((x) => typeof x === "string")) return ok({ kind: "only", globs: v["only"] as string[] });
  if (isRecord(v) && Array.isArray(v["except"]) && v["except"].every((x) => typeof x === "string")) return ok({ kind: "except", globs: v["except"] as string[] });
  return err(`${path}: expected all, { only: [...] } or { except: [...] }`);
};

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

const parseApp = (v: unknown, path: string): Result<ExtensionApp, Fail> => {
  if (!isRecord(v)) return err(`${path}: expected a map`);
  const i = id(v["id"], `${path}.id`);
  if (!i.ok) return i;
  const fields = ["agent", "bundle", "feed", "marker"] as const;
  const vals: Record<string, string> = {};
  for (const f of fields) {
    const r = str(v[f], `${path}.${f}`);
    if (!r.ok) return r;
    vals[f] = r.value;
  }
  if (!/^https:\/\//.test(vals["feed"] ?? "")) return err(`${path}.feed: expected an https URL`);
  const mks = strList(v["marketplaces"], `${path}.marketplaces`);
  if (!mks.ok) return mks;
  const settle = v["settle"];
  if (settle !== undefined && !(isRecord(settle) && typeof settle["file"] === "string" && typeof settle["busy"] === "string")) return err(`${path}.settle: expected { file, busy }`);
  return ok({
    id: i.value, agent: vals["agent"] ?? "", name: typeof v["name"] === "string" ? v["name"] : i.value,
    bundle: vals["bundle"] ?? "", feed: vals["feed"] ?? "", marker: vals["marker"] ?? "", marketplaces: mks.value,
    ...(isRecord(settle) ? { settle: { file: String(settle["file"]), busy: String(settle["busy"]) } } : {}),
  });
};

const parseTool = (v: unknown, path: string): Result<Omit<ExtensionTool, "extension">, Fail> => {
  if (!isRecord(v)) return err(`${path}: expected a map`);
  const i = id(v["id"], `${path}.id`);
  if (!i.ok) return i;
  const bin = str(v["bin"], `${path}.bin`, false);
  if (!bin.ok) return bin;
  const update = str(v["update"], `${path}.update`);
  if (!update.ok) return update;
  const onChange = str(v["onChange"], `${path}.onChange`, false);
  if (!onChange.ok) return onChange;
  const hosts = hostsSel(v["hosts"], `${path}.hosts`);
  if (!hosts.ok) return hosts;
  return ok({ id: i.value, name: typeof v["name"] === "string" ? v["name"] : i.value, bin: bin.value || i.value, update: update.value, onChange: onChange.value, hosts: hosts.value });
};

/** One extension file → an Extension, or the first problem in it. Pure. */
export const parseExtension = (text: string, source: string, fallbackName: string): Result<Extension, Fail> => {
  let doc: unknown;
  try {
    doc = parseYaml(text) ?? {};
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  if (!isRecord(doc)) return err("expected a map with agents / apps / tools");
  const unknownKeys = Object.keys(doc).filter((k) => !["name", "agents", "apps", "tools"].includes(k));
  if (unknownKeys.length > 0) return err(`unknown keys: ${unknownKeys.join(", ")}`);
  const name = doc["name"] === undefined ? ok(fallbackName) : id(doc["name"], "name");
  if (!name.ok) return name;
  const agents = list(doc["agents"], "agents", parseAgent);
  if (!agents.ok) return agents;
  const apps = list(doc["apps"], "apps", parseApp);
  if (!apps.ok) return apps;
  const tools = list(doc["tools"], "tools", parseTool);
  if (!tools.ok) return tools;
  return ok({ name: name.value, source, agents: agents.value, apps: apps.value, tools: tools.value });
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

const info = (e: Extension, enabled: boolean, error: string | null): ExtensionInfo => ({
  name: e.name, source: e.source, enabled, error,
  agents: e.agents.map((a) => a.id), apps: e.apps.map((a) => a.id), tools: e.tools.map((t) => t.id),
});

/**
 * Built-in agents + every enabled extension. An extension whose ids clash with something already registered
 * is skipped as a whole (with the reason), so one bad file never changes what another one means. Pure.
 */
export const buildRegistry = (
  extensions: readonly Extension[],
  disabled: readonly string[],
  failed: readonly { readonly name: string; readonly source: string; readonly error: string }[] = [],
): Registry => {
  type Acc = { agents: Agent[]; apps: ExtensionApp[]; tools: ExtensionTool[]; infos: ExtensionInfo[] };
  const start: Acc = { agents: [...AGENTS], apps: [], tools: [], infos: [] };
  const acc = extensions.reduce<Acc>((a, e) => {
    if (disabled.includes(e.name) || a.infos.some((i) => i.name === e.name)) {
      return { ...a, infos: [...a.infos, info(e, false, disabled.includes(e.name) ? null : `another extension is already named ${e.name}`)] };
    }
    const taken = new Set([...a.agents.map((x) => x.id), ...a.apps.map((x) => x.id), ...a.tools.map((x) => x.id)]);
    const ids = [...e.agents.map((x) => x.id), ...e.apps.map((x) => x.id), ...e.tools.map((x) => x.id)];
    const clash = ids.filter((x, i) => taken.has(x) || ids.indexOf(x) !== i);
    if (clash.length > 0) return { ...a, infos: [...a.infos, info(e, false, `ids already in use: ${[...new Set(clash)].join(", ")}`)] };
    return {
      agents: [...a.agents, ...e.agents.map((x) => agentOf(x, e.name))],
      apps: [...a.apps, ...e.apps],
      tools: [...a.tools, ...e.tools.map((t) => ({ ...t, extension: e.name }))],
      infos: [...a.infos, info(e, true, null)],
    };
  }, start);
  // an app attaches to its agent; one naming an unknown agent is reported, not attached
  const orphan = acc.apps.filter((p) => !acc.agents.some((g) => g.id === p.agent));
  const infos = acc.infos.map((i) => {
    const bad = orphan.filter((p) => i.apps.includes(p.id));
    return bad.length > 0 && i.error === null ? { ...i, error: `app ${bad.map((p) => p.id).join(", ")} names an unknown agent ${bad.map((p) => p.agent).join(", ")}` } : i;
  });
  const agents = acc.agents.map((g) => {
    const app = acc.apps.find((p) => p.agent === g.id);
    if (app === undefined) return g;
    const { agent: _agent, ...rest } = app;
    return { ...g, app: rest };
  });
  return {
    agents,
    tools: acc.tools,
    extensions: [...infos, ...failed.map((f) => ({ name: f.name, source: f.source, enabled: false, agents: [], apps: [], tools: [], error: f.error }))],
  };
};

/** The registry with only the built-in extensions (what pure code and tests see without reading ~/.skm/extensions). */
export const builtinRegistry = (disabled: readonly string[] = []): Registry => buildRegistry(BUILTIN_EXTENSIONS, disabled);
