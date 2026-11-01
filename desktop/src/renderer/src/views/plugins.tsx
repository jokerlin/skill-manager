import type { PluginCell, PluginRow } from "@shared/types";
import { AppWindow, Boxes, Loader2, RefreshCcwDot } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { Chip, Empty, SearchField, SectionTitle, Segmented } from "@/components/common";
import { CoverageCellView, CoverageHeader, type Lens, LensDots, LensMenu } from "@/components/coverage";
import { agentKey } from "@/components/matrix";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type Key, useT } from "@/i18n";
import { type HarnessAppView, appOfMarketplace, harnessApps } from "@/lib/harness";
import { useApp, useGrid } from "@/store/app";
import { newestVersion } from "@core/version";

type Filter = "all" | "drift" | "declared";

/** The newest version when every version is dotted-numeric; null for commit hashes and mixed schemes. Shared with the TUI. */
export const newestOf = newestVersion;

/** Whether `skm plugin update` can move this plugin: at least one enabled cell comes from a Git/URL marketplace. */
export const updatable = (p: PluginRow): boolean => p.cells.some((c) => c.enabled === "on" && c.source === "portable");

/** Marketplaces another app writes into a local dir (no Git/URL source): skm cannot move these versions. */
export const bundledMarketplaces = (p: PluginRow): readonly string[] =>
  updatable(p) ? [] : [...new Set(p.cells.filter((c) => c.enabled !== null && c.source === "local-dir" && c.marketplace !== null).map((c) => c.marketplace ?? ""))];

const APP_KEYS: Readonly<Record<string, Key>> = { "openai-bundled": "plugins.app.openai-bundled", "openai-primary-runtime": "plugins.app.openai-primary-runtime" };
export const appKeyOf = (marketplace: string): Key => APP_KEYS[marketplace] ?? "plugins.app.unknown";

/** What "Update" does for app-shipped plugins: which apps to update first (only those behind somewhere) and which agent reinstalls them. Pure. */
export const bundledPlan = (rows: readonly PluginRow[], apps: readonly HarnessAppView[]): { readonly names: readonly string[]; readonly apps: readonly string[]; readonly agent: string } => {
  const mks = [...new Set(rows.flatMap(bundledMarketplaces))];
  const owners = [...new Set(mks.flatMap((m) => { const a = appOfMarketplace(apps, m); return a !== undefined && a.behind.length > 0 ? [a.app.id] : []; }))];
  const agent = rows.flatMap((r) => r.cells.filter((c) => c.source === "local-dir").map((c) => c.agent))[0] ?? "codex";
  return { names: rows.map((r) => r.name), apps: owners, agent };
};

/** One line on the state of the app that writes a marketplace. */
const AppLine = ({ mk, apps }: { mk: string; apps: readonly HarnessAppView[] }) => {
  const t = useT();
  const a = appOfMarketplace(apps, mk);
  const app = t(appKeyOf(mk));
  if (a === undefined) return null;
  const installed = Object.values(a.byHost).some((v) => typeof v === "string");
  const text = !installed ? t("plugins.appNone", { app }) : a.latest === null ? t("plugins.appUnknown", { app }) : a.behind.length > 0 ? t("plugins.appBehind", { app, hosts: a.behind.join(", "), v: a.latest }) : t("plugins.appCurrent", { app, v: a.latest });
  return <span className={cn("text-[11.5px]", a.behind.length > 0 ? "text-danger" : "text-muted-foreground")}>{text}</span>;
};

/** Hosts whose enabled copy is older than the newest version (dotted-numeric versions only). */
export const behindHosts = (p: PluginRow): { readonly newest: string | null; readonly behind: readonly string[]; readonly ahead: readonly string[] } => {
  const newest = newestOf(p.versions);
  if (newest === null) return { newest, behind: [], ahead: [] };
  const on = p.cells.filter((c) => c.enabled === "on" && c.version !== null);
  return {
    newest,
    behind: [...new Set(on.filter((c) => c.version !== newest).map((c) => c.host))],
    ahead: [...new Set(on.filter((c) => c.version === newest).map((c) => c.host))],
  };
};

type PluginDot = "current" | "outdated" | "drift" | "disabled" | "will-install" | "will-disable" | "none";

const pluginDot = (p: PluginRow, c: PluginCell, newest: string | null): PluginDot => {
  if (c.enabled === null) return c.wanted ? "will-install" : "none";
  if (c.enabled === "off") return c.wanted ? "will-install" : "disabled";
  if (c.wanted === false) return "will-disable";
  if (!p.drift || c.version === null) return "current";
  if (newest === null) return "drift";
  return c.version === newest ? "current" : "outdated";
};

const DOT_CLASS: Readonly<Record<PluginDot, string>> = {
  current: "bg-signal",
  outdated: "bg-danger",
  drift: "bg-danger",
  disabled: "bg-foreground/[0.14]",
  "will-install": "bg-pending-soft ring-1 ring-inset ring-pending",
  "will-disable": "bg-pending",
  none: "bg-foreground/[0.05]",
};

const BAR_CLASS: Readonly<Record<PluginDot, string>> = { ...DOT_CLASS, "will-install": "bg-pending/55", none: "bg-foreground/[0.04]" };
const BAR_ORDER: readonly PluginDot[] = ["current", "outdated", "drift", "will-install", "will-disable", "disabled", "none"];

const DOT_TEXT: Readonly<Record<PluginDot, Key>> = {
  current: "cell.loaded",
  outdated: "plugins.drift",
  drift: "plugins.drift",
  disabled: "plugins.disabled",
  "will-install": "plugins.willEnable",
  "will-disable": "plugins.willDisable",
  none: "plugins.notInstalled",
};

const layoutStorage = { getItem: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, setItem: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

export const PluginsView = () => {
  const t = useT();
  const report = useApp((s) => s.plugins);
  const selected = useApp((s) => s.selectedPlugin);
  const select = useApp((s) => s.select);
  const updatePlugins = useApp((s) => s.updatePlugins);
  const running = useApp((s) => s.runs.some((r) => r.status === "running"));
  const apps = harnessApps(useApp((s) => s.harness));
  const grid = useGrid();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [lens, setLens] = useState<Lens>("all");
  useEffect(() => { if (lens !== "all" && !grid.hosts.includes(lens)) setLens("all"); }, [lens, grid.hosts]);
  const layout = useDefaultLayout({ id: "plugins-split", storage: layoutStorage });

  const rows = report?.plugins ?? [];
  const pluginAgents = (h: string) => grid.agentsOf(h).filter((a) => a === "claude" || a === "codex");
  const drifting = rows.filter((p) => p.drift && updatable(p));
  const bundled = rows.filter((p) => p.drift && bundledMarketplaces(p).length > 0);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((p) => filter === "all" || (filter === "drift" ? p.drift : p.policy !== null))
      .filter((p) => needle === "" || p.name.toLowerCase().includes(needle) || p.ids.some((id) => id.toLowerCase().includes(needle)));
  }, [rows, filter, q]);
  const groups = [
    { key: "plugins.declared" as const, items: visible.filter((p) => p.policy !== null) },
    { key: "plugins.discovered" as const, items: visible.filter((p) => p.policy === null) },
  ].filter((g) => g.items.length > 0);
  const current = rows.find((p) => p.name === selected) ?? null;
  useEffect(() => { if (current === null && visible[0]) select({ selectedPlugin: visible[0].name }); }, [current, visible, select]);

  return (
    <ResizablePanelGroup orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      <ResizablePanel id="list" defaultSize="58" minSize="420px">
        <div className="flex h-full flex-col">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-4 pt-1 pb-2.5">
            <SearchField value={q} onChange={setQ} placeholder={t("plugins.searchPlaceholder")} className="w-[180px] min-w-[140px] shrink" />
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: t("common.all"), count: rows.length },
                { value: "drift", label: t("plugins.drift"), count: rows.filter((p) => p.drift).length },
                { value: "declared", label: t("plugins.filterDeclared"), count: rows.filter((p) => p.policy !== null).length },
              ]}
            />
            <div className="flex-1" />
            <LensMenu value={lens} onChange={setLens} hosts={grid.hosts} />
            {bundled.length > 0 ? <BundledPopover rows={bundled} apps={apps} onPick={(name) => select({ selectedPlugin: name })} /> : null}
            {drifting.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" className="no-drag" disabled={running} onClick={() => void updatePlugins(drifting.map((p) => p.name))}>
                    {running ? <Loader2 className="animate-spin" /> : <RefreshCcwDot />}
                    {t("plugins.updateDrifting", { n: drifting.length })}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px] text-xs">{drifting.map((p) => p.name).join(", ")}<br />{t("plugins.updateHint")}</TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 border-y border-border/70 bg-surface/60 px-4 py-1.5 text-[11px] text-muted-foreground">
            <span>{t("nav.plugins")} <span className="tabular opacity-70">· {visible.length}</span></span>
            <CoverageHeader lens={lens} agents={lens === "all" ? [] : pluginAgents(lens)} />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {visible.length === 0 ? <div className="p-8 text-center text-[12.5px] text-muted-foreground">{t("plugins.empty", { q })}</div> : null}
            {groups.map((g) => (
              <div key={g.key}>
                <div className="sticky top-0 z-10 bg-background/95 px-4 pt-3 pb-1 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase backdrop-blur-[2px]">{t(g.key)}</div>
                {g.items.map((p) => {
                  const newest = newestOf(p.versions);
                  const active = p.name === selected;
                  return (
                    <div
                      key={p.name}
                      onClick={() => select({ selectedPlugin: p.name })}
                      className={cn("grid cursor-default grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/50 px-4 py-[7px]", active ? "bg-accent" : "hover:bg-accent/50")}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium">{p.name}</span>
                          {p.drift ? <Chip tone="danger">{t("plugins.drift")}</Chip> : null}
                          {p.drift && bundledMarketplaces(p).length > 0 ? <Chip><AppWindow className="size-3" />{t("plugins.bundled")}</Chip> : null}
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
                          <span className={cn("tabular truncate font-mono text-[10.5px]", p.drift && "text-danger")}>{p.versions.join(" · ") || "–"}</span>
                        </div>
                      </div>
                      <PluginCoverage p={p} newest={newest} hosts={grid.hosts} agentsOf={pluginAgents} lens={lens} />
                    </div>
                  );
                })}
              </div>
            ))}
          </ScrollArea>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/70 px-4 py-2 text-[11px] text-muted-foreground">
            {(["current", "outdated", "disabled", "will-install", "will-disable"] as const).map((d) => (
              <span key={d} className="inline-flex items-center gap-1.5"><span className={cn("inline-block size-[9px] rounded-[2.5px]", DOT_CLASS[d])} />{d === "current" ? t("plugins.enabled") : t(DOT_TEXT[d])}</span>
            ))}
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="detail" defaultSize="42" minSize="360px">
        <AnimatePresence mode="wait" initial={false}>
          {current ? (
            <motion.div key={current.name} className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.1 }}>
              <PluginDetail p={current} />
            </motion.div>
          ) : (
            <Empty icon={<Boxes className="size-5" />}>{t("plugins.select")}</Empty>
          )}
        </AnimatePresence>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
};

/** Coverage column for a plugin row: where it is enabled, with the count of cells behind the newest version. */
const PluginCoverage = ({ p, newest, hosts, agentsOf, lens }: { p: PluginRow; newest: string | null; hosts: readonly string[]; agentsOf: (h: string) => readonly string[]; lens: Lens }) => {
  const t = useT();
  const dotOf = (h: string, a: string): PluginDot => { const c = p.cells.find((x) => x.host === h && x.agent === a); return c ? pluginDot(p, c, newest) : "none"; };
  if (lens !== "all") {
    return <LensDots agents={agentsOf(lens)} dot={(a) => DOT_CLASS[dotOf(lens, a)]} label={(a) => `${t(agentKey(a))} · ${p.cells.find((x) => x.host === lens && x.agent === a)?.version ?? t(DOT_TEXT[dotOf(lens, a)])}`} />;
  }
  const all = hosts.flatMap((h) => agentsOf(h).map((a) => ({ host: h, agent: a, d: dotOf(h, a) })));
  const on = (d: PluginDot) => d === "current" || d === "outdated" || d === "drift" || d === "will-install";
  const outdated = all.filter((c) => c.d === "outdated").length;
  const unordered = all.filter((c) => c.d === "drift").length;
  const pending = all.filter((c) => c.d === "will-install" || c.d === "will-disable").length;
  const extra = outdated > 0 ? t("plugins.status.outdated", { n: outdated }) : unordered > 0 ? t("plugins.status.drift", { n: p.versions.length }) : pending > 0 ? `+${pending}` : undefined;
  return (
    <CoverageCellView
      cells={all.map((c) => ({ host: c.host, agent: c.agent, on: on(c.d) }))}
      segments={BAR_ORDER.map((k) => ({ key: k, count: all.filter((c) => c.d === k).length, className: BAR_CLASS[k] }))}
      hosts={hosts}
      agentsOf={agentsOf}
      dot={(h, a) => DOT_CLASS[dotOf(h, a)]}
      {...(extra !== undefined ? { extra, tone: outdated > 0 || unordered > 0 ? "danger" as const : "pending" as const } : {})}
    />
  );
};

/** Toolbar entry for app-shipped plugins that drift: which app writes them, where it lags, and one button to bring them level. */
const BundledPopover = ({ rows, apps, onPick }: { rows: readonly PluginRow[]; apps: readonly HarnessAppView[]; onPick: (name: string) => void }) => {
  const t = useT();
  const updateBundled = useApp((s) => s.updateBundled);
  const running = useApp((s) => s.runs.some((r) => r.status === "running"));
  const plan = bundledPlan(rows, apps);
  const byApp = [...new Set(rows.flatMap(bundledMarketplaces))].map((mk) => ({ mk, rows: rows.filter((r) => bundledMarketplaces(r).includes(mk)) }));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="no-drag"><AppWindow />{t("plugins.bundledCount", { n: rows.length })}</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[400px] p-0">
        <div className="border-b border-border/70 px-3.5 py-2.5">
          <div className="flex items-center gap-2">
            <div className="flex-1 text-[12.5px] font-semibold">{t("plugins.behindTitle", { n: rows.length })}</div>
            <Button size="xs" disabled={running} onClick={() => void updateBundled(plan.names, { apps: plan.apps, agent: plan.agent })}>
              {running ? <Loader2 className="animate-spin" /> : <RefreshCcwDot />}{t("plugins.updateBundledAll")}
            </Button>
          </div>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{t("plugins.bundledHint", { app: [...new Set(byApp.map((g) => t(appKeyOf(g.mk))))].join(", ") })}</p>
        </div>
        <div className="max-h-[320px] overflow-y-auto py-1">
          {byApp.map((g) => (
            <div key={g.mk} className="px-1.5 pb-1">
              <div className="flex flex-col px-2 pt-1.5 pb-1">
                <span className="text-[11px] font-medium text-muted-foreground">{t("plugins.bundledBy", { app: t(appKeyOf(g.mk)) })} <span className="font-mono opacity-70">· {g.mk}</span></span>
                <AppLine mk={g.mk} apps={apps} />
              </div>
              {g.rows.map((r) => {
                const b = behindHosts(r);
                return (
                  <button key={r.name} type="button" onClick={() => onPick(r.name)} className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left transition-[background-color,scale] hover:bg-accent active:scale-[0.99]">
                    <span className="w-[130px] shrink-0 truncate text-[12.5px] font-medium">{r.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-danger">{b.behind.length > 0 ? t("plugins.behind", { hosts: b.behind.join(", ") }) : r.versions.join(" · ")}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};

const PluginDetail = ({ p }: { p: PluginRow }) => {
  const t = useT();
  const grid = useGrid();
  const saving = useApp((s) => s.saving);
  const togglePlugin = useApp((s) => s.togglePlugin);
  const updatePlugins = useApp((s) => s.updatePlugins);
  const updateBundled = useApp((s) => s.updateBundled);
  const running = useApp((s) => s.runs.some((r) => r.status === "running"));
  const apps = harnessApps(useApp((s) => s.harness));
  const newest = newestOf(p.versions);
  const canUpdate = updatable(p);
  const bundledBy = bundledMarketplaces(p);
  const lag = behindHosts(p);
  const cells = grid.hosts.flatMap((h) => grid.agentsOf(h).filter((a) => a === "claude" || a === "codex").map((a) => ({ h, a, c: p.cells.find((x) => x.host === h && x.agent === a) })));

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 px-5 pt-1 pb-8">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-[19px] font-semibold tracking-tight selectable">{p.name}</h2>
            {p.drift ? <Chip tone="danger">{t("plugins.drift")}</Chip> : p.versions.length > 0 ? <Chip tone="signal">{t("plugins.inSync")}</Chip> : null}
          </div>
          <div className="flex flex-wrap gap-1.5">{p.ids.map((id) => <Chip key={id} mono>{id}</Chip>)}</div>
        </header>

        <section>
          <SectionTitle
            hint={canUpdate ? t("plugins.updateHint") : bundledBy.length === 0 && p.cells.some((c) => c.source === "local-dir") ? t("plugins.localMarketplace") : undefined}
            trailing={canUpdate ? (
              <Button size="sm" variant={p.drift ? "default" : "outline"} disabled={running} onClick={() => void updatePlugins([p.name])}>
                {running ? <Loader2 className="animate-spin" /> : <RefreshCcwDot />}{t("plugins.updateAll")}
              </Button>
            ) : bundledBy.length > 0 ? (
              <Button size="sm" variant={p.drift ? "default" : "outline"} disabled={running} onClick={() => { const plan = bundledPlan([p], apps); void updateBundled(plan.names, { apps: plan.apps, agent: plan.agent }); }}>
                {running ? <Loader2 className="animate-spin" /> : <RefreshCcwDot />}{t("plugins.updateBundled")}
              </Button>
            ) : undefined}
          >
            {t("plugins.versions")}
          </SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {p.versions.map((v) => (
              <Chip key={v} mono tone={!p.drift ? "signal" : newest === null ? "danger" : v === newest ? "signal" : "danger"}>
                {v}{v === newest && p.drift ? ` · ${t("plugins.newest")}` : ""}
              </Chip>
            ))}
            {p.versions.length === 0 ? <span className="text-[12px] text-muted-foreground">–</span> : null}
          </div>
          {bundledBy.length > 0 ? (
            <div className="mt-3 rounded-lg bg-foreground/[0.035] px-3.5 py-3 text-[12px] leading-relaxed">
              <div className="flex items-center gap-1.5 font-medium"><AppWindow className="size-3.5 text-muted-foreground" />{t("plugins.bundledBy", { app: bundledBy.map((m) => t(appKeyOf(m))).join(", ") })}</div>
              {p.drift && lag.newest !== null ? (
                <div className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11.5px]">
                  <span className="text-signal">{t("plugins.newestLabel", { v: lag.newest })}</span><span>{lag.ahead.join(", ")}</span>
                  <span className="text-danger">{t("plugins.behindLabel")}</span><span>{lag.behind.join(", ")}</span>
                </div>
              ) : null}
              <div className="mt-1.5 flex flex-col">{bundledBy.map((m) => <AppLine key={m} mk={m} apps={apps} />)}</div>
              <p className="mt-1.5 text-[11.5px] text-muted-foreground">{t("plugins.bundledHint", { app: [...new Set(bundledBy.map((m) => t(appKeyOf(m))))].join(", ") })}</p>
            </div>
          ) : null}
        </section>

        <section>
          <SectionTitle hint={t("plugins.cellsHint")}>{t("plugins.cells")}</SectionTitle>
          <div className="overflow-hidden rounded-lg border border-border/80">
            {cells.map(({ h, a, c }) => {
              const on = c?.wanted ?? c?.enabled === "on";
              const id = p.ids.find((x) => c?.marketplace && x.endsWith(`@${c.marketplace}`)) ?? p.ids[0] ?? p.name;
              const busy = saving.has(`plugin:${p.policy ? p.name : id}|${h}/${a}`);
              const outdated = p.drift && newest !== null && c?.version !== null && c?.version !== undefined && c.version !== newest;
              return (
                <div key={`${h}/${a}`} className="grid grid-cols-[110px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border/50 px-3 py-2 last:border-b-0">
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-medium">{h}</div>
                    <div className="text-[11px] text-muted-foreground">{t(agentKey(a))}</div>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    {c?.version ? <Chip mono tone={outdated || (p.drift && newest === null && c.enabled === "on") ? "danger" : c.enabled === "off" ? "neutral" : "signal"}>{c.version}</Chip> : null}
                    {c?.enabled === "off" ? <Chip>{t("plugins.disabled")}</Chip> : c?.enabled == null ? <span className="text-[11.5px] text-muted-foreground">{t("plugins.notInstalled")}</span> : null}
                    {c && c.scopes.length > 0 && !(c.scopes.length === 1 && c.scopes[0] === "user") ? <Chip tone="info">{t("plugins.scope", { list: c.scopes.join(", ") })}</Chip> : null}
                    {c && c.skills.length > 0 ? <span className="text-[11px] text-muted-foreground">{t("plugins.skills", { n: c.skills.length })}</span> : null}
                    {c?.source === "local-dir" && bundledBy.length === 0 ? <span className="text-[11px] text-muted-foreground">{t("plugins.localMarketplace")}</span> : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {outdated && c?.source === "portable" ? (
                      <Button size="xs" variant="ghost" disabled={running} onClick={() => void updatePlugins([p.name], { host: h, agent: a })}>{t("plugins.updateHost", { host: h })}</Button>
                    ) : null}
                    {busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
                    <Switch
                      size="sm"
                      checked={on}
                      aria-label={`${p.name} ${h}/${a}`}
                      onCheckedChange={(v) => void togglePlugin(p.policy ? p.name : id, h, a, v)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </ScrollArea>
  );
};
