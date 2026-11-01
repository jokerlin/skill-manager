import type { ApplyEvent, ConfigSummary, HarnessReport, HostPlan, HostStatus, PluginsReport, SkillRow } from "@shared/types";
import { create } from "zustand";
import { useI18n } from "@/i18n";
import { type SkmError, errorText, skm, streamEvents } from "@/lib/skm";

export type View = "skills" | "plugins" | "hosts";

/** One host inside an apply run. */
export type RunHost = {
  readonly host: string;
  readonly state: "queued" | "running" | "done" | "failed";
  readonly ops: number;
  readonly lines: readonly string[];
  readonly backup: string | null;
  readonly summary: string | null;
  readonly failures: readonly string[];
};

/** A sync or plugin update the app started: progress per host, then the verification result. */
export type Run = {
  readonly id: string;
  readonly kind: "sync" | "plugin-update" | "harness";
  readonly label: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly status: "running" | "done" | "failed";
  readonly hosts: Readonly<Record<string, RunHost>>;
  /** hosts (sync) or plugins (update) still not converged after the run */
  readonly pending: readonly string[] | null;
  readonly error: string | null;
};

export type ProbeState = "idle" | "probing" | "failed";

type State = {
  readonly view: View;
  readonly booted: boolean;
  readonly cliMissing: boolean;
  readonly config: ConfigSummary | null;
  readonly skills: readonly SkillRow[];
  readonly hosts: readonly HostStatus[];
  readonly plans: readonly HostPlan[];
  readonly plugins: PluginsReport | null;
  /** agent CLI versions per host (cached result first, then a live check) */
  readonly harness: HarnessReport | null;
  readonly harnessChecking: boolean;
  /** live probe state per host */
  readonly probe: Readonly<Record<string, ProbeState>>;
  /** cells with a scope write in flight: "skill|host/agent" or "plugin:name|host/agent" */
  readonly saving: ReadonlySet<string>;
  readonly runs: readonly Run[];
  readonly error: string | null;
  // panels
  readonly reviewOpen: boolean;
  readonly settingsOpen: boolean;
  readonly paletteOpen: boolean;
  readonly aboutOpen: boolean;
  readonly selectedSkill: string | null;
  readonly selectedPlugin: string | null;
  readonly selectedAgent: string | null; // "host/agent"
};

type Actions = {
  readonly setView: (v: View) => void;
  readonly boot: () => Promise<void>;
  readonly refreshLive: (host?: string) => Promise<void>;
  readonly refreshDerived: () => Promise<void>;
  readonly reloadConfig: () => Promise<void>;
  readonly toggleSkill: (skill: string, host: string, agent: string, on: boolean) => Promise<void>;
  readonly togglePlugin: (plugin: string, host: string, agent: string, on: boolean) => Promise<void>;
  readonly apply: (o?: { host?: string; replaceConflicts?: boolean }) => Promise<void>;
  readonly updatePlugins: (names: readonly string[], o?: { host?: string; agent?: string }) => Promise<void>;
  readonly checkHarness: (o?: { cached?: boolean; host?: string }) => Promise<void>;
  readonly updateHarness: (o?: { host?: string; agent?: string }) => Promise<void>;
  /** Plugins another app writes: update that app where it is behind (it rewrites them on launch), then reinstall the plugins from each host's copy. */
  readonly updateBundled: (names: readonly string[], o: { apps: readonly string[]; agent: string; host?: string }) => Promise<void>;
  readonly setPanel: (p: Partial<Pick<State, "reviewOpen" | "settingsOpen" | "paletteOpen" | "aboutOpen">>) => void;
  readonly select: (p: Partial<Pick<State, "selectedSkill" | "selectedPlugin" | "selectedAgent">>) => void;
  readonly clearError: () => void;
};

export type AppStore = State & Actions;

const failMessage = (e: SkmError): { cliMissing: boolean; error: string } => ({ cliMissing: e.kind === "not-found", error: errorText(e) });

/** Replace the rows of the given hosts, keep the order of the config. */
const mergeByHost = <T extends { readonly host: string }>(prev: readonly T[], next: readonly T[], order: readonly string[]): T[] => {
  const map = new Map(prev.map((x) => [x.host, x]));
  next.forEach((x) => map.set(x.host, x));
  const rank = (h: string) => { const i = order.indexOf(h); return i < 0 ? 999 : i; };
  return [...map.values()].sort((a, b) => rank(a.host) - rank(b.host));
};

const nowIso = () => new Date().toISOString();

const reduceRun = (run: Run, e: ApplyEvent): Run => {
  const h = (id: string): RunHost => run.hosts[id] ?? { host: id, state: "queued", ops: 0, lines: [], backup: null, summary: null, failures: [] };
  const put = (x: RunHost): Run => ({ ...run, hosts: { ...run.hosts, [x.host]: x } });
  switch (e.type) {
    case "host-start":
      return put({ ...h(e.host), state: "running", ops: e.ops });
    case "backup":
      return put({ ...h(e.host), backup: e.dir });
    case "log":
      return put({ ...h(e.host), lines: [...h(e.host).lines, e.line].slice(-200) });
    case "warn":
      return put({ ...h(e.host), lines: [...h(e.host).lines, `! ${e.line}`].slice(-200) });
    case "host-done":
      return put({
        ...h(e.host),
        state: e.ok ? "done" : "failed",
        failures: e.error !== null ? [e.error] : e.failures,
        summary: e.error ?? `${e.rsynced}·${e.applied}·${e.commandsOk}/${e.commandsOk + e.commandsFailed}`,
      });
    case "verified":
      return { ...run, pending: e.pending };
  }
};

/** Extension agents have no dictionary entry: register their names so t(agentKey(id)) shows them. */
const nameExtensionAgents = (c: ConfigSummary): void =>
  useI18n.getState().setExtra(Object.fromEntries(c.agentCatalog.filter((a) => a.extension !== null).map((a) => [`agent.${a.id}`, a.name])));

export const useApp = create<AppStore>()((set, get) => {
  const order = () => get().config?.hosts ?? [];

  /** Everything derived from config + cached probes: instant, no ssh. */
  const refreshDerived = async (): Promise<void> => {
    const [skills, plans, plugins] = await Promise.all([skm.skills(), skm.plan(), skm.plugins()]);
    if (!skills.ok) return set(failMessage(skills.error));
    set({
      skills: skills.value,
      ...(plans.ok ? { plans: plans.value } : {}),
      ...(plugins.ok ? { plugins: plugins.value } : {}),
      ...(!plans.ok ? { error: errorText(plans.error) } : {}),
    });
  };

  const startRun = (kind: Run["kind"], label: string): string => {
    const id = `${Date.now()}`;
    const run: Run = { id, kind, label, startedAt: nowIso(), finishedAt: null, status: "running", hosts: {}, pending: null, error: null };
    set((s) => ({ runs: [run, ...s.runs].slice(0, 20) }));
    return id;
  };
  const patchRun = (id: string, f: (r: Run) => Run) => set((s) => ({ runs: s.runs.map((r) => (r.id === id ? f(r) : r)) }));

  const execute = async (id: string, args: readonly string[]): Promise<void> => {
    const end = await streamEvents(args, (e) => patchRun(id, (r) => reduceRun(r, e)), (line) => patchRun(id, (r) => ({ ...r, error: r.error ?? null, hosts: r.hosts, label: r.label, pending: r.pending, ...(line.startsWith("error:") ? { error: line.replace(/^error:\s*/, "") } : {}) })));
    patchRun(id, (r) => {
      const failed = end.code !== 0 || Object.values(r.hosts).some((h) => h.state === "failed");
      return { ...r, finishedAt: nowIso(), status: failed ? "failed" : "done", error: r.error ?? (end.code !== 0 ? end.stderr.trim().split("\n").pop() ?? `exit ${end.code}` : null) };
    });
    // the command re-probed every host it touched and refreshed the cache
    const st = await skm.status({ cached: true });
    if (st.ok) set({ hosts: st.value });
    await refreshDerived();
  };

  return {
    view: "skills",
    booted: false,
    cliMissing: false,
    config: null,
    skills: [],
    hosts: [],
    plans: [],
    plugins: null,
    harness: null,
    harnessChecking: false,
    probe: {},
    saving: new Set(),
    runs: [],
    error: null,
    reviewOpen: false,
    settingsOpen: false,
    paletteOpen: false,
    aboutOpen: false,
    selectedSkill: null,
    selectedPlugin: null,
    selectedAgent: null,

    setView: (view) => set({ view }),
    setPanel: (p) => set(p),
    select: (p) => set(p),
    clearError: () => set({ error: null }),

    reloadConfig: async () => {
      const c = await skm.config();
      if (c.ok) { set({ config: c.value }); nameExtensionAgents(c.value); }
      else set(failMessage(c.error));
    },

    boot: async () => {
      const config = await skm.config();
      if (!config.ok) return set({ ...failMessage(config.error), booted: true });
      set({ config: config.value, cliMissing: false });
      nameExtensionAgents(config.value);
      // paint from the cache first, then probe every host live in the background
      const status = await skm.status({ cached: true });
      if (status.ok) set({ hosts: status.value });
      await refreshDerived();
      set({ booted: true });
      void get().refreshLive();
      void get().checkHarness({ cached: true }).then(() => get().checkHarness());
    },

    refreshLive: async (only) => {
      const ids = only === undefined ? order() : [only];
      set((s) => ({ probe: { ...s.probe, ...Object.fromEntries(ids.map((h) => [h, "probing" as const])) } }));
      await Promise.all(ids.map(async (h) => {
        const r = await skm.status({ cached: false, host: h });
        if (!r.ok) {
          set((s) => ({ probe: { ...s.probe, [h]: "failed" }, ...(r.error.kind === "not-found" ? { cliMissing: true } : {}) }));
          return;
        }
        const plan = await skm.plan({ host: h });
        set((s) => ({
          hosts: mergeByHost(s.hosts, r.value, order()),
          ...(plan.ok ? { plans: mergeByHost(s.plans, plan.value, order()) } : {}),
          probe: { ...s.probe, [h]: r.value.every((x) => x.reachable) ? "idle" : "failed" },
        }));
      }));
      const plugins = await skm.plugins();
      if (plugins.ok) set({ plugins: plugins.value });
    },

    refreshDerived,

    toggleSkill: async (skill, host, agent, on) => {
      const key = `${skill}|${host}/${agent}`;
      // optimistic: flip the target now, the CLI confirms
      set((s) => ({
        saving: new Set([...s.saving, key]),
        skills: s.skills.map((k) => (k.name === skill ? { ...k, targets: { ...k.targets, [host]: { ...k.targets[host], [agent]: on } } } : k)),
      }));
      const r = await skm.scope(skill, `${host}/${agent}`, on);
      set((s) => ({ saving: new Set([...s.saving].filter((x) => x !== key)), ...(r.ok ? {} : { error: errorText(r.error) }) }));
      await refreshDerived();
    },

    togglePlugin: async (plugin, host, agent, on) => {
      const key = `plugin:${plugin}|${host}/${agent}`;
      set((s) => ({ saving: new Set([...s.saving, key]) }));
      const r = await skm.scope(plugin, `${host}/${agent}`, on, true);
      set((s) => ({ saving: new Set([...s.saving].filter((x) => x !== key)), ...(r.ok ? {} : { error: errorText(r.error) }) }));
      await Promise.all([refreshDerived(), get().reloadConfig()]);
    },

    apply: async (o = {}) => {
      if (get().runs.some((r) => r.status === "running")) return;
      const id = startRun("sync", o.host ?? "*");
      await execute(id, ["sync", "-y", "--events", ...(o.host ? ["--host", o.host] : []), ...(o.replaceConflicts ? ["--replace-conflicts"] : [])]);
    },

    updatePlugins: async (names, o = {}) => {
      if (get().runs.some((r) => r.status === "running")) return;
      const id = startRun("plugin-update", names.length === 0 ? "*" : names.join(", "));
      await execute(id, ["plugin", "update", ...names, "-y", "--events", ...(o.host ? ["--host", o.host] : []), ...(o.agent ? ["--agent", o.agent] : [])]);
    },

    checkHarness: async (o = {}) => {
      if (!o.cached) set({ harnessChecking: true });
      const r = await skm.harness({ cached: o.cached ?? false, ...(o.host !== undefined ? { host: o.host } : {}) });
      set((s) => ({
        harnessChecking: o.cached ? s.harnessChecking : false,
        ...(r.ok ? { harness: s.harness === null || o.host === undefined ? r.value : { ...r.value, hosts: mergeByHost(s.harness.hosts, r.value.hosts, order()) } } : {}),
      }));
    },

    updateHarness: async (o = {}) => {
      if (get().runs.some((r) => r.status === "running")) return;
      const id = startRun("harness", [o.agent, o.host].filter(Boolean).join(" · ") || "*");
      await execute(id, ["harness", "update", "-y", "--events", ...(o.host ? ["--host", o.host] : []), ...(o.agent ? ["--agent", o.agent] : [])]);
      await get().checkHarness({ cached: true });
      // a new desktop app rewrites the plugins it ships: show their new versions
      // (the plugin list reads the inventory cache, so probe the hosts again)
      if (o.agent !== undefined && (get().harness?.apps ?? []).some((a) => a.id === o.agent)) await get().refreshLive(o.host);
    },

    updateBundled: async (names, o) => {
      if (get().runs.some((r) => r.status === "running")) return;
      for (const app of o.apps) await get().updateHarness({ agent: app, ...(o.host !== undefined ? { host: o.host } : {}) });
      await get().updatePlugins(names, { agent: o.agent, ...(o.host !== undefined ? { host: o.host } : {}) });
      const plugins = await skm.plugins();
      if (plugins.ok) set({ plugins: plugins.value });
      void get().checkHarness();
    },
  };
});

// ---------- selectors (pure) ----------

export type PendingSummary = { readonly mutations: number; readonly hosts: readonly string[]; readonly conflicts: number; readonly blocked: number };

export const pendingOf = (plans: readonly HostPlan[]): PendingSummary => {
  const withMut = plans.filter((p) => p.ops.some((o) => o.mutation));
  return {
    mutations: plans.reduce((n, p) => n + p.ops.filter((o) => o.mutation).length, 0),
    hosts: withMut.map((p) => p.host),
    conflicts: plans.reduce((n, p) => n + p.ops.filter((o) => o.op === "conflict").length, 0),
    blocked: plans.reduce((n, p) => n + p.ops.filter((o) => o.op === "blocked").length, 0),
  };
};

export type HostHealth = "ok" | "pending" | "probing" | "stale" | "down";

/** One word per host for the status pill: down beats probing beats stale beats pending. */
export const hostHealth = (h: HostStatus | undefined, plan: HostPlan | undefined, probe: ProbeState | undefined): HostHealth => {
  if (probe === "probing") return "probing";
  if (h === undefined || !h.reachable || probe === "failed") return h?.reachable && h.lastError === undefined && probe !== "failed" ? "ok" : h?.reachable ? "stale" : "down";
  if (h.lastError !== undefined) return "stale";
  return plan?.ops.some((o) => o.mutation) ? "pending" : "ok";
};

/** Hosts in config order and the agents enabled on each (host override ∩ global list). */
export const useGrid = () => {
  const config = useApp((s) => s.config);
  const hosts = config?.hosts ?? [];
  const agents = config?.agents ?? [];
  const details = new Map((config?.hostDetails ?? []).map((d) => [d.id, d]));
  const agentsOf = (h: string): readonly string[] => {
    const own = details.get(h)?.agents;
    return own ? agents.filter((a) => own.includes(a)) : agents;
  };
  return { hosts, agents, agentsOf };
};
