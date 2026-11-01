import { Boxes, ChevronsUpDown, Layers, type LucideIcon, RefreshCw, Server, Settings } from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ago, useI18n, useT } from "@/i18n";
import { type HostHealth, type View, hostHealth, useApp, useGrid } from "@/store/app";
import { cn } from "@/lib/utils";

const NAV: readonly { readonly view: View; readonly icon: LucideIcon; readonly key: "nav.skills" | "nav.plugins" | "nav.hosts"; readonly kbd: string }[] = [
  { view: "skills", icon: Layers, key: "nav.skills", kbd: "1" },
  { view: "plugins", icon: Boxes, key: "nav.plugins", kbd: "2" },
  { view: "hosts", icon: Server, key: "nav.hosts", kbd: "3" },
];

export const HEALTH_DOT: Readonly<Record<HostHealth, string>> = {
  ok: "bg-signal",
  pending: "bg-pending",
  probing: "bg-muted-foreground/40 animate-pulse",
  stale: "bg-pending/50 ring-1 ring-inset ring-pending",
  down: "bg-danger",
};

const healthWeight: Readonly<Record<HostHealth, number>> = { ok: 0, pending: 1, probing: 2, stale: 3, down: 4 };

/** Per-host health from the store, in config order. */
export const useHostHealth = () => {
  const { hosts } = useGrid();
  const statuses = useApp((s) => s.hosts);
  const plans = useApp((s) => s.plans);
  const probe = useApp((s) => s.probe);
  return hosts.map((h) => {
    const st = statuses.find((x) => x.host === h);
    const plan = plans.find((x) => x.host === h);
    return { host: h, status: st, plan, health: hostHealth(st, plan, probe[h]), pending: plan?.ops.filter((o) => o.mutation).length ?? 0 };
  });
};

const HostPill = () => {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const rows = useHostHealth();
  const refreshLive = useApp((s) => s.refreshLive);
  const down = rows.filter((r) => r.health === "down").length;
  const probing = rows.filter((r) => r.health === "probing").length;
  const pending = rows.filter((r) => r.health === "pending").length;
  const summary =
    down > 0 ? t("pill.summary.down", { n: down })
    : probing > 0 ? t("pill.summary.probing", { n: probing })
    : pending > 0 ? t("pill.summary.pending", { n: pending })
    : t("pill.summary.ok", { n: rows.length });
  const worst = rows.reduce<HostHealth>((w, r) => (healthWeight[r.health] > healthWeight[w] ? r.health : w), "ok");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="no-drag group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-[background-color,scale] hover:bg-sidebar-accent active:scale-[0.98]"
        >
          <span className="flex -space-x-[3px]">
            {rows.map((r) => (
              <motion.span
                layout
                key={r.host}
                className={cn("size-[9px] rounded-full ring-2 ring-sidebar", HEALTH_DOT[r.health])}
              />
            ))}
          </span>
          <span className={cn("flex-1 truncate text-[12px]", worst === "down" ? "text-danger" : "text-muted-foreground group-hover:text-foreground")}>{summary}</span>
          <ChevronsUpDown className="size-3.5 text-muted-foreground/60" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-[300px] p-0">
        <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
          <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("pill.title")}</span>
          <Button variant="ghost" size="xs" onClick={() => void refreshLive()} disabled={probing > 0}>
            <RefreshCw className={cn(probing > 0 && "animate-spin")} />
            {t("pill.refreshAll")}
            <Kbd className="ml-0.5">⌘R</Kbd>
          </Button>
        </div>
        <ul className="pb-1.5">
          {rows.map((r) => (
            <li key={r.host} className="group/row flex items-center gap-2.5 px-3 py-1.5 hover:bg-accent/60">
              <span className={cn("size-2 shrink-0 rounded-full", HEALTH_DOT[r.health])} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[13px] font-medium">{r.host}</span>
                  <span className="truncate font-mono text-[10.5px] text-muted-foreground">{r.status?.ssh ?? t("pill.local")}</span>
                </div>
                <div className={cn("text-[11.5px]", r.health === "down" ? "text-danger" : r.health === "pending" || r.health === "stale" ? "text-pending" : "text-muted-foreground")}>
                  {r.health === "pending" ? t("health.pending", { n: r.pending }) : t(`health.${r.health}`)}
                  {r.health !== "probing" && r.status?.probedAt ? <span className="text-muted-foreground"> · {t("pill.probed", { when: ago(locale, r.status.probedAt) })}</span> : null}
                </div>
                {r.health === "down" || r.health === "stale" ? (
                  <div className="mt-0.5 line-clamp-2 font-mono text-[10.5px] text-muted-foreground selectable">{r.status?.lastError?.error ?? r.status?.error}</div>
                ) : null}
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t("pill.refreshHost", { host: r.host })}
                className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                onClick={() => void refreshLive(r.host)}
                disabled={r.health === "probing"}
              >
                <RefreshCw className={cn(r.health === "probing" && "animate-spin")} />
              </Button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
};

export const Sidebar = () => {
  const t = useT();
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const setPanel = useApp((s) => s.setPanel);
  const plugins = useApp((s) => s.plugins);
  const drifting = plugins?.plugins.filter((p) => p.drift).length ?? 0;
  const counts: Readonly<Record<View, string | null>> = { skills: null, plugins: drifting > 0 ? String(drifting) : null, hosts: null };

  return (
    <aside className="flex h-full w-[212px] shrink-0 flex-col bg-sidebar">
      <div className="drag-region h-[52px] shrink-0" />
      <button
        type="button"
        onClick={() => setPanel({ aboutOpen: true })}
        title={t("palette.about")}
        className="no-drag mx-2.5 mb-3 flex items-center gap-2.5 rounded-md px-1.5 py-1 text-left transition-[background-color,scale] hover:bg-sidebar-accent active:scale-[0.98]"
      >
        <img src="./icon.svg" alt="" className="size-[26px] drop-shadow-[0_1px_1px_oklch(0_0_0/0.18)]" />
        <span className="text-[14px] font-semibold tracking-[-0.01em]">{t("app.name")}</span>
      </button>
      <nav className="flex flex-col gap-px px-2.5">
        {NAV.map((n) => {
          const active = view === n.view;
          return (
            <button
              key={n.view}
              type="button"
              onClick={() => setView(n.view)}
              className={cn(
                "no-drag relative flex h-[30px] items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-[background-color,color,scale] active:scale-[0.98]",
                active ? "text-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
              )}
            >
              {active ? <motion.span layoutId="nav-active" transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }} className="absolute inset-0 rounded-md bg-sidebar-accent" /> : null}
              <n.icon className="relative size-[15px]" strokeWidth={1.75} />
              <span className="relative flex-1 text-left">{t(n.key)}</span>
              {counts[n.view] !== null ? (
                <span className={cn("relative tabular text-[11px]", n.view === "plugins" ? "rounded-sm bg-danger-soft px-1.5 text-danger" : "text-muted-foreground")}>{counts[n.view]}</span>
              ) : null}
            </button>
          );
        })}
      </nav>
      <div className="flex-1" />
      <div className="flex flex-col gap-0.5 border-t border-sidebar-border px-2.5 pt-2 pb-3">
        <HostPill />
        <button
          type="button"
          onClick={() => setPanel({ settingsOpen: true })}
          className="no-drag flex h-[30px] items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-[background-color,color,scale] hover:bg-sidebar-accent hover:text-foreground active:scale-[0.98]"
        >
          <Settings className="size-[15px]" strokeWidth={1.75} />
          <span className="flex-1 text-left">{t("nav.settings")}</span>
          <Kbd>⌘,</Kbd>
        </button>
      </div>
    </aside>
  );
};
