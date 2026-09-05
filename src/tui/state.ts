import { match } from "ts-pattern";
import type { Config } from "../core/config";
import type { EvalCacheEntry } from "../shell/cache";
import type { Insight } from "../core/heuristics";
import type { Inventory } from "../core/inventory";
import type { Op } from "../core/plan";
import type { Skill } from "../core/skill";
import type { HostError } from "../shell/probe";

export type View = "skills" | "hosts" | "sync" | "insights" | "help";
export const VIEWS: readonly View[] = ["skills", "hosts", "sync", "insights", "help"];

export type HostStatus =
  | { readonly kind: "probing" }
  | { readonly kind: "ready"; readonly inventory: Inventory; readonly ops: readonly Op[] }
  | { readonly kind: "error"; readonly error: HostError };

export type Focus = "list" | "grid";

export type State = {
  readonly view: View;
  readonly config: Config;
  readonly skills: readonly Skill[];
  readonly selected: number;             // index into visibleSkills(state)
  readonly filter: string;
  readonly editingFilter: boolean;
  readonly sortBy: "name" | "cost";
  readonly focus: Focus;
  readonly grid: { readonly host: number; readonly agent: number };
  readonly hosts: Readonly<Record<string, HostStatus>>;
  readonly insights: readonly Insight[];
  readonly evals: Readonly<Record<string, EvalCacheEntry>>;
  readonly log: readonly string[];
  readonly busy: string | undefined;     // what a long-running IO is doing
  readonly confirmSync: boolean;
  readonly replaceConflicts: boolean;
  readonly message: string;
};

export type Action =
  | { readonly type: "view"; readonly view: View }
  | { readonly type: "nextView" }
  | { readonly type: "move"; readonly delta: number }
  | { readonly type: "moveGrid"; readonly dHost: number; readonly dAgent: number }
  | { readonly type: "focus"; readonly focus: Focus }
  | { readonly type: "filter"; readonly text: string }
  | { readonly type: "editFilter"; readonly on: boolean }
  | { readonly type: "toggleSort" }
  | { readonly type: "config"; readonly config: Config }
  | { readonly type: "host"; readonly id: string; readonly status: HostStatus }
  | { readonly type: "evals"; readonly evals: Readonly<Record<string, EvalCacheEntry>> }
  | { readonly type: "log"; readonly line: string }
  | { readonly type: "busy"; readonly what: string | undefined }
  | { readonly type: "confirmSync"; readonly on: boolean }
  | { readonly type: "toggleReplace" }
  | { readonly type: "message"; readonly text: string };

export const visibleSkills = (s: State): readonly Skill[] => {
  const q = s.filter.toLowerCase();
  const filtered = q.length === 0 ? s.skills : s.skills.filter((k) => k.name.toLowerCase().includes(q) || descriptionLower(k).includes(q));
  return [...filtered].sort((a, b) => (s.sortBy === "cost" ? b.cost.descChars - a.cost.descChars || a.name.localeCompare(b.name) : a.name.localeCompare(b.name)));
};

const descriptionLower = (k: Skill): string =>
  k.parsed.ok && k.parsed.value.frontmatter.description.some ? k.parsed.value.frontmatter.description.value.toLowerCase() : "";

export const selectedSkill = (s: State): Skill | undefined => visibleSkills(s)[s.selected];

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

export const reduce = (s: State, a: Action): State =>
  match(a)
    .with({ type: "view" }, ({ view }) => ({ ...s, view, confirmSync: false }))
    .with({ type: "nextView" }, () => ({ ...s, view: VIEWS[(VIEWS.indexOf(s.view) + 1) % VIEWS.length] ?? "skills", confirmSync: false }))
    .with({ type: "move" }, ({ delta }) => ({ ...s, selected: clamp(s.selected + delta, 0, Math.max(0, visibleSkills(s).length - 1)) }))
    .with({ type: "moveGrid" }, ({ dHost, dAgent }) => ({
      ...s,
      grid: {
        host: clamp(s.grid.host + dHost, 0, Math.max(0, s.config.hosts.length - 1)),
        agent: clamp(s.grid.agent + dAgent, 0, Math.max(0, s.config.agents.length - 1)),
      },
    }))
    .with({ type: "focus" }, ({ focus }) => ({ ...s, focus }))
    .with({ type: "filter" }, ({ text }) => ({ ...s, filter: text, selected: 0 }))
    .with({ type: "editFilter" }, ({ on }) => ({ ...s, editingFilter: on }))
    .with({ type: "toggleSort" }, (): State => ({ ...s, sortBy: s.sortBy === "name" ? "cost" : "name", selected: 0 }))
    .with({ type: "config" }, ({ config }) => ({ ...s, config }))
    .with({ type: "host" }, ({ id, status }) => ({ ...s, hosts: { ...s.hosts, [id]: status } }))
    .with({ type: "evals" }, ({ evals }) => ({ ...s, evals }))
    .with({ type: "log" }, ({ line }) => ({ ...s, log: [...s.log.slice(-199), line] }))
    .with({ type: "busy" }, ({ what }) => ({ ...s, busy: what }))
    .with({ type: "confirmSync" }, ({ on }) => ({ ...s, confirmSync: on }))
    .with({ type: "toggleReplace" }, () => ({ ...s, replaceConflicts: !s.replaceConflicts }))
    .with({ type: "message" }, ({ text }) => ({ ...s, message: text }))
    .exhaustive();

export const initialState = (config: Config, skills: readonly Skill[], insights: readonly Insight[], evals: Readonly<Record<string, EvalCacheEntry>>): State => ({
  view: "skills",
  config,
  skills,
  selected: 0,
  filter: "",
  editingFilter: false,
  sortBy: "name",
  focus: "list",
  grid: { host: 0, agent: 0 },
  hosts: Object.fromEntries(config.hosts.map((h) => [h.id, { kind: "probing" as const }])),
  insights,
  evals,
  log: [],
  busy: undefined,
  confirmSync: false,
  replaceConflicts: false,
  message: "",
});

/** Live glyph for a (skill, host, agent) cell given the desired state and the last probe. */
export const cellGlyph = (s: State, skill: string, hostId: string, agentId: string, desired: boolean): { glyph: string; color: "green" | "gray" | "yellow" | "red" | "cyan" | "magenta" } => {
  const h = s.hosts[hostId];
  if (!h || h.kind === "probing") return { glyph: desired ? "◌" : "○", color: "gray" };
  if (h.kind === "error") return { glyph: "?", color: "gray" };
  const e = h.inventory.agentDirs[agentId]?.entries.find((x) => x.name === skill);
  if (e === undefined) return desired ? { glyph: "◌", color: "yellow" } : { glyph: "○", color: "gray" };
  return match(e)
    .with({ kind: "managed" }, () => (desired ? { glyph: "●", color: "green" as const } : { glyph: "●", color: "yellow" as const }))
    .with({ kind: "dir" }, () => ({ glyph: "▣", color: "yellow" as const }))
    .with({ kind: "foreign-link" }, () => ({ glyph: "↗", color: "magenta" as const }))
    .with({ kind: "broken-link" }, () => ({ glyph: "✗", color: "red" as const }))
    .with({ kind: "file" }, () => ({ glyph: "·", color: "gray" as const }))
    .exhaustive();
};
