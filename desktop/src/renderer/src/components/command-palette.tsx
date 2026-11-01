import { ArrowUpCircle, Boxes, Info, Languages, Layers, ListChecks, Play, RefreshCw, Server, Settings, TerminalSquare } from "lucide-react";
import { useMemo } from "react";
import { agentKey } from "@/components/matrix";
import { newestOf, updatable } from "@/views/plugins";
import { groupLabel } from "@/views/skills";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useI18n, useT } from "@/i18n";
import { buildCatalog, groupText } from "@/lib/catalog";
import { pendingOf, useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";

export const CommandPalette = () => {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const open = useApp((s) => s.paletteOpen);
  const setPanel = useApp((s) => s.setPanel);
  const setView = useApp((s) => s.setView);
  const select = useApp((s) => s.select);
  const refreshLive = useApp((s) => s.refreshLive);
  const apply = useApp((s) => s.apply);
  const updatePlugins = useApp((s) => s.updatePlugins);
  const updateHarness = useApp((s) => s.updateHarness);
  const skills = useApp((s) => s.skills);
  const hosts = useApp((s) => s.hosts);
  const plans = useApp((s) => s.plans);
  const plugins = useApp((s) => s.plugins);
  const updatePrefs = usePrefs((s) => s.update);
  const catalog = useMemo(() => buildCatalog(skills, hosts), [skills, hosts]);
  const pending = pendingOf(plans).mutations;
  const drifting = (plugins?.plugins ?? []).filter((p) => p.drift && updatable(p));

  const run = (f: () => void) => () => { setPanel({ paletteOpen: false }); f(); };

  return (
    <Dialog open={open} onOpenChange={(o) => setPanel({ paletteOpen: o })}>
      <DialogContent showCloseButton={false} className="top-[22%] translate-y-0 overflow-hidden rounded-xl p-0 sm:max-w-[560px]">
        <DialogTitle className="sr-only">{t("palette.placeholder")}</DialogTitle>
        <DialogDescription className="sr-only">{t("palette.placeholder")}</DialogDescription>
        <Command loop className="[&_[cmdk-item]]:text-[13px]">
          <CommandInput placeholder={t("palette.placeholder")} />
          <CommandList className="max-h-[380px]">
            <CommandEmpty>{t("palette.empty")}</CommandEmpty>
            <CommandGroup heading={t("palette.actions")}>
              {pending > 0 ? (
                <CommandItem value="apply pending sync" onSelect={run(() => void apply())}>
                  <Play />{t("palette.apply")}<CommandShortcut>⌘↵</CommandShortcut>
                </CommandItem>
              ) : null}
              <CommandItem value="review changes activity" onSelect={run(() => setPanel({ reviewOpen: true }))}>
                <ListChecks />{t("palette.review")}
              </CommandItem>
              <CommandItem value="refresh check hosts probe" onSelect={run(() => void refreshLive())}>
                <RefreshCw />{t("palette.refresh")}<CommandShortcut>⌘R</CommandShortcut>
              </CommandItem>
              {drifting.length > 0 ? (
                <CommandItem value="update drifting plugins" onSelect={run(() => void updatePlugins(drifting.map((p) => p.name)))}>
                  <ArrowUpCircle />{t("palette.updateDrifting")} · {drifting.length}
                </CommandItem>
              ) : null}
              <CommandItem value="update agent cli harness claude codex pi" onSelect={run(() => void updateHarness())}>
                <TerminalSquare />{t("palette.updateHarness")}
              </CommandItem>
              <CommandItem value="about version update author" onSelect={run(() => setPanel({ aboutOpen: true }))}>
                <Info />{t("palette.about")}
              </CommandItem>
              <CommandItem value="settings preferences" onSelect={run(() => setPanel({ settingsOpen: true }))}>
                <Settings />{t("palette.settings")}<CommandShortcut>⌘,</CommandShortcut>
              </CommandItem>
              <CommandItem value="language 中文 english" onSelect={run(() => void updatePrefs({ locale: locale === "zh" ? "en" : "zh" }))}>
                <Languages />{locale === "zh" ? "Switch to English" : t("palette.language")}
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading={t("palette.views")}>
              <CommandItem value="view skills" onSelect={run(() => setView("skills"))}><Layers />{t("nav.skills")}<CommandShortcut>⌘1</CommandShortcut></CommandItem>
              <CommandItem value="view plugins" onSelect={run(() => setView("plugins"))}><Boxes />{t("nav.plugins")}<CommandShortcut>⌘2</CommandShortcut></CommandItem>
              <CommandItem value="view hosts" onSelect={run(() => setView("hosts"))}><Server />{t("nav.hosts")}<CommandShortcut>⌘3</CommandShortcut></CommandItem>
            </CommandGroup>
            <CommandGroup heading={t("palette.skills")}>
              {catalog.map((i) => (
                <CommandItem key={i.id} value={`skill ${i.name} ${groupText(i.group)} ${i.id}`} onSelect={run(() => { setView("skills"); select({ selectedSkill: i.id }); })}>
                  <Layers className="opacity-60" />
                  <span className="min-w-0 flex-1 truncate">{i.name}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-right text-[11px] text-muted-foreground">{groupLabel(i.group, t)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading={t("palette.plugins")}>
              {(plugins?.plugins ?? []).map((p) => (
                <CommandItem key={p.name} value={`plugin ${p.name} ${p.ids.join(" ")}`} onSelect={run(() => { setView("plugins"); select({ selectedPlugin: p.name }); })}>
                  <Boxes className="opacity-60" />
                  <span className="truncate">{p.name}</span>
                  <span className={p.drift ? "ml-auto text-[11px] text-danger" : "ml-auto font-mono text-[10.5px] text-muted-foreground"}>{p.drift ? t("plugins.drift") : newestOf(p.versions) ?? p.versions[0] ?? ""}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading={t("palette.hosts")}>
              {hosts.flatMap((h) => Object.keys(h.agents ?? {}).map((a) => (
                <CommandItem key={`${h.host}/${a}`} value={`host ${h.host} ${a}`} onSelect={run(() => { setView("hosts"); select({ selectedAgent: `${h.host}/${a}` }); })}>
                  <Server className="opacity-60" />{h.host} / {t(agentKey(a))}
                </CommandItem>
              )))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
};
