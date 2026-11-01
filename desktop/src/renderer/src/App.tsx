import type { MenuCommand } from "@shared/types";
import { Command as CommandIcon, RefreshCw, TerminalSquare } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { toast } from "sonner";
import { AboutDialog } from "@/components/about-dialog";
import { CommandPalette } from "@/components/command-palette";
import { PendingBar } from "@/components/pending-bar";
import { ReviewSheet } from "@/components/review-sheet";
import { SettingsDialog } from "@/components/settings-dialog";
import { Sidebar } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { type Key, useT } from "@/i18n";
import { useApplyTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { type View, pendingOf, useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { HostsView } from "@/views/hosts";
import { PluginsView } from "@/views/plugins";
import { SkillsView } from "@/views/skills";

const TITLE: Readonly<Record<View, Key>> = { skills: "nav.skills", plugins: "nav.plugins", hosts: "nav.hosts" };

const onMenu = (c: MenuCommand): void => {
  const s = useApp.getState();
  switch (c) {
    case "about":
    case "check-updates":
      return s.setPanel({ aboutOpen: true });
    case "settings":
      return s.setPanel({ settingsOpen: true });
    case "refresh":
      return void s.refreshLive();
    case "palette":
      return s.setPanel({ paletteOpen: !s.paletteOpen });
    case "review":
      return s.setPanel({ reviewOpen: !s.reviewOpen });
    case "apply":
      return pendingOf(s.plans).mutations > 0 ? void s.apply() : s.setPanel({ reviewOpen: true });
    case "view-skills":
      return s.setView("skills");
    case "view-plugins":
      return s.setView("plugins");
    case "view-hosts":
      return s.setView("hosts");
  }
};

const Toolbar = () => {
  const t = useT();
  const view = useApp((s) => s.view);
  const setPanel = useApp((s) => s.setPanel);
  const refreshLive = useApp((s) => s.refreshLive);
  const probing = useApp((s) => Object.values(s.probe).some((p) => p === "probing"));
  return (
    <header className="drag-region flex h-[52px] shrink-0 items-center gap-2 px-5">
      <h1 className="text-[15px] font-semibold tracking-tight">{t(TITLE[view])}</h1>
      <span className="flex-1" />
      <button
        type="button"
        onClick={() => setPanel({ paletteOpen: true })}
        className="no-drag flex h-7 w-[260px] items-center gap-2 rounded-md bg-foreground/[0.05] px-2.5 text-[12.5px] text-muted-foreground transition-[background-color,scale] hover:bg-foreground/[0.08] active:scale-[0.98]"
      >
        <CommandIcon className="size-3.5" />
        <span className="flex-1 truncate text-left">{t("palette.placeholder")}</span>
        <Kbd>⌘K</Kbd>
      </button>
      <Button variant="ghost" size="icon-sm" className="no-drag" aria-label={t("palette.refresh")} title={t("palette.refresh")} onClick={() => void refreshLive()} disabled={probing}>
        <RefreshCw className={cn(probing && "animate-spin")} />
      </Button>
    </header>
  );
};

const CliMissing = () => {
  const t = useT();
  const boot = useApp((s) => s.boot);
  const setPanel = useApp((s) => s.setPanel);
  const error = useApp((s) => s.error);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-10 text-center">
      <TerminalSquare className="size-7 text-muted-foreground" strokeWidth={1.5} />
      <h2 className="text-[15px] font-semibold">{t("boot.missingTitle")}</h2>
      <p className="max-w-[380px] text-[12.5px] text-muted-foreground">{t("boot.missingBody")}</p>
      {error ? <p className="max-w-[460px] font-mono text-[11px] text-danger selectable">{error}</p> : null}
      <div className="flex gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={() => setPanel({ settingsOpen: true })}>{t("boot.openSettings")}</Button>
        <Button size="sm" onClick={() => void boot()}>{t("boot.retry")}</Button>
      </div>
    </div>
  );
};

const Booting = () => {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-muted-foreground">
      <RefreshCw className="size-3.5 animate-spin" />
      {t("common.loading")}
    </div>
  );
};

const Main = () => {
  const view = useApp((s) => s.view);
  const booted = useApp((s) => s.booted);
  const cliMissing = useApp((s) => s.cliMissing);
  if (cliMissing) return <CliMissing />;
  if (!booted) return <Booting />;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={view} className="h-full" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.08 }}>
        {view === "skills" ? <SkillsView /> : view === "plugins" ? <PluginsView /> : <HostsView />}
      </motion.div>
    </AnimatePresence>
  );
};

export const App = () => {
  useApplyTheme();
  const t = useT();
  const error = useApp((s) => s.error);
  const cliMissing = useApp((s) => s.cliMissing);
  const clearError = useApp((s) => s.clearError);

  useEffect(() => {
    void usePrefs.getState().load().then(() => useApp.getState().boot());
    return window.skm.onMenu(onMenu);
  }, []);

  // CLI errors surface once as a toast; the missing-CLI screen shows its own copy
  useEffect(() => {
    if (error === null || cliMissing) return;
    toast.error(t("error.title"), { description: error });
    clearError();
  }, [error, cliMissing, clearError, t]);

  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <main className="relative flex min-w-0 flex-1 flex-col bg-background shadow-[-1px_0_0_var(--border)]">
          <Toolbar />
          <div className="relative min-h-0 flex-1">
            <Main />
            <PendingBar />
          </div>
        </main>
      </div>
      <ReviewSheet />
      <SettingsDialog />
      <CommandPalette />
      <AboutDialog />
      <Toaster position="top-right" />
    </TooltipProvider>
  );
};
