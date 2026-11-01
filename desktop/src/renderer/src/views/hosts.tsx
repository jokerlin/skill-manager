import type { AgentBudget, AgentStatus, HostStatus } from "@shared/types";
import { AppWindow, ArrowUpCircle, Loader2, Play, RefreshCw, Server, TerminalSquare } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { Chip, Empty, SectionTitle, Stat, StatGrid, type Tone, fmtTokens } from "@/components/common";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type HarnessAgentView, harnessApps, harnessView, isBehind } from "@/lib/harness";
import { storageKey } from "@/views/skills";
import { agentKey } from "@/components/matrix";
import { HEALTH_DOT, useHostHealth } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ago, useI18n, useT } from "@/i18n";
import { useApp, useGrid } from "@/store/app";

const layoutStorage = { getItem: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, setItem: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

const BudgetBar = ({ b, className }: { b: AgentBudget | null; className?: string }) => {
  if (b === null || b.budgetTokens === null) return <div className={cn("h-[3px] rounded-full bg-foreground/[0.06]", className)} />;
  const ratio = Math.min(1, b.usedTokens / Math.max(1, b.budgetTokens));
  return (
    <div className={cn("h-[3px] overflow-hidden rounded-full bg-foreground/[0.08]", className)}>
      <div className={cn("h-full origin-left rounded-full", b.overBy > 0 ? "bg-danger" : ratio > 0.8 ? "bg-pending" : "bg-signal")} style={{ transform: `scaleX(${ratio})` }} />
    </div>
  );
};

export const HostsView = () => {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const rows = useHostHealth();
  const grid = useGrid();
  const selected = useApp((s) => s.selectedAgent);
  const select = useApp((s) => s.select);
  const refreshLive = useApp((s) => s.refreshLive);
  const apply = useApp((s) => s.apply);
  const running = useApp((s) => s.runs.some((r) => r.status === "running"));
  const harness = useApp((s) => s.harness);
  const harnessChecking = useApp((s) => s.harnessChecking);
  const checkHarness = useApp((s) => s.checkHarness);
  const updateHarness = useApp((s) => s.updateHarness);
  const views = harnessView(harness, grid.agents);
  const tools = harness?.tools ?? [];
  const toolViews = harnessView(harness, tools.map((x) => x.id));
  const apps = harnessApps(harness).filter((a) => Object.values(a.byHost).some((v) => typeof v === "string"));
  const viewOf = (a: string): HarnessAgentView | undefined => views.find((v) => v.agent === a);
  const layout = useDefaultLayout({ id: "hosts-split", storage: layoutStorage });

  const [selHost, selAgent] = (selected ?? "").split("/");
  const current = rows.find((r) => r.host === selHost);
  const st = current?.status?.agents?.[selAgent ?? ""];
  useEffect(() => {
    if (st !== undefined) return;
    const first = rows.find((r) => r.status?.agents && Object.keys(r.status.agents).length > 0);
    const a = first ? grid.agentsOf(first.host).find((x) => first.status?.agents?.[x]) : undefined;
    if (first && a) select({ selectedAgent: `${first.host}/${a}` });
  }, [st, rows, grid, select]);

  return (
    <ResizablePanelGroup orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      <ResizablePanel id="list" defaultSize="38" minSize="300px">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-4 px-3 pt-1 pb-6">
            <section className="rounded-lg border border-border/80 bg-surface/40 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <TerminalSquare className="size-3.5 text-muted-foreground" />
                <span className="text-[12.5px] font-semibold">{t("harness.title")}</span>
                <span className="flex-1" />
                <Button variant="ghost" size="icon-xs" aria-label={t("harness.check")} title={t("harness.check")} disabled={harnessChecking} onClick={() => void checkHarness()}>
                  <RefreshCw className={cn(harnessChecking && "animate-spin")} />
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="xs" variant={views.some((v) => v.versions.length > 1) ? "default" : "outline"} disabled={running} onClick={() => void updateHarness()}>
                      {running ? <Loader2 className="animate-spin" /> : <ArrowUpCircle />}{t("harness.updateAll")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-xs">{t("harness.updateAllHint")}</TooltipContent>
                </Tooltip>
              </div>
              <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 gap-y-1">
                {[...views, ...toolViews].map((v) => (
                  <div key={v.agent} className="contents">
                    {(() => {
                      const tool = tools.find((x) => x.id === v.agent);
                      return tool === undefined
                        ? <span className="truncate text-[12px]">{t(agentKey(v.agent))}</span>
                        : <span className="flex min-w-0 items-baseline gap-1.5"><span className="truncate text-[12px]">{tool.name}</span><span className="shrink-0 text-[10.5px] text-muted-foreground">{t("harness.fromExtension", { name: tool.extension })}</span></span>;
                    })()}
                    <span className={cn("tabular font-mono text-[11.5px]", v.versions.length > 1 ? "text-danger" : "text-foreground/80")}>{v.newest ?? "–"}</span>
                    <span className={cn("text-[11px]", v.versions.length > 1 ? "text-danger" : "text-muted-foreground")}>{v.versions.length > 1 ? t("harness.versions", { n: v.versions.length }) : v.versions.length === 1 ? t("harness.same") : harnessChecking ? t("harness.checking") : "–"}</span>
                  </div>
                ))}
              </div>
              {apps.map((a) => (
                <div key={a.app.id} className="mt-2 flex items-center gap-2 border-t border-border/60 pt-2">
                  <AppWindow className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px]">{t("harness.desktopApp", { name: a.app.name })}</div>
                    <div className={cn("truncate text-[11px]", a.behind.length > 0 ? "text-danger" : "text-muted-foreground")}>
                      {a.behind.length > 0 && a.latest !== null
                        ? `${t("harness.appBehind", { n: a.behind.length, v: a.latest })} · ${a.behind.join(", ")}`
                        : a.latest !== null ? `${t("harness.appLatest")} · ${a.latest}` : Object.entries(a.byHost).flatMap(([h, v]) => (typeof v === "string" ? [`${h} ${v}`] : [])).join(" · ")}
                    </div>
                  </div>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button size="xs" variant={a.behind.length > 0 ? "default" : "outline"} disabled={running || a.behind.length === 0} onClick={() => void updateHarness({ agent: a.app.id })}>
                        <ArrowUpCircle />{t("harness.updateApp", { name: a.app.name })}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[280px] text-xs">{t("harness.updateAppHint", { name: a.app.name })}</TooltipContent>
                  </Tooltip>
                </div>
              ))}
              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{t("harness.hint")}</p>
            </section>
            {rows.map((r) => (
              <section key={r.host}>
                <div className="group/h flex items-center gap-2 px-2 pb-1">
                  <span className={cn("size-2 rounded-full", HEALTH_DOT[r.health])} />
                  <span className="text-[13px] font-semibold">{r.host}</span>
                  <span className="truncate font-mono text-[10.5px] text-muted-foreground">{r.status?.ssh ?? t("pill.local")}</span>
                  <span className="flex-1" />
                  <span className="text-[11px] text-muted-foreground">{r.health === "probing" ? t("health.probing") : ago(locale, r.status?.probedAt)}</span>
                  <Button variant="ghost" size="icon-xs" aria-label={t("harness.updateHost", { host: r.host })} title={t("harness.updateHost", { host: r.host })} onClick={() => void updateHarness({ host: r.host })} disabled={running || (r.status !== undefined && !r.status.reachable)}>
                    <ArrowUpCircle />
                  </Button>
                  <Button variant="ghost" size="icon-xs" aria-label={t("pill.refreshHost", { host: r.host })} title={t("pill.refreshHost", { host: r.host })} onClick={() => void refreshLive(r.host)} disabled={r.health === "probing"}>
                    <RefreshCw className={cn(r.health === "probing" && "animate-spin")} />
                  </Button>
                </div>
                {r.status && !r.status.reachable ? (
                  <div className="mx-2 rounded-md bg-danger-soft px-2.5 py-2 font-mono text-[11px] text-danger selectable">{r.status.error}</div>
                ) : null}
                {r.pending > 0 ? (
                  <button type="button" disabled={running} onClick={() => void apply({ host: r.host })} className="mx-2 mb-1 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md bg-pending-soft px-2.5 py-1.5 text-left text-[12px] text-pending transition-[scale,opacity] active:scale-[0.98] disabled:opacity-60">
                    <Play className="size-3" />{t("health.pending", { n: r.pending })}<span className="flex-1" />{t("hosts.apply", { host: r.host })}
                  </button>
                ) : null}
                <div className="flex flex-col gap-px">
                  {grid.agentsOf(r.host).map((a) => {
                    const ag = r.status?.agents?.[a];
                    if (!ag) return null;
                    const key = `${r.host}/${a}`;
                    const active = key === selected;
                    return (
                      <button
                        key={a}
                        type="button"
                        onClick={() => select({ selectedAgent: key })}
                        className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md px-2.5 py-1.5 text-left transition-[background-color]", active ? "bg-accent" : "hover:bg-accent/50")}
                      >
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="text-[12.5px]">{t(agentKey(a))}</span>
                          {(() => {
                            const v = viewOf(a);
                            const ver = v?.byHost[r.host];
                            if (ver === undefined) return null;
                            return <span title={v && isBehind(v, r.host) ? t("harness.behind", { v: v.newest ?? "" }) : undefined} className={cn("font-mono text-[10.5px]", ver === null ? "text-muted-foreground/70" : v && isBehind(v, r.host) ? "text-danger" : "text-muted-foreground")}>{ver ?? t("harness.missing")}</span>;
                          })()}
                        </span>
                        <span className="tabular text-[11.5px] text-muted-foreground">
                          {ag.budget?.budgetTokens != null ? `${fmtTokens(ag.budget.usedTokens)} / ${fmtTokens(ag.budget.budgetTokens)}` : fmtTokens(ag.budget?.usedTokens ?? 0)}
                        </span>
                        <span className="text-[11px] text-muted-foreground">{t("hosts.loads", { n: ag.effective.length })}</span>
                        <BudgetBar b={ag.budget} className="w-[72px] self-center" />
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </ScrollArea>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="detail" defaultSize="62" minSize="420px">
        <AnimatePresence mode="wait" initial={false}>
          {current?.status && st && selAgent ? (
            <motion.div key={selected} className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.1 }}>
              <AgentDetail host={current.status} agent={selAgent} st={st} />
            </motion.div>
          ) : (
            <Empty icon={<Server className="size-5" />}>{t("hosts.select")}</Empty>
          )}
        </AnimatePresence>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
};

const findingTone = (k: string): Tone => (k === "version-drift" ? "danger" : k.startsWith("same") || k === "linked-twice" || k === "owned-drift" ? "pending" : "neutral");

const AgentDetail = ({ host, agent, st }: { host: HostStatus; agent: string; st: AgentStatus }) => {
  const t = useT();
  const b = st.budget;
  const findings = (host.findings ?? []).filter((f) => f.text.startsWith(`${host.host}/${agent}:`) || (f.kind === "owned-drift" && f.text.includes(agent)));
  const sources = (["user", "legacy", "builtin", "plugin"] as const).filter((k) => st.counts[k] > 0);
  const harness = useApp((s) => s.harness);
  const cliView = harnessView(harness, [agent])[0];
  const cliVersion = cliView?.byHost[host.host] ?? null;
  const cliBehind = cliView !== undefined && isBehind(cliView, host.host);

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 px-5 pt-1 pb-8">
        <header className="flex flex-col gap-1.5">
          <h2 className="text-[19px] font-semibold tracking-tight">{host.host} <span className="text-muted-foreground">/</span> {t(agentKey(agent))}</h2>
          <div className="font-mono text-[11px] text-muted-foreground selectable">{st.dir}{st.exists ? "" : ` · ${t("hosts.dirAbsent")}`}</div>
          {host.tools ? <div className="text-[11.5px] text-muted-foreground">{t("hosts.tools", { list: Object.keys(host.tools).join(" · ") })}</div> : null}
          {(host.remoteOnly ?? []).length > 0 ? <div className="text-[11.5px] text-info">{t("hosts.remoteOnly", { n: host.remoteOnly?.length ?? 0 })}</div> : null}
        </header>

        <section>
          <StatGrid cols={3}>
            <Stat
              label={t("hosts.budget")}
              value={b === null ? "–" : fmtTokens(b.usedTokens)}
              unit={b?.budgetTokens != null ? `/ ${fmtTokens(b.budgetTokens)} token` : "token"}
              tone={b && b.overBy > 0 ? "danger" : "neutral"}
              sub={b === null ? undefined : b.budgetTokens === null ? t("hosts.budgetNone", { used: b.usedTokens.toLocaleString() }) : b.overBy > 0 ? t("hosts.budgetOver", { used: b.usedTokens.toLocaleString(), budget: b.budgetTokens.toLocaleString(), over: b.overBy.toLocaleString() }) : t("hosts.budgetFits", { used: b.usedTokens.toLocaleString(), budget: b.budgetTokens.toLocaleString() })}
            >
              <BudgetBar b={b} className="mt-1 h-[4px]" />
            </Stat>
            <Stat label={t("hosts.skills")} value={st.effective.length} sub={sources.map((k) => `${t(`hosts.sources.${k}`)} ${st.counts[k]}`).join(" · ")} />
            <Stat label={t("harness.title")} value={cliVersion ?? "–"} tone={cliBehind ? "danger" : "neutral"} sub={cliVersion === null ? t("harness.missing") : cliBehind ? t("harness.behind", { v: cliView?.newest ?? "" }) : undefined} />
          </StatGrid>

          {b?.note ? (
            <details className="group mt-2 text-[11px] text-muted-foreground">
              <summary className="cursor-default list-none hover:text-foreground"><span className="inline-block transition-transform group-open:rotate-90">›</span> {t("hosts.budgetHow")}</summary>
              <p className="mt-1 leading-relaxed selectable">{b.note}</p>
            </details>
          ) : null}
        </section>

        <section>
          <SectionTitle>{t("hosts.skills")} · {st.effective.length}</SectionTitle>
          <div className="overflow-hidden rounded-lg border border-border/80">
            <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_88px_56px] gap-3 border-b border-border/70 bg-surface/70 px-3 py-1.5 text-[11px] text-muted-foreground">
              <span>{t("hosts.col.skill")}</span><span>{t("hosts.col.source")}</span><span>{t("hosts.col.storage")}</span><span className="text-right">{t("hosts.col.tokens")}</span>
            </div>
            {st.effective.map((e) => (
              <div key={e.path} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_88px_56px] items-center gap-3 border-b border-border/40 px-3 py-[5px] text-[12px] last:border-b-0">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{e.name}</span>
                  {!e.promptVisible ? <Chip>{t("hosts.hidden")}</Chip> : null}
                </span>
                <span className={cn("truncate text-[11.5px]", e.source === "plugin" ? "text-info" : e.source === "user" ? "text-signal" : "text-muted-foreground")}>
                  {e.source === "plugin" ? `${e.plugin}@${e.marketplace}` : e.source === "legacy" ? `${t("hosts.sources.legacy")} ${e.dir ?? ""}` : t(`hosts.sources.${e.source}`)}
                  {e.version ? <span className="ml-1 font-mono text-[10px] text-muted-foreground">{e.version}</span> : null}
                </span>
                <span className="truncate text-[11.5px] text-muted-foreground" title={e.storage}>{t(storageKey(e.storage).key)}</span>
                <span className="tabular text-right text-[11.5px] text-muted-foreground">{e.listingTokens}</span>
              </div>
            ))}
          </div>
        </section>

        {st.plugins.filter((p) => p.enabled === "on").length > 0 ? (
          <section>
            <SectionTitle>{t("hosts.plugins")}</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              {st.plugins.filter((p) => p.enabled === "on").map((p) => (
                <Chip key={p.id} tone="info" className="gap-1.5">{p.name}<span className="font-mono text-[10px] opacity-80">{p.version}</span></Chip>
              ))}
            </div>
          </section>
        ) : null}

        {findings.length > 0 ? (
          <section>
            <SectionTitle>{t("hosts.findings")} · {findings.length}</SectionTitle>
            <ul className="flex flex-col gap-2">
              {findings.map((f, i) => (
                <li key={i} className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 text-[12px]">
                  <span><Chip tone={findingTone(f.kind)}>{f.kind}</Chip></span>
                  <span className="leading-relaxed text-foreground/80 selectable">{f.text.replace(`${host.host}/${agent}: `, "")}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </ScrollArea>
  );
};
