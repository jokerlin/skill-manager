import type { HostStatus } from "@shared/types";
import { motion } from "motion/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type CatalogItem, type CellState, cellState } from "@/lib/catalog";
import { cn } from "@/lib/utils";
import { type Key, useT } from "@/i18n";

/** Width of one host's slot in every matrix, so headers and rows line up. */
export const HOST_SLOT = 58;

export const agentLetter = (a: string): string => ({ claude: "C", codex: "X", pi: "P" })[a] ?? a.slice(0, 1).toUpperCase();
/** `agent.<id>`: the dictionaries name the built-in agents; extension agents are registered at runtime (useI18n extra). */
export const agentKey = (a: string): Key => `agent.${a}` as Key;

const DOT: Readonly<Record<CellState, string>> = {
  loaded: "bg-signal",
  "pending-add": "bg-pending-soft ring-1 ring-inset ring-pending",
  "pending-remove": "bg-pending",
  off: "bg-foreground/[0.09]",
  unknown: "border border-dashed border-muted-foreground/50",
  absent: "bg-transparent",
};

/** Short labels for cells inside the detail grid, where the long ones do not fit. */
export const CELL_SHORT: Readonly<Record<CellState, Key>> = {
  loaded: "cell.loaded",
  "pending-add": "cell.short.pendingAdd",
  "pending-remove": "cell.short.pendingRemove",
  off: "cell.off",
  unknown: "cell.short.unknown",
  absent: "cell.short.absent",
};

export const CELL_TEXT: Readonly<Record<CellState, Key>> = {
  loaded: "cell.loaded",
  "pending-add": "cell.pendingAdd",
  "pending-remove": "cell.pendingRemove",
  off: "cell.off",
  unknown: "cell.unknown",
  absent: "cell.absent",
};

/** One square of the matrix. `pop` re-mounts on state change so the change is acknowledged with a short scale. */
export const Dot = ({ state, className }: { state: CellState; className?: string }) => (
  <motion.span
    key={state}
    initial={{ scale: 0.6, opacity: 0.4 }}
    animate={{ scale: 1, opacity: 1 }}
    transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
    className={cn("inline-block size-[9px] shrink-0 rounded-[2.5px]", DOT[state], className)}
  />
);

/** Host labels with agent letters underneath; sits above a column of MatrixStrip rows. */
export const MatrixHeader = ({ hosts, agentsOf }: { hosts: readonly string[]; agentsOf: (h: string) => readonly string[] }) => (
  <div className="flex items-end">
    {hosts.map((h) => (
      <div key={h} style={{ width: HOST_SLOT }} className="flex flex-col items-center gap-0.5">
        <span className="max-w-full overflow-hidden text-[10.5px] leading-none font-medium whitespace-nowrap text-muted-foreground">{h}</span>
        <span className="flex gap-[4px] font-mono text-[8.5px] leading-none text-muted-foreground/70">
          {agentsOf(h).map((a) => <span key={a} className="w-[9px] text-center">{agentLetter(a)}</span>)}
        </span>
      </div>
    ))}
  </div>
);

/** The row-level signature: one cluster of dots per host, one dot per agent. */
export const MatrixStrip = ({ item, hosts, agentsOf, statusOf }: {
  item: CatalogItem;
  hosts: readonly string[];
  agentsOf: (h: string) => readonly string[];
  statusOf: (h: string) => HostStatus | undefined;
}) => {
  const t = useT();
  return (
    <div className="flex items-center">
      {hosts.map((h) => {
        const st = statusOf(h);
        return (
          <div key={h} style={{ width: HOST_SLOT }} className="flex justify-center gap-[4px]">
            {agentsOf(h).map((a) => {
              const s = cellState(item, st, a);
              return (
                <Tooltip key={a} delayDuration={350}>
                  <TooltipTrigger asChild>
                    <span className="flex"><Dot state={s} /></span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    <span className="font-medium">{h} · {t(agentKey(a))}</span>
                    <span className="ml-1.5 opacity-80">{t(CELL_TEXT[s])}</span>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

/** Legend for the dot states, shown under matrices. */
export const MatrixLegend = ({ states }: { states: readonly CellState[] }) => {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {states.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5"><Dot state={s} />{t(CELL_TEXT[s])}</span>
      ))}
    </div>
  );
};
