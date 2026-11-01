import { match } from "ts-pattern";
import type { Config } from "../core/config";
import type { Inventory } from "../core/inventory";
import { type Op, isMutation } from "../core/plan";
import type { Skill } from "../core/skill";
import type { HostView } from "../core/view";
import { type CoverageSummary, summarize } from "../core/coverage";
import { type PluginCellState, type PluginRow, pluginRows } from "../core/pluginUpdate";
import { isDesired, pluginWanted, setPluginScope } from "../core/scope";
import { type Cell, PLUGIN_AGENTS } from "../core/config";
import { agentsOn } from "../shell/hosts";
import type { HostError } from "../shell/probe";
import type { SkillReport, UpstreamReport, UpstreamResult } from "../shell/upstreamOps";
import { type HarnessHost, mergeHarness } from "../core/harness";
import { resolveAgent } from "../core/agents";
import { type Option, type Result, err, none, ok, some } from "../lib/result";

/** Same order and names as the desktop app: Skills, Plugins, Hosts, then the pending changes. */
export type View = "skills" | "plugins" | "hosts" | "changes" | "help";
export const VIEWS: readonly View[] = ["skills", "plugins", "hosts", "changes", "help"];

/** What a y/n prompt would start: apply every pending change, update one plugin on every host, or write skills from their upstream. */
export type Confirm =
  | { readonly kind: "none" }
  | { readonly kind: "apply" }
  | { readonly kind: "plugin-update"; readonly plugin: string }
  | { readonly kind: "upstream-update"; readonly skills: readonly string[]; readonly force: boolean }
  | { readonly kind: "harness-update" };

/** The last upstream check (empty until one finishes) and whether another is running. */
export type UpstreamView = { readonly results: readonly UpstreamResult[]; readonly checking: boolean };

/** Agent CLI and app versions per host (the cached run first, then a live check) and whether a check is running. */
export type HarnessView = { readonly runs: readonly HarnessHost[]; readonly checking: boolean };

export type HostStatus =
  | { readonly kind: "probing" }
  | { readonly kind: "ready"; readonly inventory: Inventory; readonly ops: readonly Op[]; readonly view?: HostView }
  | { readonly kind: "error"; readonly error: HostError };

export type Focus = "list" | "grid";

/** Skills list ordering: `o` cycles the key (each starts in its natural direction), `O` flips the direction. */
export type SortKey = "name" | "listing" | "body";
export type SortState = { readonly by: SortKey; readonly dir: "asc" | "desc" };
const SORT_KEYS: readonly SortKey[] = ["name", "listing", "body"];
const naturalDir = (by: SortKey): SortState["dir"] => (by === "name" ? "asc" : "desc");
export const nextSort = (s: SortState): SortState => {
  const by = SORT_KEYS[(SORT_KEYS.indexOf(s.by) + 1) % SORT_KEYS.length] ?? "name";
  return { by, dir: naturalDir(by) };
};
/** How many leading segments fit side by side in `width` columns, given each segment's width. Whole segments only. */
export const fitCount = (widths: readonly number[], width: number): number =>
  widths.reduce((acc, w) => (acc.full || acc.used + w > width ? { ...acc, full: true } : { n: acc.n + 1, used: acc.used + w, full: false }), { n: 0, used: 0, full: false }).n;

export const sortText = (s: SortState): string => `${s.by} ${s.dir === "asc" ? "↑" : "↓"}`;

export type State = {
  readonly view: View;
  readonly config: Config;
  readonly skills: readonly Skill[];
  readonly selected: number;             // index into visibleSkills(state)
  readonly filter: string;
  readonly editingFilter: boolean;
  readonly sort: SortState;
  readonly focus: Focus;
  readonly grid: { readonly host: number; readonly agent: number };
  readonly hostsOffset: number;          // first visible row of the hosts view
  readonly allFindings: boolean;         // hosts view: every finding, or one summary line per host
  readonly pluginSel: number;            // index into pluginRowsOf(state)
  readonly pluginFocus: Focus;           // plugins view: the list, or the selected plugin's hosts × agents cells
  readonly pluginCell: number;           // index into pluginGrid(state, selected row)
  readonly hosts: Readonly<Record<string, HostStatus>>;
  readonly log: readonly string[];
  readonly busy: string | undefined;     // what a long-running IO is doing
  readonly confirm: Confirm;
  readonly replaceConflicts: boolean;
  readonly message: string;
  readonly upstream: UpstreamView;
  readonly harness: HarnessView;
};

export type Action =
  | { readonly type: "view"; readonly view: View }
  | { readonly type: "nextView" }
  | { readonly type: "move"; readonly delta: number }
  | { readonly type: "moveGrid"; readonly dHost: number; readonly dAgent: number }
  | { readonly type: "scrollHosts"; readonly offset: number }
  | { readonly type: "toggleFindings" }
  | { readonly type: "movePlugin"; readonly delta: number }
  | { readonly type: "pluginFocus"; readonly focus: Focus }
  | { readonly type: "movePluginCell"; readonly delta: number }
  | { readonly type: "focus"; readonly focus: Focus }
  | { readonly type: "filter"; readonly text: string }
  | { readonly type: "editFilter"; readonly on: boolean }
  | { readonly type: "cycleSort" }
  | { readonly type: "flipSort" }
  | { readonly type: "config"; readonly config: Config }
  | { readonly type: "host"; readonly id: string; readonly status: HostStatus }
  | { readonly type: "log"; readonly line: string }
  | { readonly type: "busy"; readonly what: string | undefined }
  | { readonly type: "confirm"; readonly confirm: Confirm }
  | { readonly type: "toggleReplace" }
  | { readonly type: "message"; readonly text: string }
  | { readonly type: "skills"; readonly skills: readonly Skill[] }
  | { readonly type: "upstreams"; readonly results: readonly UpstreamResult[] }
  | { readonly type: "upstreamChecking"; readonly on: boolean }
  | { readonly type: "harness"; readonly runs: readonly HarnessHost[] }
  | { readonly type: "harnessChecking"; readonly on: boolean };

export const visibleSkills = (s: State): readonly Skill[] => {
  const q = s.filter.toLowerCase();
  const filtered = q.length === 0 ? s.skills : s.skills.filter((k) => k.name.toLowerCase().includes(q) || descriptionLower(k).includes(q));
  const sign = s.sort.dir === "asc" ? 1 : -1;
  const key = (k: Skill): number => (s.sort.by === "listing" ? k.cost.descTokens : k.cost.bodyTokens);
  return [...filtered].sort((a, b) => (s.sort.by === "name" ? sign * a.name.localeCompare(b.name) : sign * (key(a) - key(b)) || a.name.localeCompare(b.name)));
};

const descriptionLower = (k: Skill): string =>
  k.parsed.ok && k.parsed.value.frontmatter.description.some ? k.parsed.value.frontmatter.description.value.toLowerCase() : "";

export const selectedSkill = (s: State): Skill | undefined => visibleSkills(s)[s.selected];

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

const NO_CONFIRM: Confirm = { kind: "none" };

/** Every plugin across the hosts probed so far, one row per name, plus plugins under plugins: in config.yaml that no host has yet (the desktop app's Plugins view). Pure. */
export const pluginRowsOf = (s: State): PluginRow[] => {
  const seen = pluginRows(s.config.hosts.flatMap((h) => {
    const st = s.hosts[h.id];
    return st?.kind === "ready" && st.view ? [{ host: h.id, states: st.view.states, facts: st.view.facts }] : [];
  }));
  const declared = s.config.plugins.filter((p) => !seen.some((r) => r.name === p.name)).map((p): PluginRow => ({ name: p.name, ids: [], cells: [], versions: [], drift: false }));
  return [...seen, ...declared].sort((a, b) => a.name.localeCompare(b.name));
};

/** One host × plugin-capable agent cell of a plugin: what the host has now, and what config.yaml wants (none = no policy, so today's state stays). */
export type PluginGridCell = { readonly host: string; readonly agent: string; readonly live: Option<PluginCellState>; readonly wanted: Option<boolean> };

/** Every enabled host × agent that can load plugins (Claude, Codex), as the desktop app lists them. Pure. */
export const pluginGrid = (s: State, row: PluginRow): readonly PluginGridCell[] => {
  const policy = s.config.plugins.find((p) => p.name === row.name);
  return s.config.hosts.flatMap((h) => agentsOn(s.config, h).filter((a) => PLUGIN_AGENTS.includes(a.id)).map((a): PluginGridCell => {
    const live = row.cells.find((c) => c.host === h.id && c.agent === a.id);
    return { host: h.id, agent: a.id, live: live ? some(live) : none, wanted: policy ? some(pluginWanted(policy, h.id, a.id)) : none };
  }));
};

/** What a cell shows: on or off as it stands, or the change the next apply makes. */
export type CellPlan = "on" | "off" | "absent" | "will-enable" | "will-disable";

export const cellPlan = (c: PluginGridCell): CellPlan => {
  const on = c.live.some && c.live.value.enabled === "on";
  const wanted = c.wanted.some ? c.wanted.value : on;
  if (on) return wanted ? "on" : "will-disable";
  if (wanted) return "will-enable";
  return c.live.some ? "off" : "absent";
};

/** Whether a cell is on after the next apply: config.yaml's word, else today's state. */
export const cellWanted = (c: PluginGridCell): boolean => cellPlan(c) === "on" || cellPlan(c) === "will-enable";

/**
 * The config after flipping one cell, as `skm scope --plugin` does. A plugin with no policy yet is named
 * `name@marketplace` and keeps today's enabled cells, so the flip changes only that cell; that needs every host's
 * state, so it is refused while a host is still probing or unreachable (its enabled cells would be switched off). Pure.
 */
export const togglePluginCell = (s: State, row: PluginRow, c: PluginGridCell): Result<State["config"], string> => {
  const policy = s.config.plugins.some((p) => p.name === row.name);
  const unknown = [...new Set(pluginGrid(s, row).map((x) => x.host))].filter((h) => s.hosts[h]?.kind !== "ready");
  if (!policy && unknown.length > 0) return err(`${row.name} is not under plugins: yet, and ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not probed: wait, or r to re-probe`);
  const marketplace = c.live.some ? c.live.value.marketplace : "";
  const id = policy ? row.name : row.ids.find((x) => marketplace !== "" && x.endsWith(`@${marketplace}`)) ?? row.ids[0] ?? row.name;
  const active: Cell[] = row.cells.filter((x) => x.enabled === "on").map((x) => ({ host: x.host, agent: x.agent }));
  return ok(setPluginScope(s.config, id, c.host, c.agent, !cellWanted(c), active));
};

/** Pending changes across every reachable host: what the desktop app's bottom bar counts. */
export const pendingTotal = (s: State): number =>
  Object.values(s.hosts).reduce((n, st) => n + (st.kind === "ready" ? st.ops.filter(isMutation).length : 0), 0);

/** Where a skill is wanted, over every enabled host × agent cell: the same summary as the desktop app's coverage column. */
export const skillCoverage = (s: State, skill: string): CoverageSummary =>
  summarize(s.config.hosts.flatMap((h) => agentsOn(s.config, h).map((a) => ({ host: h.id, agent: a.id, on: isDesired(s.config, skill, h.id, a.id) }))));

/** Whether `skm plugin update` can move the plugin: some enabled copy comes from a Git/URL marketplace (not one an app writes locally). */
export const pluginUpdatable = (row: PluginRow): boolean => row.cells.some((c) => c.enabled === "on" && c.source === "portable");

export const reduce = (s: State, a: Action): State =>
  match(a)
    .with({ type: "view" }, ({ view }): State => ({ ...s, view, confirm: NO_CONFIRM }))
    .with({ type: "nextView" }, (): State => ({ ...s, view: VIEWS[(VIEWS.indexOf(s.view) + 1) % VIEWS.length] ?? "skills", confirm: NO_CONFIRM }))
    .with({ type: "move" }, ({ delta }) => ({ ...s, selected: clamp(s.selected + delta, 0, Math.max(0, visibleSkills(s).length - 1)) }))
    .with({ type: "moveGrid" }, ({ dHost, dAgent }) => ({
      ...s,
      grid: {
        host: clamp(s.grid.host + dHost, 0, Math.max(0, s.config.hosts.length - 1)),
        agent: clamp(s.grid.agent + dAgent, 0, Math.max(0, s.config.agents.length - 1)),
      },
    }))
    .with({ type: "scrollHosts" }, ({ offset }) => ({ ...s, hostsOffset: Math.max(0, offset) }))
    .with({ type: "toggleFindings" }, () => ({ ...s, allFindings: !s.allFindings }))
    .with({ type: "movePlugin" }, ({ delta }) => ({ ...s, pluginSel: clamp(s.pluginSel + delta, 0, Math.max(0, pluginRowsOf(s).length - 1)), pluginCell: 0 }))
    .with({ type: "pluginFocus" }, ({ focus }) => ({ ...s, pluginFocus: focus }))
    .with({ type: "movePluginCell" }, ({ delta }): State => {
      const row = pluginRowsOf(s)[s.pluginSel];
      return { ...s, pluginCell: clamp(s.pluginCell + delta, 0, Math.max(0, (row ? pluginGrid(s, row).length : 0) - 1)) };
    })
    .with({ type: "focus" }, ({ focus }) => ({ ...s, focus }))
    .with({ type: "filter" }, ({ text }) => ({ ...s, filter: text, selected: 0 }))
    .with({ type: "editFilter" }, ({ on }) => ({ ...s, editingFilter: on }))
    .with({ type: "cycleSort" }, (): State => ({ ...s, sort: nextSort(s.sort), selected: 0 }))
    .with({ type: "flipSort" }, (): State => ({ ...s, sort: { ...s.sort, dir: s.sort.dir === "asc" ? "desc" : "asc" }, selected: 0 }))
    .with({ type: "config" }, ({ config }) => ({ ...s, config }))
    .with({ type: "host" }, ({ id, status }) => ({ ...s, hosts: { ...s.hosts, [id]: status } }))
    .with({ type: "log" }, ({ line }) => ({ ...s, log: [...s.log.slice(-199), line] }))
    .with({ type: "busy" }, ({ what }) => ({ ...s, busy: what }))
    .with({ type: "confirm" }, ({ confirm }) => ({ ...s, confirm }))
    .with({ type: "toggleReplace" }, () => ({ ...s, replaceConflicts: !s.replaceConflicts }))
    .with({ type: "message" }, ({ text }) => ({ ...s, message: text }))
    .with({ type: "skills" }, ({ skills }): State => {
      const next = { ...s, skills };
      return { ...next, selected: clamp(s.selected, 0, Math.max(0, visibleSkills(next).length - 1)) };
    })
    .with({ type: "upstreams" }, ({ results }) => ({ ...s, upstream: { ...s.upstream, results } }))
    .with({ type: "upstreamChecking" }, ({ on }) => ({ ...s, upstream: { ...s.upstream, checking: on } }))
    .with({ type: "harness" }, ({ runs }): State => {
      // a run for some hosts (or some tools) replaces only its own entries
      const ids = new Set(runs.map((r) => r.host));
      const merged = runs.map((r) => mergeHarness(s.harness.runs.find((p) => p.host === r.host) ?? null, r));
      return { ...s, harness: { ...s.harness, runs: [...s.harness.runs.filter((r) => !ids.has(r.host)), ...merged] } };
    })
    .with({ type: "harnessChecking" }, ({ on }) => ({ ...s, harness: { ...s.harness, checking: on } }))
    .exhaustive();

export const initialState = (config: Config, skills: readonly Skill[]): State => ({
  view: "skills",
  config,
  skills,
  selected: 0,
  filter: "",
  editingFilter: false,
  sort: { by: "name", dir: "asc" },
  focus: "list",
  grid: { host: 0, agent: 0 },
  hostsOffset: 0,
  allFindings: false,
  pluginSel: 0,
  pluginFocus: "list",
  pluginCell: 0,
  hosts: Object.fromEntries(config.hosts.map((h) => [h.id, { kind: "probing" as const }])),
  log: [],
  busy: undefined,
  confirm: NO_CONFIRM,
  replaceConflicts: false,
  message: "",
  upstream: { results: [], checking: false },
  harness: { runs: [], checking: false },
});

/** A row of the agent CLIs section: each agent's CLI, and each app an agent ships. */
export type HarnessToolRow = { readonly id: string; readonly name: string; readonly kind: "cli" | "app" };

/** Pure. */
export const harnessTools = (c: Config): readonly HarnessToolRow[] => {
  const agents = c.agents.flatMap((id) => { const a = resolveAgent(id, c.agentOverrides, c.registry.agents); return a.some ? [a.value] : []; });
  return [
    ...agents.map((a): HarnessToolRow => ({ id: a.id, name: a.id, kind: "cli" })),
    ...agents.flatMap((a): HarnessToolRow[] => (a.app !== undefined ? [{ id: a.app.id, name: `${a.name} desktop app (${a.app.bundle.split("/").pop() ?? a.app.name})`, kind: "app" }] : [])),
  ];
};

/** The harness runs in config host order, for hosts that have one. */
export const harnessRuns = (s: State): readonly HarnessHost[] =>
  s.config.hosts.flatMap((h) => s.harness.runs.filter((r) => r.host === h.id));

const okReports = (s: State): readonly UpstreamReport[] => s.upstream.results.flatMap((r) => (r.result.ok ? [r.result.value] : []));

export type UpstreamOf = { readonly report: UpstreamReport; readonly skill: SkillReport };

/** The upstream that supplies a skill, as the last check judged it; none when no checked upstream lists it. */
export const upstreamOf = (s: State, skill: string): Option<UpstreamOf> => {
  const hit = okReports(s).flatMap((report) => report.skills.filter((k) => k.skill === skill).map((k) => ({ report, skill: k })))[0];
  return hit ? some(hit) : none;
};

/** Skills an update writes without --force: behind their upstream, or listed but not in the store yet. */
export const upstreamUpdatable = (s: State): readonly string[] =>
  okReports(s).flatMap((r) => r.skills.filter((k) => k.state.kind === "behind" || k.state.kind === "absent").map((k) => k.skill));

/** Names of upstreams whose last check failed. */
export const upstreamFailures = (s: State): readonly string[] => s.upstream.results.flatMap((r) => (r.result.ok ? [] : [r.policy.name]));

/** Live glyph for a (skill, host, agent) cell given the desired state and the last probe. */
export const cellGlyph = (s: State, skill: string, hostId: string, agentId: string, desired: boolean): { glyph: string; color: "green" | "gray" | "yellow" | "red" | "cyan" | "magenta" } => {
  const h = s.hosts[hostId];
  if (!h || h.kind === "probing") return { glyph: desired ? "◌" : "○", color: "gray" };
  if (h.kind === "error") return { glyph: "?", color: "gray" };
  const e = h.inventory.agentDirs[agentId]?.entries.find((x) => x.name === skill);
  const loaded = h.view
    ? h.view.effective[agentId]?.some((entry) => entry.name === skill && (entry.source.kind === "user" || entry.source.kind === "legacy"))
    : e !== undefined && (e.kind === "managed" || e.kind === "dir" || e.kind === "foreign-link");
  if (loaded) return { glyph: "✓", color: desired ? "green" : "yellow" };
  if (e?.kind === "broken-link") return { glyph: "✗", color: "red" };
  return desired ? { glyph: "◌", color: "yellow" } : { glyph: "○", color: "gray" };
};
