import { Eye } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type CoverageSummary, type Segment, summarize, type CoverageCell } from "@/lib/coverage";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { agentKey, agentLetter } from "@/components/matrix";

/** Width of the coverage column; fixed, whatever the number of hosts and agents. */
export const COVERAGE_W = 176;

/** "all" = one summary per row; a host id = that host's agents as dots. */
export type Lens = "all" | string;

const names = (xs: readonly string[], many: string): string => (xs.length <= 2 ? xs.join(", ") : many);

export const useCoverageText = () => {
  const t = useT();
  return (s: CoverageSummary): string => {
    switch (s.kind) {
      case "everywhere":
        return t("coverage.everywhere");
      case "nowhere":
        return t("coverage.nowhere");
      case "only-hosts":
        return t("coverage.only", { list: names(s.hosts, t("coverage.nHosts", { n: s.hosts.length })) });
      case "except-hosts":
        return t("coverage.except", { list: names(s.hosts, t("coverage.nHosts", { n: s.hosts.length })) });
      case "only-agents":
        return t("coverage.only", { list: names(s.agents.map((a) => t(agentKey(a))), t("coverage.nAgents", { n: s.agents.length })) });
      case "except-agents":
        return t("coverage.except", { list: names(s.agents.map((a) => t(agentKey(a))), t("coverage.nAgents", { n: s.agents.length })) });
      case "partial":
        return t("coverage.partial", { n: s.on, total: s.total });
    }
  };
};

/** Proportional bar: each segment's width is its share of all cells, so 12 or 120 cells take the same space. */
export const CoverageBar = ({ segments, className }: { segments: readonly Segment[]; className?: string }) => {
  const total = segments.reduce((n, s) => n + s.count, 0);
  return (
    <span className={cn("flex h-[6px] w-14 shrink-0 gap-px overflow-hidden rounded-full", className)}>
      {total === 0 ? <span className="flex-1 bg-foreground/[0.06]" /> : segments.filter((s) => s.count > 0).map((s) => (
        <span key={s.key} className={cn("h-full", s.className)} style={{ flexGrow: s.count, flexBasis: 0 }} />
      ))}
    </span>
  );
};

/** Hover card: the full host × agent grid for one row, drawn only on demand. */
const MiniGrid = ({ hosts, agentsOf, dot }: { hosts: readonly string[]; agentsOf: (h: string) => readonly string[]; dot: (h: string, a: string) => string }) => {
  const agents = [...new Set(hosts.flatMap(agentsOf))];
  return (
    <table className="border-separate border-spacing-x-1.5 border-spacing-y-1 text-[11px]">
      <thead>
        <tr><th />{agents.map((a) => <th key={a} className="font-mono text-[10px] font-normal opacity-70">{agentLetter(a)}</th>)}</tr>
      </thead>
      <tbody>
        {hosts.map((h) => (
          <tr key={h}>
            <td className="pr-1 text-right opacity-90">{h}</td>
            {agents.map((a) => (
              <td key={a} className="text-center">
                {agentsOf(h).includes(a) ? <span className={cn("inline-block size-[9px] rounded-[2.5px]", dot(h, a))} /> : <span className="inline-block size-[9px]" />}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/**
 * The row-level "where": a proportional bar plus one phrase ("Everywhere", "Only home-mini", "All but Codex", "7 / 12").
 * Hovering shows the full grid. `extra` replaces the phrase tone when something needs attention (pending, drift).
 */
export const CoverageCellView = ({ cells, segments, hosts, agentsOf, dot, extra, tone = "muted" }: {
  cells: readonly CoverageCell[];
  segments: readonly Segment[];
  hosts: readonly string[];
  agentsOf: (h: string) => readonly string[];
  dot: (h: string, a: string) => string;
  extra?: ReactNode;
  tone?: "muted" | "pending" | "danger";
}) => {
  const t = useT();
  const text = useCoverageText();
  const summary = summarize(cells);
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <div style={{ width: COVERAGE_W }} className="flex min-w-0 items-center gap-2">
          <CoverageBar segments={segments} />
          <span className={cn("min-w-0 truncate text-[12px]", summary.kind === "nowhere" ? "text-muted-foreground/70" : "text-foreground/80")}>{text(summary)}</span>
          {extra !== undefined ? <span className={cn("ml-auto shrink-0 tabular text-[11px]", tone === "pending" ? "text-pending" : tone === "danger" ? "text-danger" : "text-muted-foreground")}>{extra}</span> : null}
        </div>
      </TooltipTrigger>
      <TooltipContent side="left" className="px-2.5 py-2">
        <div className="mb-1 text-[11px] opacity-80">{t("coverage.cells", { n: cells.filter((c) => c.on).length, total: cells.length })}</div>
        <MiniGrid hosts={hosts} agentsOf={agentsOf} dot={dot} />
      </TooltipContent>
    </Tooltip>
  );
};

/** Header for the coverage column: a label, or the agent letters of the host the lens is on. */
export const CoverageHeader = ({ lens, agents }: { lens: Lens; agents: readonly string[] }) => {
  const t = useT();
  return lens === "all" ? (
    <span style={{ width: COVERAGE_W }} className="block">{t("coverage.col")}</span>
  ) : (
    <span style={{ width: COVERAGE_W }} className="flex items-end gap-[6px]">
      <span className="mr-1 w-[80px] shrink-0 truncate">{lens}</span>
      {agents.map((a) => <span key={a} title={t(agentKey(a))} className="w-[11px] text-center font-mono text-[10px]">{agentLetter(a)}</span>)}
    </span>
  );
};

/** One host's agents as labelled dots (the lens view). */
export const LensDots = ({ agents, dot, label }: { agents: readonly string[]; dot: (a: string) => string; label: (a: string) => string }) => (
  <span style={{ width: COVERAGE_W }} className="flex items-center gap-[6px] pl-[84px]">
    {agents.map((a) => (
      <Tooltip key={a} delayDuration={350}>
        <TooltipTrigger asChild><span className={cn("inline-block size-[11px] rounded-[3px]", dot(a))} /></TooltipTrigger>
        <TooltipContent className="text-xs">{label(a)}</TooltipContent>
      </Tooltip>
    ))}
  </span>
);

/** Toolbar control that switches the coverage column between the summary and a single host. */
export const LensMenu = ({ value, onChange, hosts }: { value: Lens; onChange: (l: Lens) => void; hosts: readonly string[] }) => {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="no-drag text-muted-foreground"><Eye />{value === "all" ? t("coverage.lens.all") : t("coverage.lens.host", { host: value })}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">{t("coverage.lens")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value="all">{t("coverage.lens.all")}</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {hosts.map((h) => <DropdownMenuRadioItem key={h} value={h}>{h}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
