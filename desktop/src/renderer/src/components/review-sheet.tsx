import type { PlanOp } from "@shared/types";
import { Check, CircleAlert, Clock, FolderArchive, Loader2, Play } from "lucide-react";
import { useState } from "react";
import { Chip } from "@/components/common";
import { HEALTH_DOT, useHostHealth } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type Key, ago, useI18n, useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { type Run, type RunHost, useApp } from "@/store/app";

type Group = "files" | "plugins" | "report";

const groupOf = (o: PlanOp): Group => {
  if (!o.mutation) return "report";
  return o.op.startsWith("plugin") || o.op.startsWith("marketplace") || o.op === "owned-ensure" || o.op === "exclude" || o.op === "unexclude" ? "plugins" : "files";
};

const GROUPS: readonly Group[] = ["files", "plugins", "report"];
const GROUP_KEY: Readonly<Record<Group, Key>> = { files: "review.group.files", plugins: "review.group.plugins", report: "review.group.report" };

const opTone = (o: PlanOp): string =>
  o.op === "unlink" || o.op === "plugin-disable" ? "text-danger" : o.op === "conflict" ? "text-danger" : o.op === "blocked" ? "text-pending" : o.mutation ? "text-foreground/85" : "text-muted-foreground";

const OpLine = ({ o }: { o: PlanOp }) => (
  <li className={cn("flex gap-2 py-[3px] font-mono text-[11.5px] leading-snug selectable", opTone(o))}>
    <span className="w-3 shrink-0 text-center text-muted-foreground">{o.op === "unlink" || o.op === "plugin-disable" ? "−" : o.mutation ? "+" : "!"}</span>
    <span className="min-w-0 break-words">{o.text}</span>
  </li>
);

const Changes = () => {
  const t = useT();
  const rows = useHostHealth();
  const apply = useApp((s) => s.apply);
  const running = useApp((s) => s.runs.some((r) => r.status === "running"));
  const [replace, setReplace] = useState(false);
  const withOps = rows.filter((r) => (r.plan?.ops.length ?? 0) > 0 || r.health === "down");
  const total = rows.reduce((n, r) => n + r.pending, 0);
  const conflicts = rows.some((r) => r.plan?.ops.some((o) => o.op === "conflict"));

  if (withOps.length === 0) return <p className="px-5 py-10 text-center text-[12.5px] text-muted-foreground">{t("review.nothing")}</p>;

  return (
    <div className="flex flex-col gap-5 px-5 pb-6">
      {withOps.map((r) => {
        const ops = r.plan?.ops ?? [];
        return (
          <section key={r.host} className="rounded-lg border border-border/80">
            <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
              <span className={cn("size-2 rounded-full", HEALTH_DOT[r.health])} />
              <span className="text-[13px] font-semibold">{r.host}</span>
              <span className="text-[11.5px] text-muted-foreground">{r.status?.reachable === false ? t("review.unreachable") : t("pending.changes", { n: r.pending })}</span>
              <span className="flex-1" />
              {r.pending > 0 ? (
                <Button size="xs" variant="outline" disabled={running} onClick={() => void apply({ host: r.host, replaceConflicts: replace })}>
                  <Play className="size-3" />{t("review.applyHost")}
                </Button>
              ) : null}
            </header>
            <div className="flex flex-col gap-2.5 px-3 py-2.5">
              {r.status?.reachable === false ? <p className="font-mono text-[11px] text-danger selectable">{r.status.error}</p> : null}
              {GROUPS.map((g) => {
                const list = ops.filter((o) => groupOf(o) === g);
                if (list.length === 0) return null;
                return (
                  <div key={g}>
                    <div className="mb-0.5 text-[11px] text-muted-foreground">{t(GROUP_KEY[g])} · {list.length}</div>
                    <ul>{list.map((o, i) => <OpLine key={`${o.op}-${i}`} o={o} />)}</ul>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {conflicts ? (
        <label className="flex items-start gap-3 rounded-lg bg-danger-soft/60 px-3 py-2.5">
          <Switch checked={replace} onCheckedChange={setReplace} className="mt-0.5" />
          <span>
            <span className="block text-[12.5px] font-medium">{t("review.replaceConflicts")}</span>
            <span className="block text-[11.5px] text-muted-foreground">{t("review.replaceConflictsHint")}</span>
          </span>
        </label>
      ) : null}
      {total > 0 ? (
        <Button className="self-end" disabled={running} onClick={() => void apply({ replaceConflicts: replace })}>
          {running ? <Loader2 className="animate-spin" /> : <Play className="size-3" />}
          {t("review.applyAll")} · {total}
        </Button>
      ) : null}
    </div>
  );
};

const RunHostRow = ({ h }: { h: RunHost }) => {
  const t = useT();
  const [open, setOpen] = useState(h.state === "failed");
  return (
    <li className="border-t border-border/50 first:border-t-0">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent/40">
        {h.state === "running" ? <Loader2 className="size-3 animate-spin text-muted-foreground" /> : h.state === "done" ? <Check className="size-3 text-signal" /> : h.state === "failed" ? <CircleAlert className="size-3 text-danger" /> : <Clock className="size-3 text-muted-foreground" />}
        <span className="font-medium">{h.host}</span>
        <span className="tabular text-muted-foreground">{h.summary ?? `${h.ops}`}</span>
        <span className="flex-1" />
        {h.backup ? <span title={t("review.run.backup", { dir: h.backup })}><FolderArchive className="size-3 text-muted-foreground" /></span> : null}
      </button>
      {open && (h.lines.length > 0 || h.failures.length > 0) ? (
        <pre className="mx-3 mb-2 max-h-48 overflow-auto rounded-md bg-foreground/[0.04] px-2.5 py-2 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground selectable">
          {h.backup ? `${t("review.run.backup", { dir: h.backup })}\n` : ""}
          {h.lines.join("\n")}
          {h.failures.length > 0 ? `\n${h.failures.map((f) => `✗ ${f}`).join("\n")}` : ""}
        </pre>
      ) : null}
    </li>
  );
};

const RunCard = ({ run }: { run: Run }) => {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  return (
    <section className="rounded-lg border border-border/80">
      <header className="flex items-center gap-2 px-3 py-2">
        <span className="text-[12.5px] font-semibold">{run.kind === "sync" ? t("review.run.sync") : run.kind === "harness" ? t("review.run.harness", { label: run.label === "*" ? t("common.all") : run.label }) : t("review.run.plugin-update", { label: run.label })}</span>
        <Chip tone={run.status === "running" ? "neutral" : run.status === "done" ? "signal" : "danger"}>{t(`review.run.${run.status}`)}</Chip>
        <span className="flex-1" />
        <span className="text-[11px] text-muted-foreground">{ago(locale, run.startedAt)}</span>
      </header>
      <ul className="border-t border-border/60">{Object.values(run.hosts).map((h) => <RunHostRow key={h.host} h={h} />)}</ul>
      {run.pending !== null || run.error ? (
        <footer className={cn("border-t border-border/60 px-3 py-1.5 text-[11.5px]", run.error || (run.pending?.length ?? 0) > 0 ? "text-pending" : "text-signal")}>
          {run.error ?? ((run.pending?.length ?? 0) > 0 ? t("review.run.stillPending", { list: run.pending?.join(", ") ?? "" }) : t("review.run.verified"))}
        </footer>
      ) : null}
    </section>
  );
};

const Activity = () => {
  const t = useT();
  const runs = useApp((s) => s.runs);
  if (runs.length === 0) return <p className="px-5 py-10 text-center text-[12.5px] text-muted-foreground">{t("review.noActivity")}</p>;
  return <div className="flex flex-col gap-3 px-5 pb-6">{runs.map((r) => <RunCard key={r.id} run={r} />)}</div>;
};

export const ReviewSheet = () => {
  const t = useT();
  const open = useApp((s) => s.reviewOpen);
  const setPanel = useApp((s) => s.setPanel);
  const running = useApp((s) => s.runs[0]?.status === "running");
  const [tab, setTab] = useState<"changes" | "activity">("changes");
  const shown = running ? "activity" : tab;

  return (
    <Sheet open={open} onOpenChange={(o) => setPanel({ reviewOpen: o })}>
      <SheetContent side="right" className="w-[560px] gap-0 p-0 data-[side=right]:sm:max-w-[560px]">
        <SheetHeader className="drag-region px-5 pt-5 pb-3">
          <SheetTitle className="text-[15px]">{t("review.title")}</SheetTitle>
          <SheetDescription className="text-[12px]">{t("review.subtitle")}</SheetDescription>
        </SheetHeader>
        <Tabs value={shown} onValueChange={(v) => setTab(v as "changes" | "activity")} className="min-h-0 flex-1 gap-3">
          <TabsList className="mx-5">
            <TabsTrigger value="changes">{t("review.changes")}</TabsTrigger>
            <TabsTrigger value="activity">{t("review.activity")}</TabsTrigger>
          </TabsList>
          <ScrollArea className="min-h-0 flex-1">
            <TabsContent value="changes"><Changes /></TabsContent>
            <TabsContent value="activity"><Activity /></TabsContent>
          </ScrollArea>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
};
