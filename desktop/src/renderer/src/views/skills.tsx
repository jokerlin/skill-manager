import type { HostStatus, UpstreamState } from "@shared/types";
import { ArrowUpDown, Check, GitBranch, Layers, Loader2, RefreshCcwDot } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { Chip, Empty, SearchField, SectionTitle, Segmented, Stat, StatGrid, type Tone, fmtBytes, fmtTokens } from "@/components/common";
import { CoverageBar, CoverageCellView, CoverageHeader, type Lens, LensDots, LensMenu } from "@/components/coverage";
import { CELL_SHORT, CELL_TEXT, Dot, MatrixLegend, agentKey } from "@/components/matrix";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { CoverageCell, Segment } from "@/lib/coverage";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BODY_WARN_TOKENS, type CatalogItem, type CellState, type GroupKind, LISTING_CAP_CHARS, buildCatalog, cellState, groupRank, groupText, loadCount } from "@/lib/catalog";
import { cn } from "@/lib/utils";
import { type Key, useT } from "@/i18n";
import { type UpstreamOf, updatable, upstreamIndex, useApp, useGrid } from "@/store/app";

type Filter = "all" | GroupKind | "updates";
type Sort = "source" | "name" | "listing" | "body" | "loads";

const FILTERS: readonly { readonly value: Filter; readonly key: Key }[] = [
  { value: "all", key: "skills.filter.all" },
  { value: "store", key: "skills.filter.store" },
  { value: "plugin", key: "skills.filter.plugin" },
  { value: "builtin", key: "skills.filter.builtin" },
  { value: "unmanaged", key: "skills.filter.unmanaged" },
  { value: "updates", key: "skills.filter.updates" },
];

/** Row chip per upstream state; current has none. */
const UPSTREAM_CHIP: Readonly<Record<Exclude<UpstreamState, "current">, { readonly key: Key; readonly tone: Tone }>> = {
  behind: { key: "upstream.chip.behind", tone: "info" },
  absent: { key: "upstream.chip.absent", tone: "info" },
  modified: { key: "upstream.chip.modified", tone: "pending" },
  unbased: { key: "upstream.chip.unbased", tone: "pending" },
  gone: { key: "upstream.chip.gone", tone: "danger" },
};

const SORTS: readonly { readonly value: Sort; readonly key: Key }[] = [
  { value: "source", key: "skills.sort.source" },
  { value: "name", key: "skills.sort.name" },
  { value: "listing", key: "skills.sort.listing" },
  { value: "body", key: "skills.sort.body" },
  { value: "loads", key: "skills.sort.loads" },
];

const comparator = (s: Sort) => (a: CatalogItem, b: CatalogItem): number => {
  const byName = a.name.localeCompare(b.name);
  switch (s) {
    case "name":
      return byName;
    case "source":
      return groupRank(a.group) - groupRank(b.group) || groupText(a.group).localeCompare(groupText(b.group)) || byName;
    case "listing":
      return b.listingTokens - a.listingTokens || byName;
    case "body":
      return b.bodyTokens - a.bodyTokens || byName;
    case "loads":
      return loadCount(b) - loadCount(a) || byName;
  }
};

const sourceTone = (k: GroupKind): Tone => {
  switch (k) {
    case "store":
      return "signal";
    case "plugin":
      return "info";
    case "unmanaged":
      return "pending";
    case "builtin":
      return "neutral";
  }
};

/** Bar colours per cell state; the same palette as the detail grid dots. */
const CELL_BAR: Readonly<Record<CellState, string>> = {
  loaded: "bg-signal",
  "pending-add": "bg-pending/55",
  "pending-remove": "bg-pending",
  off: "bg-foreground/[0.09]",
  unknown: "bg-foreground/[0.04]",
  absent: "bg-transparent",
};
const CELL_DOT: Readonly<Record<CellState, string>> = {
  loaded: "bg-signal",
  "pending-add": "bg-pending-soft ring-1 ring-inset ring-pending",
  "pending-remove": "bg-pending",
  off: "bg-foreground/[0.09]",
  unknown: "border border-dashed border-muted-foreground/50",
  absent: "bg-transparent",
};
const BAR_ORDER: readonly CellState[] = ["loaded", "pending-add", "pending-remove", "unknown", "off"];

type Grid = { readonly hosts: readonly string[]; readonly agentsOf: (h: string) => readonly string[] };

/** Every (host, agent) cell of one skill with its state; `absent` cells (agent not on that host) are left out. */
const cellsOf = (item: CatalogItem, grid: Grid, statusOf: (h: string) => HostStatus | undefined) =>
  grid.hosts.flatMap((h) => grid.agentsOf(h).map((a) => ({ host: h, agent: a, state: cellState(item, statusOf(h), a) })));

/** Text for a storage label from `skm status` ("link→store", "real dir", "link→/x"). */
export const storageKey = (s: string): { readonly key: Key; readonly target: string | null; readonly tone: Tone } => {
  if (s === "link→store") return { key: "storage.store-link", target: null, tone: "signal" };
  if (s.startsWith("link→") && s.endsWith("→store")) return { key: "storage.store-chain", target: null, tone: "signal" };
  if (s === "real dir") return { key: "storage.real-dir", target: null, tone: "pending" };
  if (s === "plugin cache") return { key: "storage.plugin-cache", target: null, tone: "info" };
  if (s === "builtin") return { key: "storage.builtin", target: null, tone: "neutral" };
  if (s.startsWith("link→")) return { key: "storage.link-elsewhere", target: s.slice("link→".length), tone: "pending" };
  return { key: "storage.real-dir", target: null, tone: "neutral" };
};

/** Display text for a skill's source: translated for store / builtin / manual, the plugin id or owning CLI otherwise. */
export const groupLabel = (g: CatalogItem["group"], t: (k: Key) => string): string => {
  switch (g.kind) {
    case "store":
      return t("detail.store");
    case "plugin":
      return groupText(g);
    case "builtin":
      return t("group.builtin");
    case "unmanaged":
      return g.owner === "manual" ? t("group.manual") : g.owner;
  }
};

const layoutStorage = { getItem: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, setItem: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

export const SkillsView = () => {
  const t = useT();
  const skills = useApp((s) => s.skills);
  const hostsStatus = useApp((s) => s.hosts);
  const selected = useApp((s) => s.selectedSkill);
  const select = useApp((s) => s.select);
  const upstreams = useApp((s) => s.upstreams);
  const upstreamBusy = useApp((s) => s.upstreamBusy);
  const updateUpstream = useApp((s) => s.updateUpstream);
  const grid = useGrid();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("source");
  const [lens, setLens] = useState<Lens>("all");
  useEffect(() => { if (lens !== "all" && !grid.hosts.includes(lens)) setLens("all"); }, [lens, grid.hosts]);
  const layout = useDefaultLayout({ id: "skills-split", storage: layoutStorage });

  const catalog = useMemo(() => buildCatalog(skills, hostsStatus), [skills, hostsStatus]);
  const upIndex = useMemo(() => upstreamIndex(upstreams), [upstreams]);
  const upOf = (i: CatalogItem): UpstreamOf | undefined => (i.group.kind === "store" ? upIndex.get(i.name) : undefined);
  const hasUpdate = (i: CatalogItem): boolean => { const u = upOf(i); return u !== undefined && updatable(u.skill); };
  const matches = (i: CatalogItem, f: Filter): boolean => (f === "all" ? true : f === "updates" ? hasUpdate(i) : i.group.kind === f);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.value, catalog.filter((i) => matches(i, f.value)).length])) as Record<Filter, number>, [catalog, upIndex]);
  // skills in the store-less "absent" state have no catalog row, so the batch button reads the report itself
  const pendingUpdates = useMemo(() => [...upIndex.values()].filter((u) => updatable(u.skill)).map((u) => u.skill.skill), [upIndex]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return catalog
      .filter((i) => matches(i, filter))
      .filter((i) => needle === "" || i.name.toLowerCase().includes(needle) || i.description.toLowerCase().includes(needle) || groupText(i.group).toLowerCase().includes(needle))
      .sort(comparator(sort));
  }, [catalog, filter, q, sort, upIndex]);
  useEffect(() => { if (filter === "updates" && counts.updates === 0) setFilter("all"); }, [filter, counts.updates]);

  const current = catalog.find((i) => i.id === selected) ?? null;
  useEffect(() => { if (current === null && visible[0]) select({ selectedSkill: visible[0].id }); }, [current, visible, select]);

  const statusOf = (h: string): HostStatus | undefined => hostsStatus.find((x) => x.host === h);
  const listRef = useRef<HTMLDivElement>(null);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = visible.findIndex((x) => x.id === selected);
    const next = visible[Math.max(0, Math.min(visible.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      select({ selectedSkill: next.id });
      listRef.current?.querySelector(`[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  };

  return (
    <ResizablePanelGroup orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged}>
      <ResizablePanel id="list" defaultSize="62" minSize="420px">
        <div className="flex h-full flex-col">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-4 pt-1 pb-2.5">
            <SearchField value={q} onChange={setQ} placeholder={t("skills.searchPlaceholder")} className="w-[200px] min-w-[150px] shrink" />
            <Segmented value={filter} onChange={setFilter} options={FILTERS.filter((f) => f.value === "all" || counts[f.value] > 0).map((f) => ({ value: f.value, label: t(f.key), count: counts[f.value] }))} />
            <div className="flex-1" />
            <LensMenu value={lens} onChange={setLens} hosts={grid.hosts} />
            {pendingUpdates.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" className="no-drag" disabled={pendingUpdates.some((s) => upstreamBusy.has(s))} onClick={() => void updateUpstream(pendingUpdates)}>
                    {pendingUpdates.some((s) => upstreamBusy.has(s)) ? <Loader2 className="animate-spin" /> : <RefreshCcwDot />}
                    {t("upstream.updateN", { n: pendingUpdates.length })}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px] text-xs">{pendingUpdates.join(", ")}<br />{t("upstream.updateHint")}</TooltipContent>
              </Tooltip>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="no-drag text-muted-foreground"><ArrowUpDown />{t(SORTS.find((s) => s.value === sort)?.key ?? "skills.sort")}</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup value={sort} onValueChange={(v) => setSort(v as Sort)}>
                  {SORTS.map((s) => <DropdownMenuRadioItem key={s.value} value={s.value}>{t(s.key)}</DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_56px_56px_auto] items-end gap-3 border-y border-border/70 bg-surface/60 px-4 py-1.5 text-[11px] text-muted-foreground">
            <span>{t("skills.col.name")} <span className="tabular opacity-70">· {t("skills.count", { shown: visible.length, total: catalog.length })}</span></span>
            <span className="text-right">{t("skills.col.listing")}</span>
            <span className="text-right">{t("skills.col.body")}</span>
            <CoverageHeader lens={lens} agents={lens === "all" ? [] : grid.agentsOf(lens)} />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div ref={listRef} role="listbox" tabIndex={0} onKeyDown={onKey} className="outline-none" aria-label={t("skills.title")}>
              {visible.length === 0 ? <div className="p-8 text-center text-[12.5px] text-muted-foreground">{t("skills.empty", { q })}</div> : null}
              {visible.map((i) => {
                const active = i.id === selected;
                const overCap = i.listingChars > LISTING_CAP_CHARS;
                return (
                  <div
                    key={i.id}
                    data-id={i.id}
                    role="option"
                    aria-selected={active}
                    onClick={() => select({ selectedSkill: i.id })}
                    className={cn(
                      "grid cursor-default grid-cols-[minmax(0,1fr)_56px_56px_auto] items-center gap-3 border-b border-border/50 px-4 py-[7px]",
                      active ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("truncate text-[13px] font-medium", (i.store?.violations.length ?? 0) > 0 && "text-danger")}>{i.name}</span>
                        {i.group.kind !== "store" ? <Chip tone={sourceTone(i.group.kind)} className="shrink truncate">{groupLabel(i.group, t)}</Chip> : null}
                        {i.versions.length > 1 ? <Chip tone="danger">{i.versions.length}×</Chip> : null}
                        {(() => { const u = upOf(i); if (u === undefined || u.skill.state === "current") return null; const c = UPSTREAM_CHIP[u.skill.state]; return <Chip tone={c.tone} className="shrink-0">{t(c.key)}</Chip>; })()}
                      </div>
                      <div className="truncate text-[11.5px] text-muted-foreground">{i.description || t("detail.noDescription")}</div>
                    </div>
                    <span className={cn("tabular text-right text-[12px]", overCap ? "text-pending" : "text-muted-foreground")}>{fmtTokens(i.listingTokens)}</span>
                    <span className={cn("tabular text-right text-[12px]", i.bodyTokens > BODY_WARN_TOKENS ? "text-pending" : "text-muted-foreground")}>{fmtTokens(i.bodyTokens)}</span>
                    <RowCoverage item={i} grid={grid} statusOf={statusOf} lens={lens} />
                  </div>
                );
              })}
            </div>
          </ScrollArea>
          <div className="border-t border-border/70 px-4 py-2">
            <MatrixLegend states={["loaded", "pending-add", "pending-remove", "off", "unknown"]} />
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="detail" defaultSize="38" minSize="340px">
        <AnimatePresence mode="wait" initial={false}>
          {current ? (
            <motion.div key={current.id} className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.1 }}>
              <SkillDetail item={current} upstream={upOf(current)} />
            </motion.div>
          ) : (
            <Empty icon={<Layers className="size-5" />}>{t("skills.select")}</Empty>
          )}
        </AnimatePresence>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
};

/** Coverage column of one row: the summary (bar + phrase), or one host's agents when the lens is on that host. */
const RowCoverage = ({ item, grid, statusOf, lens }: { item: CatalogItem; grid: Grid; statusOf: (h: string) => HostStatus | undefined; lens: Lens }) => {
  const t = useT();
  if (lens !== "all") {
    const st = statusOf(lens);
    return <LensDots agents={grid.agentsOf(lens)} dot={(a) => CELL_DOT[cellState(item, st, a)]} label={(a) => `${t(agentKey(a))} · ${t(CELL_TEXT[cellState(item, st, a)])}`} />;
  }
  const all = cellsOf(item, grid, statusOf);
  const known = all.filter((c) => c.state !== "unknown");
  const cells: CoverageCell[] = known.map((c) => ({ host: c.host, agent: c.agent, on: c.state === "loaded" || c.state === "pending-add" }));
  const segments: Segment[] = BAR_ORDER.map((k) => ({ key: k, count: all.filter((c) => c.state === k).length, className: CELL_BAR[k] }));
  const pending = all.filter((c) => c.state === "pending-add" || c.state === "pending-remove").length;
  return (
    <CoverageCellView
      cells={cells}
      segments={segments}
      hosts={grid.hosts}
      agentsOf={grid.agentsOf}
      dot={(h, a) => CELL_DOT[cellState(item, statusOf(h), a)]}
      {...(pending > 0 ? { extra: `+${pending}`, tone: "pending" as const } : {})}
    />
  );
};

/** Skill description, clamped to 4 lines with a toggle when it is longer. */
const Description = ({ text, empty }: { text: string; empty: string }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  const long = text.length > 280;
  return (
    <>
      <p className={cn("text-[13px] leading-[1.6] text-pretty selectable", text ? "text-foreground/90" : "text-muted-foreground", long && !open && "line-clamp-4")}>{text || empty}</p>
      {long ? <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-[11.5px] text-muted-foreground hover:text-foreground">{t(open ? "detail.less" : "detail.more")}</button> : null}
    </>
  );
};

const SkillDetail = ({ item, upstream }: { item: CatalogItem; upstream: UpstreamOf | undefined }) => {
  const t = useT();
  const grid = useGrid();
  const hostsStatus = useApp((s) => s.hosts);
  const saving = useApp((s) => s.saving);
  const toggleSkill = useApp((s) => s.toggleSkill);
  const setView = useApp((s) => s.setView);
  const select = useApp((s) => s.select);
  const s = item.store;
  const entries = Object.entries(item.loads).flatMap(([h, byAgent]) => Object.entries(byAgent).map(([a, e]) => ({ host: h, agent: a, e })));
  const allCells = cellsOf(item, grid, (h) => hostsStatus.find((x) => x.host === h));
  const loaded = allCells.filter((c) => c.state === "loaded");

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-6 px-5 pt-1 pb-8">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-[19px] font-semibold tracking-tight selectable">{item.name}</h2>
            <Chip tone={sourceTone(item.group.kind)}>{groupLabel(item.group, t)}</Chip>
          </div>
          {s && s.violations.length > 0 ? <p className="text-[12px] text-danger">{t("detail.violations", { list: s.violations.join(", ") })}</p> : null}
        </header>

        <figure className="-mt-2 rounded-lg bg-foreground/[0.035] px-3.5 py-3">
          <figcaption className="mb-1 text-[11px] text-muted-foreground">{t("detail.description")}</figcaption>
          <Description text={item.description} empty={t("detail.noDescription")} />
        </figure>

        <StatGrid cols={s ? 4 : 3}>
          <Stat
            label={t("detail.listing")}
            hint={t("detail.listingHint")}
            value={fmtTokens(item.listingTokens)}
            unit="token"
            tone={item.listingChars > LISTING_CAP_CHARS ? "pending" : "neutral"}
            sub={item.listingChars > LISTING_CAP_CHARS ? t("detail.overCap") : t("detail.chars", { n: item.listingChars.toLocaleString() })}
          />
          <Stat label={t("detail.body")} hint={t("detail.bodyHint")} value={fmtTokens(item.bodyTokens)} unit="token" tone={item.bodyTokens > BODY_WARN_TOKENS ? "pending" : "neutral"} sub={item.bodyTokens > BODY_WARN_TOKENS ? t("detail.bodyLarge") : undefined} />
          <Stat label={t("detail.loads")} hint={t("detail.loadsHint")} value={loaded.length} unit={`/ ${allCells.length}`}>
            <CoverageBar className="mt-0.5 w-full" segments={BAR_ORDER.map((k) => ({ key: k, count: allCells.filter((c) => c.state === k).length, className: CELL_BAR[k] }))} />
          </Stat>
          {s ? <Stat label={t("detail.files")} value={s.files} sub={fmtBytes(s.bytes)} /> : <Stat label={t("detail.version")} value={item.versions[0] ?? "–"} tone={item.versions.length > 1 ? "danger" : "neutral"} sub={item.versions.length > 1 ? item.versions.slice(1).join(" / ") : undefined} />}
        </StatGrid>

        {upstream ? <UpstreamSection up={upstream} /> : null}

        <section>
          <SectionTitle hint={s ? t("detail.targetsHint") : t("detail.loadedByHint")}>{s ? t("detail.targets") : t("detail.loadedBy")}</SectionTitle>
          <div className="overflow-x-auto rounded-lg border border-border/80">
            <div className="grid min-w-max border-b border-border/70 bg-surface/70 text-[11px] text-muted-foreground" style={{ gridTemplateColumns: `96px repeat(${grid.agents.length}, minmax(104px,1fr))` }}>
              <span className="px-3 py-1.5" />
              {grid.agents.map((a) => <span key={a} className="px-2 py-1.5">{t(agentKey(a))}</span>)}
            </div>
            {grid.hosts.map((h) => {
              const st = hostsStatus.find((x) => x.host === h);
              return (
                <div key={h} className="grid min-w-max items-stretch border-b border-border/50 last:border-b-0" style={{ gridTemplateColumns: `96px repeat(${grid.agents.length}, minmax(104px,1fr))` }}>
                  <span className="flex items-center px-3 text-[12.5px] font-medium">{h}</span>
                  {grid.agents.map((a) => {
                    const enabled = grid.agentsOf(h).includes(a);
                    const state = enabled ? cellState(item, st, a) : "absent";
                    const wanted = s?.targets[h]?.[a];
                    const busy = saving.has(`${item.name}|${h}/${a}`);
                    const version = item.loads[h]?.[a]?.version;
                    const body = (
                      <>
                        {busy ? <Loader2 className="size-[11px] animate-spin text-muted-foreground" /> : <Dot state={state} />}
                        <span className={cn("truncate text-[11.5px]", state === "pending-add" || state === "pending-remove" ? "text-pending" : state === "loaded" ? "text-foreground/80" : "text-muted-foreground")}>
                          {!s && version ? version : t(CELL_SHORT[state])}
                        </span>
                      </>
                    );
                    return s && enabled && wanted !== undefined ? (
                      <button
                        key={a}
                        type="button"
                        title={t(wanted ? "cell.toggleOff" : "cell.toggleOn")}
                        onClick={() => void toggleSkill(item.name, h, a, !wanted)}
                        className="flex min-w-0 items-center gap-2 border-l border-border/50 px-2 py-2 text-left transition-[background-color,scale] hover:bg-accent/70 active:scale-[0.97]"
                      >
                        {body}
                        {wanted ? <Check className="ml-auto size-3 shrink-0 text-muted-foreground/70" /> : null}
                      </button>
                    ) : (
                      <span key={a} className="flex min-w-0 items-center gap-2 border-l border-border/50 px-2 py-2">{body}</span>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </section>

        {entries.length > 0 ? (
          <section>
            <SectionTitle>{t("detail.where")}</SectionTitle>
            <div className="overflow-hidden rounded-lg border border-border/80">
              <table className="w-full table-fixed text-[12px]">
                <colgroup><col className="w-[92px]" /><col className="w-[92px]" /><col className="w-[118px]" /><col /></colgroup>
                <thead className="bg-surface/70 text-left text-[11px] text-muted-foreground">
                  <tr className="border-b border-border/70">
                    <th className="px-3 py-1.5 font-normal">{t("detail.col.host")}</th>
                    <th className="px-2 py-1.5 font-normal">{t("detail.col.agent")}</th>
                    <th className="px-2 py-1.5 font-normal">{t("detail.col.storage")}</th>
                    <th className="px-2 py-1.5 font-normal">{t("detail.col.path")}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(({ host, agent, e }) => {
                    const st = storageKey(e.storage);
                    return (
                      <tr key={`${host}/${agent}`} className="border-b border-border/50 last:border-b-0 hover:bg-accent/40">
                        <td className="truncate px-3 py-1.5 font-medium">{host}</td>
                        <td className="truncate px-2 py-1.5 text-muted-foreground">{t(agentKey(agent))}</td>
                        <td className="px-2 py-1.5"><Chip tone={st.tone}>{t(st.key)}</Chip></td>
                        <td className="px-2 py-1.5">
                          <Tooltip delayDuration={500}>
                            <TooltipTrigger asChild>
                              <span className="block truncate font-mono text-[10.5px] text-muted-foreground selectable" dir="rtl"><bdi>{e.path}</bdi></span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-[420px] font-mono text-[10.5px] break-all">{e.path}{st.target ? ` → ${st.target}` : ""}</TooltipContent>
                          </Tooltip>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <p className="text-[12px] text-muted-foreground">{t("skills.notLoaded")}</p>
        )}

        {item.group.kind !== "store" ? (
          <section>
            <SectionTitle>{t("detail.managed")}</SectionTitle>
            <p className="text-[12.5px] leading-relaxed text-foreground/85">
              {item.group.kind === "plugin" ? t("detail.manage.plugin", { plugin: item.group.plugin }) : item.group.kind === "builtin" ? t("detail.manage.builtin") : t("detail.manage.unmanaged", { owner: item.group.owner })}
            </p>
            {item.group.kind === "plugin" ? (
              <Button variant="outline" size="sm" className="mt-2.5" onClick={() => { if (item.group.kind === "plugin") select({ selectedPlugin: item.group.plugin }); setView("plugins"); }}>
                {t("detail.openPlugin")}
              </Button>
            ) : null}
          </section>
        ) : null}
      </div>
    </ScrollArea>
  );
};

/** Where a store skill comes from upstream, its state, the commits since the store version, and the update button. */
const UpstreamSection = ({ up }: { up: UpstreamOf }) => {
  const t = useT();
  const busy = useApp((s) => s.upstreamBusy.has(up.skill.skill));
  const checking = useApp((s) => s.upstreamChecking);
  const updateUpstream = useApp((s) => s.updateUpstream);
  const checkUpstreams = useApp((s) => s.checkUpstreams);
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(false), [up.skill.skill, up.skill.state]);
  const { upstream: u, skill: k } = up;
  const target = u.target?.label ?? "–";
  const base = k.base?.label ?? t("upstream.noRecord");
  const forced = k.state === "modified" || k.state === "unbased";
  const action = updatable(k) || forced ? (
    <Button
      size="sm"
      variant={forced ? "outline" : "default"}
      disabled={busy}
      className={cn(forced && armed && "border-danger text-danger")}
      onClick={() => {
        if (forced && !armed) return setArmed(true);
        void updateUpstream([k.skill], { force: forced });
      }}
    >
      {busy ? <Loader2 className="animate-spin" /> : <RefreshCcwDot />}
      {forced ? (armed ? t("upstream.confirmOverwrite") : t("upstream.overwrite", { target })) : t("upstream.update", { target })}
    </Button>
  ) : (
    <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={checking} onClick={() => void checkUpstreams({ report: true })}>
      {checking ? <Loader2 className="animate-spin" /> : null}{t(checking ? "upstream.checking" : "upstream.check")}
    </Button>
  );
  return (
    <section>
      <SectionTitle trailing={action} hint={u.error ?? u.warning ?? t(`upstream.state.${k.state}` as Key, { target, base })}>
        <span className="inline-flex items-center gap-1"><GitBranch className="size-3" />{t("upstream.title")} · {u.name}</span>
      </SectionTitle>
      <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
        <dt className="text-muted-foreground">{t("upstream.repo")}</dt>
        <dd className="truncate font-mono text-[11px] selectable" title={u.repo}>{u.repo}</dd>
        <dt className="text-muted-foreground">{t("upstream.version")}</dt>
        <dd className="font-mono text-[11px] selectable">{base}</dd>
        <dt className="text-muted-foreground">{t("upstream.target")}</dt>
        <dd className="font-mono text-[11px] selectable">{target}{u.target ? <span className="text-muted-foreground"> · {u.target.commit.slice(0, 7)}</span> : null}</dd>
      </dl>
      {k.changes.length > 0 ? (
        <div className="mt-3">
          <p className="mb-1 text-[11px] text-muted-foreground">{t("upstream.changes", { base })} · {k.changes.length}</p>
          <ul className="max-h-[220px] overflow-y-auto rounded-lg border border-border/80 text-[12px]">
            {k.changes.map((c) => (
              // a grid, not flex: the ScrollArea lays content out as a table, which grows to a flex row's full nowrap text
              <li key={c.commit} className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0">
                <span className="font-mono text-[10.5px] text-muted-foreground tabular">{c.date}</span>
                <span className="truncate selectable" title={c.subject}>{c.subject}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
};
