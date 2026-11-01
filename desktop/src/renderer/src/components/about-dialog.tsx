import type { AppInfo, UpdateState } from "@shared/types";
import { ArrowUpRight, CheckCircle2, Download, Loader2, RefreshCw, RotateCcw, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ago, useI18n, useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";

/** Updater state shared by the About dialog and Settings → General; follows the main process. */
export const useUpdateState = (): UpdateState => {
  const [s, setS] = useState<UpdateState>({ kind: "idle" });
  useEffect(() => {
    void window.skm.updateState().then(setS);
    return window.skm.onUpdate(setS);
  }, []);
  return s;
};

/** One line of status plus the next action for the updater. */
export const UpdateRow = ({ state }: { state: UpdateState }) => {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const line = (icon: ReactNode, text: ReactNode, tone: "muted" | "signal" | "danger" | "fg" = "muted") => (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-[12px]", tone === "signal" && "text-signal", tone === "danger" && "text-danger", tone === "muted" && "text-muted-foreground")}>
      {icon}<span className="min-w-0 truncate">{text}</span>
    </span>
  );
  const status = (() => {
    switch (state.kind) {
      case "idle":
        return line(null, t("about.idle"));
      case "checking":
        return line(<Loader2 className="size-3.5 animate-spin" />, t("about.checking"));
      case "current":
        return line(<CheckCircle2 className="size-3.5" />, t("about.current", { when: ago(locale, state.checkedAt) }), "signal");
      case "available":
        return line(<Download className="size-3.5" />, t("about.available", { v: state.version }), "fg");
      case "downloading":
        return line(<Loader2 className="size-3.5 animate-spin" />, t("about.downloading", { v: state.version, p: state.percent }), "fg");
      case "ready":
        return line(<CheckCircle2 className="size-3.5" />, t("about.ready", { v: state.version }), "signal");
      case "error":
        return line(<TriangleAlert className="size-3.5" />, t("about.error", { msg: state.message }), "danger");
    }
  })();
  const action = (() => {
    switch (state.kind) {
      case "idle":
      case "current":
      case "error":
        return <Button size="xs" variant="outline" onClick={() => void window.skm.checkForUpdates()}><RefreshCw />{t("about.check")}</Button>;
      case "checking":
      case "downloading":
        return null;
      case "available":
        return state.asset !== null
          ? <Button size="xs" onClick={() => void window.skm.downloadUpdate()}><Download />{t("about.download")}</Button>
          : <Button size="xs" variant="outline" onClick={() => void window.skm.openExternal(state.url)}><ArrowUpRight />{t("about.releaseNotes")}</Button>;
      case "ready":
        return <Button size="xs" onClick={() => void window.skm.installUpdate()}><RotateCcw />{t("about.restart")}</Button>;
    }
  })();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">{status}</div>
        {action}
      </div>
      {state.kind === "downloading" ? (
        <span className="h-[3px] w-full overflow-hidden rounded-full bg-foreground/10">
          <span className="block h-full origin-left rounded-full bg-signal transition-transform duration-200" style={{ transform: `scaleX(${state.percent / 100})` }} />
        </span>
      ) : null}
      {state.kind === "available" && state.asset === null ? <p className="text-[11px] text-muted-foreground">{t(state.manual === "unsigned" ? "about.unsigned" : state.manual === "no-key" ? "about.noKey" : "about.noAsset")}</p> : null}
    </div>
  );
};

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <>
    <dt className="text-[12px] text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-[12px]">{children}</dd>
  </>
);

export const AboutDialog = () => {
  const t = useT();
  const open = useApp((s) => s.aboutOpen);
  const setPanel = useApp((s) => s.setPanel);
  const prefs = usePrefs((s) => s.prefs);
  const update = usePrefs((s) => s.update);
  const state = useUpdateState();
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => { if (open && info === null) void window.skm.appInfo().then(setInfo); }, [open, info]);

  return (
    <Dialog open={open} onOpenChange={(o) => setPanel({ aboutOpen: o })}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[420px]">
        <div className="flex flex-col items-center gap-2 px-8 pt-8 pb-5 text-center">
          <img src="./icon.svg" alt="" className="size-[72px] drop-shadow-[0_4px_10px_oklch(0_0_0/0.18)]" />
          <DialogTitle className="mt-1 text-[17px] font-semibold tracking-[-0.01em]">{t("app.name")}</DialogTitle>
          <span className="tabular text-[12px] text-muted-foreground">{info ? t("about.version", { v: info.version }) : " "}</span>
          <DialogDescription className="max-w-[320px] text-[12.5px] leading-relaxed text-foreground/80">{t("about.tagline")}</DialogDescription>
        </div>
        <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-border/70 px-6 py-4">
          <Field label={t("about.author")}>
            {info ? <button type="button" className="text-left hover:underline" onClick={() => void window.skm.openExternal("https://github.com/jokerlin")}>{info.author}</button> : null}
          </Field>
          <Field label={t("about.source")}>
            {info ? <button type="button" className="inline-flex max-w-full items-center gap-1 truncate text-left hover:underline" onClick={() => void window.skm.openExternal(info.homepage)}>{info.homepage.replace(/^https:\/\//, "")}<ArrowUpRight className="size-3 shrink-0" /></button> : null}
          </Field>
          <Field label={t("about.runtime")}>
            <span className="tabular text-muted-foreground">{info ? `Electron ${info.electron} · ${info.platform}-${info.arch}` : ""}</span>
          </Field>
        </dl>
        <div className="flex flex-col gap-3 border-t border-border/70 bg-surface/50 px-6 py-4">
          <UpdateRow state={state} />
          <label className="flex items-center justify-between gap-3">
            <span className="flex flex-col">
              <span className="text-[12px]">{t("about.auto")}</span>
              <span className="text-[11px] text-muted-foreground">{t("about.autoHint")}</span>
            </span>
            <Switch size="sm" checked={prefs?.autoUpdate ?? true} onCheckedChange={(v) => void update({ autoUpdate: v })} />
          </label>
        </div>
      </DialogContent>
    </Dialog>
  );
};
