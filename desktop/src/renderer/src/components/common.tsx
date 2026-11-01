import { Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Compact search box used at the top of every list. Esc clears it. */
export const SearchField = ({ value, onChange, placeholder, className }: { value: string; onChange: (v: string) => void; placeholder: string; className?: string }) => (
  <label className={cn("no-drag flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-foreground/[0.05] px-2 text-[12.5px] focus-within:bg-background focus-within:ring-1 focus-within:ring-ring/60", className)}>
    <Search className="size-3.5 shrink-0 text-muted-foreground" />
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Escape") onChange(""); }}
      placeholder={placeholder}
      className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70"
      spellCheck={false}
    />
    {value.length > 0 ? (
      <button type="button" aria-label="clear" onClick={() => onChange("")} className="text-muted-foreground hover:text-foreground">
        <X className="size-3.5" />
      </button>
    ) : null}
  </label>
);

/** Segmented control: one row of mutually exclusive choices with an optional count. */
export const Segmented = <T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { readonly value: T; readonly label: string; readonly count?: number }[];
}) => (
  <div role="radiogroup" className="no-drag inline-flex h-7 items-center gap-px rounded-md bg-foreground/[0.05] p-[2px]">
    {options.map((o) => {
      const active = o.value === value;
      return (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={active}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-full items-center gap-1.5 rounded-[4px] px-2 text-[12px] whitespace-nowrap transition-[background-color,color,box-shadow,scale] active:scale-[0.97]",
            active ? "bg-background text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.08),0_0_0_0.5px_oklch(0_0_0/0.06)] dark:bg-foreground/[0.12]" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
          {o.count !== undefined ? <span className="tabular text-[10.5px] text-muted-foreground">{o.count}</span> : null}
        </button>
      );
    })}
  </div>
);

/** Section title inside a detail panel: small caps label, optional trailing slot, no card. */
export const SectionTitle = ({ children, trailing, hint }: { children: ReactNode; trailing?: ReactNode; hint?: ReactNode }) => (
  <div className="mb-2">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">{children}</h3>
      {trailing}
    </div>
    {hint ? <p className="mt-0.5 text-[11.5px] text-muted-foreground/90">{hint}</p> : null}
  </div>
);

/** A number with its label underneath; `warn` tints it amber. */
export const Metric = ({ label, value, hint, warn = false }: { label: string; value: ReactNode; hint?: string; warn?: boolean }) => (
  <div className="min-w-0" title={hint}>
    <div className={cn("tabular text-[15px] font-semibold tracking-tight", warn && "text-pending")}>{value}</div>
    <div className="text-[11px] text-muted-foreground">{label}</div>
  </div>
);

export type Tone = "neutral" | "signal" | "pending" | "danger" | "info";

/**
 * Data tile: label on top, the number large with its unit small beside it, one line of context underneath.
 * Tiles sit in a grid with hairline borders between them (no shadows), so a row of numbers reads as one instrument.
 */
export const Stat = ({ label, value, unit, sub, tone = "neutral", hint, children }: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  tone?: "neutral" | "pending" | "danger";
  hint?: string;
  children?: ReactNode;
}) => (
  <div className="flex min-w-0 flex-col gap-1 bg-background px-3.5 py-3" title={hint}>
    <div className="truncate text-[11px] text-muted-foreground">{label}</div>
    <div className={cn("flex items-baseline gap-1 tabular", tone === "pending" && "text-pending", tone === "danger" && "text-danger")}>
      <span className="text-[22px] leading-none font-semibold tracking-[-0.02em]">{value}</span>
      {unit ? <span className="text-[11.5px] font-medium text-muted-foreground">{unit}</span> : null}
    </div>
    {children}
    {sub !== undefined ? <div className="truncate text-[11px] text-muted-foreground">{sub}</div> : null}
  </div>
);

/** Grid of Stat tiles separated by 1px rules. */
export const StatGrid = ({ children, cols }: { children: ReactNode; cols: number }) => (
  <div className="grid gap-px overflow-hidden rounded-lg border border-border/80 bg-border/80" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
    {children}
  </div>
);

/** Small pill for sources, scopes, states. */
export const Chip = ({ children, tone = "neutral", className, mono = false }: { children: ReactNode; tone?: Tone; className?: string; mono?: boolean }) => (
  <span
    className={cn(
      "inline-flex h-[18px] max-w-full items-center gap-1 rounded-sm px-1.5 text-[11px] leading-none whitespace-nowrap",
      mono && "font-mono text-[10.5px]",
      tone === "neutral" && "bg-foreground/[0.06] text-muted-foreground",
      tone === "signal" && "bg-signal-soft text-signal",
      tone === "pending" && "bg-pending-soft text-pending",
      tone === "danger" && "bg-danger-soft text-danger",
      tone === "info" && "bg-info-soft text-info",
      className,
    )}
  >
    {children}
  </span>
);

/** Empty state for panels: one line, centred, muted. */
export const Empty = ({ icon, children }: { icon?: ReactNode; children: ReactNode }) => (
  <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-[12.5px] text-muted-foreground">
    {icon}
    <div className="max-w-[280px]">{children}</div>
  </div>
);

export const fmtBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

export const fmtTokens = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
