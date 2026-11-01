import { Check, CircleAlert, Loader2, Play } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { type Key, useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { pendingOf, useApp } from "@/store/app";

/** What the bar shows: nothing, pending changes, a run in progress, or the result of the last run. */
type BarState =
  | { readonly kind: "hidden" }
  | { readonly kind: "pending"; readonly mutations: number; readonly hosts: readonly string[]; readonly conflicts: number; readonly blocked: number }
  | { readonly kind: "running"; readonly runKind: "sync" | "plugin-update" | "harness"; readonly done: number; readonly total: number }
  | { readonly kind: "finished"; readonly ok: boolean };

const RESULT_MS = 4000;

const RUN_TEXT: Readonly<Record<"sync" | "plugin-update" | "harness", Key>> = { sync: "pending.applying", "plugin-update": "pending.updating", harness: "pending.updatingHarness" };

const hostList = (hosts: readonly string[]): string => (hosts.length <= 3 ? hosts.join(", ") : `${hosts.slice(0, 2).join(", ")} +${hosts.length - 2}`);

export const PendingBar = () => {
  const t = useT();
  const plans = useApp((s) => s.plans);
  const runs = useApp((s) => s.runs);
  const apply = useApp((s) => s.apply);
  const setPanel = useApp((s) => s.setPanel);
  const reviewOpen = useApp((s) => s.reviewOpen);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const last = runs[0];
  // keep the result visible for a few seconds after a run ends
  useEffect(() => {
    if (!last || last.status === "running" || !last.finishedAt) return;
    const left = RESULT_MS - (Date.now() - Date.parse(last.finishedAt));
    const timer = window.setTimeout(() => setDismissed(last.id), Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [last]);

  const p = pendingOf(plans);
  const hostsOfRun = last ? Object.values(last.hosts) : [];
  const state: BarState =
    last?.status === "running"
      ? { kind: "running", runKind: last.kind, done: hostsOfRun.filter((h) => h.state === "done" || h.state === "failed").length, total: Math.max(hostsOfRun.length, 1) }
      : last && last.finishedAt && dismissed !== last.id
        ? { kind: "finished", ok: last.status === "done" && (last.pending?.length ?? 0) === 0 }
        : p.mutations > 0 || p.conflicts > 0 || p.blocked > 0
          ? { kind: "pending", ...p }
          : { kind: "hidden" };

  const body = (() => {
    switch (state.kind) {
      case "hidden":
        return null;
      case "pending":
        return (
          <>
            <span className="relative flex size-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-pending/60 [animation-duration:2.4s]" />
              <span className="relative size-2 rounded-full bg-pending" />
            </span>
            <span className="text-[12.5px] font-medium">{t("pending.changes", { n: state.mutations })}</span>
            {state.hosts.length > 0 ? <span className="truncate text-[12px] text-muted-foreground">{t("pending.onHosts", { hosts: hostList(state.hosts) })}</span> : null}
            {state.conflicts > 0 ? <span className="rounded-sm bg-danger-soft px-1.5 text-[11px] text-danger">{t("pending.conflicts", { n: state.conflicts })}</span> : null}
            {state.blocked > 0 ? <span className="rounded-sm bg-pending-soft px-1.5 text-[11px] text-pending">{t("pending.blocked", { n: state.blocked })}</span> : null}
            <span className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setPanel({ reviewOpen: true })}>{t("pending.review")}</Button>
            {state.mutations > 0 ? (
              <Button size="sm" onClick={() => void apply()}>
                <Play className="size-3" />
                {t("pending.apply")}
                <Kbd className="ml-0.5 bg-primary-foreground/15 text-primary-foreground">⌘↵</Kbd>
              </Button>
            ) : null}
          </>
        );
      case "running":
        return (
          <>
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            <span className="text-[12.5px] font-medium">{t(RUN_TEXT[state.runKind], { n: state.total })}</span>
            <span className="tabular text-[12px] text-muted-foreground">{state.done}/{state.total}</span>
            <span className="h-[3px] w-24 overflow-hidden rounded-full bg-foreground/10">
              <span className="block h-full origin-left rounded-full bg-signal transition-transform duration-300" style={{ transform: `scaleX(${state.done / state.total})` }} />
            </span>
            <span className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setPanel({ reviewOpen: true })}>{t("review.activity")}</Button>
          </>
        );
      case "finished":
        return (
          <>
            {state.ok ? <Check className="size-3.5 text-signal" /> : <CircleAlert className="size-3.5 text-danger" />}
            <span className="text-[12.5px] font-medium">{t(state.ok ? "pending.done" : "pending.doneWithIssues")}</span>
            <span className="flex-1" />
            <Button variant="ghost" size="sm" onClick={() => setPanel({ reviewOpen: true })}>{t("review.activity")}</Button>
          </>
        );
    }
  })();

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-12 z-30 flex justify-center px-4">
      <AnimatePresence>
        {state.kind !== "hidden" && !reviewOpen ? (
          <motion.div
            key="bar"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "pointer-events-auto flex h-11 w-full max-w-[620px] items-center gap-2.5 rounded-[10px] border border-border/80 bg-popover/95 pr-1.5 pl-3.5 shadow-[0_8px_28px_oklch(0_0_0/0.14),0_1px_2px_oklch(0_0_0/0.08)] backdrop-blur-md",
            )}
          >
            {body}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
};
