import { DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AgentInfo, ConfigSummary, Locale, Theme } from "@shared/types";
import { Bot, ChevronDown, FileCog, GripVertical, type LucideIcon, Plus, Puzzle, Server, SlidersHorizontal, Trash2 } from "lucide-react";
import { UpdateRow, useUpdateState } from "@/components/about-dialog";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Segmented } from "@/components/common";
import { agentKey } from "@/components/matrix";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { type Key, useT } from "@/i18n";
import { errorText, skm } from "@/lib/skm";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { usePrefs } from "@/store/prefs";

type Section = "general" | "hosts" | "agents" | "extensions" | "advanced";
const SECTIONS: readonly { readonly id: Section; readonly icon: LucideIcon; readonly key: Key }[] = [
  { id: "general", icon: SlidersHorizontal, key: "settings.general" },
  { id: "hosts", icon: Server, key: "settings.hosts" },
  { id: "agents", icon: Bot, key: "settings.agents" },
  { id: "extensions", icon: Puzzle, key: "settings.extensions" },
  { id: "advanced", icon: FileCog, key: "settings.advanced" },
];

const Row = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div className="grid grid-cols-[180px_minmax(0,1fr)] items-start gap-4 border-b border-border/50 py-3.5 last:border-b-0">
    <div>
      <div className="text-[12.5px] font-medium">{label}</div>
      {hint ? <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{hint}</div> : null}
    </div>
    <div className="flex min-w-0 flex-col items-start gap-1.5">{children}</div>
  </div>
);

const General = () => {
  const t = useT();
  const prefs = usePrefs((s) => s.prefs);
  const resolved = usePrefs((s) => s.resolved);
  const update = usePrefs((s) => s.update);
  const boot = useApp((s) => s.boot);
  const updateState = useUpdateState();
  const [cmd, setCmd] = useState(prefs?.skmCommand ?? "");
  useEffect(() => setCmd(prefs?.skmCommand ?? ""), [prefs?.skmCommand]);
  if (prefs === null) return null;

  const saveCmd = async () => {
    if (cmd.trim() === prefs.skmCommand) return;
    await update({ skmCommand: cmd.trim() });
    await boot();
  };

  return (
    <>
      <Row label={t("settings.language")}>
        <Segmented<Locale | "system">
          value={prefs.locale}
          onChange={(locale) => void update({ locale })}
          options={[{ value: "system", label: t("settings.language.system") }, { value: "en", label: "English" }, { value: "zh", label: "中文" }]}
        />
      </Row>
      <Row label={t("settings.theme")}>
        <Segmented<Theme>
          value={prefs.theme}
          onChange={(theme) => void update({ theme })}
          options={[{ value: "system", label: t("settings.theme.system") }, { value: "light", label: t("settings.theme.light") }, { value: "dark", label: t("settings.theme.dark") }]}
        />
      </Row>
      <Row label={t("settings.cli")} hint={t("settings.cliHint")}>
        <Input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onBlur={() => void saveCmd()}
          onKeyDown={(e) => { if (e.key === "Enter") void saveCmd(); }}
          placeholder="~/.local/bin/skm"
          spellCheck={false}
          className="h-7 font-mono text-[12px]"
        />
        <span className={cn("font-mono text-[11px]", resolved ? "text-muted-foreground" : "text-danger")}>{resolved ? t("settings.cliResolved", { cmd: resolved }) : t("settings.cliMissing")}</span>
      </Row>
      <Row label={t("settings.updates")} hint={t("about.autoHint")}>
        <div className="flex w-full flex-col gap-2.5">
          <label className="flex items-center gap-2 text-[12px]">
            <Switch size="sm" checked={prefs.autoUpdate} onCheckedChange={(v) => void update({ autoUpdate: v })} />
            {t("about.auto")}
          </label>
          <UpdateRow state={updateState} />
        </div>
      </Row>
    </>
  );
};

type DraftHost = {
  readonly key: string;
  /** id in config.yaml today; null for a host added in this draft */
  readonly from: string | null;
  readonly id: string;
  readonly ssh: string;
  readonly agents: readonly string[] | null;
  readonly skm: string;
};

const toDraft = (c: ConfigSummary): DraftHost[] => c.hostDetails.map((h) => ({ key: h.id, from: h.id, id: h.id, ssh: h.ssh ?? "", agents: h.agents, skm: h.skm }));
const draftSig = (d: readonly DraftHost[]) => JSON.stringify(d.map(({ from, id, ssh, agents, skm }) => [from, id, ssh, agents, skm]));

const HOST_COLS = "grid-cols-[20px_128px_minmax(0,1fr)_auto_24px_24px]";

const SortableHost = ({ h, agents, onChange, onRemove, canRemove }: { h: DraftHost; agents: readonly string[]; onChange: (h: DraftHost) => void; onRemove: () => void; canRemove: boolean }) => {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: h.key });
  const [more, setMore] = useState(false);
  const hub = h.ssh.trim() === "";
  const on = (a: string) => h.agents === null || h.agents.includes(a);
  const toggle = (a: string) => {
    const current = h.agents ?? agents;
    const next = current.includes(a) ? current.filter((x) => x !== a) : agents.filter((x) => x === a || current.includes(x));
    if (next.length === 0) return;
    onChange({ ...h, agents: next.length === agents.length ? null : next });
  };
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("rounded-md bg-background px-1.5 py-1.5", isDragging ? "relative z-10 shadow-[0_6px_18px_oklch(0_0_0/0.16)] ring-1 ring-border" : "")}
    >
      <div className={cn("grid items-center gap-2", HOST_COLS)}>
        <button type="button" className="flex cursor-grab items-center justify-center text-muted-foreground/70 hover:text-foreground active:cursor-grabbing" aria-label="drag" {...attributes} {...listeners}>
          <GripVertical className="size-3.5" />
        </button>
        <Input value={h.id} onChange={(e) => onChange({ ...h, id: e.target.value.trim() })} placeholder={t("settings.hostId")} className="h-7 text-[12.5px] font-medium" spellCheck={false} />
        <div className="relative min-w-0">
          <Input value={h.ssh} onChange={(e) => onChange({ ...h, ssh: e.target.value.trim() })} placeholder={hub ? "" : t("settings.sshPlaceholder")} className={cn("h-7 font-mono text-[12px] placeholder:text-muted-foreground/55", hub && "pr-14")} spellCheck={false} />
          {hub ? <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded-[4px] bg-info-soft px-1.5 text-[10.5px] leading-[18px] text-info">{t("settings.hub")}</span> : null}
        </div>
        <div className="flex flex-wrap gap-1">
          {agents.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => toggle(a)}
              title={t(agentKey(a))}
              className={cn("h-6 rounded-[4px] px-1.5 text-[11px] transition-[background-color,color,scale] active:scale-[0.95]", on(a) ? "bg-signal-soft text-signal" : "bg-foreground/[0.05] text-muted-foreground line-through")}
            >
              {t(agentKey(a))}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon-xs" aria-label={t("settings.more")} title={t("settings.more")} onClick={() => setMore(!more)} className={cn(more && "bg-accent")}>
          <ChevronDown className={cn("transition-transform", more && "rotate-180")} />
        </Button>
        <Button variant="ghost" size="icon-xs" disabled={!canRemove} aria-label={t("settings.removeHost", { host: h.id })} onClick={onRemove}>
          <Trash2 />
        </Button>
      </div>
      {more ? (
        <div className={cn("mt-1.5 grid items-center gap-2", HOST_COLS)}>
          <span />
          <span className="text-right text-[11px] text-muted-foreground">{t("settings.skmHome")}</span>
          <Input value={h.skm} onChange={(e) => onChange({ ...h, skm: e.target.value })} placeholder="~/.skm" className="h-7 font-mono text-[12px]" spellCheck={false} />
        </div>
      ) : null}
    </li>
  );
};

const Hosts = () => {
  const t = useT();
  const config = useApp((s) => s.config);
  const boot = useApp((s) => s.boot);
  const [draft, setDraft] = useState<DraftHost[]>(() => (config ? toDraft(config) : []));
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (config) setDraft(toDraft(config)); }, [config]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  if (config === null) return null;

  const dirty = draftSig(draft) !== draftSig(toDraft(config));
  const hubs = draft.filter((h) => h.ssh.trim() === "").length;
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = draft.findIndex((h) => h.key === e.active.id);
    const to = draft.findIndex((h) => h.key === e.over?.id);
    setDraft(arrayMove(draft, from, to));
  };
  const save = async () => {
    setSaving(true);
    const r = await skm.patchConfig({
      hosts: draft.map((h) => ({ ...(h.from !== null ? { from: h.from } : {}), id: h.id, ssh: h.ssh || null, agents: h.agents, skm: h.skm.trim() || "~/.skm" })),
    });
    setSaving(false);
    if (!r.ok) return void toast.error(errorText(r.error));
    toast.success(t("settings.saved"));
    await boot();
  };

  return (
    <div className="flex flex-col gap-3 py-3">
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">{t("settings.hostsHintFull")} {t("settings.hubHint")}</p>
      <div className={cn("grid gap-2 px-1.5 text-[11px] text-muted-foreground", HOST_COLS)}>
        <span /><span>{t("settings.hostId")}</span><span>{t("settings.ssh")}</span><span>{t("settings.hostAgents")}</span><span /><span />
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={draft.map((h) => h.key)} strategy={verticalListSortingStrategy}>
          <ul className="-mt-1 flex flex-col">
            {draft.map((h, i) => (
              <SortableHost
                key={h.key}
                h={h}
                agents={config.agents}
                canRemove={draft.length > 1}
                onChange={(n) => setDraft(draft.map((x, j) => (j === i ? n : x)))}
                onRemove={() => setDraft(draft.filter((_, j) => j !== i))}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {hubs !== 1 ? <p className="text-[11.5px] text-danger">{t("settings.hubHint")}</p> : null}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setDraft([...draft, { key: `new-${Date.now()}`, from: null, id: "", ssh: "", agents: null, skm: "~/.skm" }])}>
          <Plus />{t("settings.addHost")}
        </Button>
        <span className="flex-1" />
        {dirty ? <Button variant="ghost" size="sm" onClick={() => setDraft(toDraft(config))}>{t("common.cancel")}</Button> : null}
        <Button size="sm" disabled={!dirty || saving || hubs !== 1} onClick={() => void save()}>{saving ? t("common.saving") : t("common.save")}</Button>
      </div>
    </div>
  );
};

/** A text field that saves on blur or Enter, and shows the built-in value as placeholder. */
const SavingInput = ({ value, placeholder, onSave, className }: { value: string; placeholder: string; onSave: (v: string) => Promise<void>; className?: string }) => {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => { if (v.trim() !== value) void onSave(v.trim()); };
  return (
    <Input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setV(value); }}
      placeholder={placeholder}
      spellCheck={false}
      className={cn("h-7 font-mono text-[12px] placeholder:text-muted-foreground/45", className)}
    />
  );
};

const Agents = () => {
  const t = useT();
  const config = useApp((s) => s.config);
  const boot = useApp((s) => s.boot);
  if (config === null) return null;
  const catalog: readonly AgentInfo[] = config.agentCatalog ?? [];
  const patch = async (p: Parameters<typeof skm.patchConfig>[0]) => {
    const r = await skm.patchConfig(p);
    if (!r.ok) return void toast.error(errorText(r.error));
    toast.success(t("settings.saved"));
    await boot();
  };
  const toggle = (a: string, on: boolean) => {
    const next = catalog.map((x) => x.id).filter((x) => (x === a ? on : config.agents.includes(x)));
    if (next.length === 0) return Promise.resolve();
    return patch({ agents: next });
  };
  const setOverride = (a: AgentInfo, field: "dir" | "update", v: string) =>
    patch({ agentOverrides: { [a.id]: { dir: field === "dir" ? v || null : a.dir, update: field === "update" ? v || null : a.update } } });

  return (
    <div className="flex flex-col gap-3 py-3">
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">{t("settings.agentsHintFull")}</p>
      {catalog.map((a) => (
        <section key={a.id} className={cn("rounded-lg border border-border/80 px-3.5 py-3", !a.enabled && "opacity-70")}>
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">{a.name}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{t("settings.agentBin", { bin: a.bin })}</span>
            {a.extension !== null ? <span className="rounded bg-info-soft px-1.5 py-px text-[10.5px] text-info">{t("settings.fromExtension", { name: a.extension })}</span> : null}
            <span className="flex-1" />
            <span className="text-[11.5px] text-muted-foreground">{t("settings.agentEnabled")}</span>
            <Switch size="sm" checked={a.enabled} onCheckedChange={(on) => void toggle(a.id, on)} />
          </div>
          <div className="mt-2.5 grid grid-cols-[112px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
            <span className="text-[11.5px] text-muted-foreground">{t("settings.agentDir")}</span>
            <SavingInput value={a.dir ?? ""} placeholder={a.defaultDir} onSave={(v) => setOverride(a, "dir", v)} />
            <span className="text-[11.5px] text-muted-foreground">{t("settings.agentUpdate")}</span>
            <SavingInput value={a.update ?? ""} placeholder={a.defaultUpdate} onSave={(v) => setOverride(a, "update", v)} />
          </div>
        </section>
      ))}
    </div>
  );
};

const Extensions = () => {
  const t = useT();
  const config = useApp((s) => s.config);
  const boot = useApp((s) => s.boot);
  if (config === null) return null;
  const list = config.extensions ?? [];
  const toggle = async (name: string, on: boolean) => {
    const disabled = (config.disabledExtensions ?? []).filter((x) => x !== name).concat(on ? [] : [name]);
    const r = await skm.patchConfig({ disabledExtensions: disabled });
    if (!r.ok) return void toast.error(errorText(r.error));
    toast.success(t("settings.saved"));
    await boot();
  };
  const parts = (e: (typeof list)[number]): string =>
    [
      e.agents.length > 0 ? t("settings.extAgents", { list: e.agents.join(", ") }) : "",
      e.apps.length > 0 ? t("settings.extApps", { list: e.apps.join(", ") }) : "",
      e.tools.length > 0 ? t("settings.extTools", { list: e.tools.join(", ") }) : "",
    ].filter((x) => x !== "").join(" · ");
  return (
    <div className="flex flex-col gap-3 py-3">
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">{t("settings.extensionsHint")}</p>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground selectable">{config.extensionsDir}</span>
        <Button variant="outline" size="xs" onClick={() => void window.skm.openDir(config.extensionsDir)}>{t("settings.openExtensions")}</Button>
      </div>
      {list.map((e) => {
        const builtin = e.source === "builtin";
        const off = (config.disabledExtensions ?? []).includes(e.name);
        return (
          <section key={`${e.name}:${e.source}`} className={cn("rounded-lg border border-border/80 px-3.5 py-3", !e.enabled && "opacity-75")}>
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold">{e.name}</span>
              <span className="rounded bg-foreground/[0.06] px-1.5 py-px text-[10.5px] text-muted-foreground">{builtin ? t("settings.extBuiltin") : t("settings.extFile")}</span>
              <span className="flex-1" />
              {e.error === null || off ? <Switch size="sm" checked={!off} onCheckedChange={(on) => void toggle(e.name, on)} /> : null}
            </div>
            {!builtin ? <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground selectable">{e.source}</div> : null}
            {parts(e) !== "" ? <div className="mt-1.5 text-[12px]">{parts(e)}</div> : null}
            {e.error !== null ? <div className="mt-1.5 rounded-md bg-danger-soft px-2.5 py-1.5 font-mono text-[11px] text-danger selectable">{e.error}</div> : null}
          </section>
        );
      })}
    </div>
  );
};

const Advanced = () => {
  const t = useT();
  const config = useApp((s) => s.config);
  const reloadConfig = useApp((s) => s.reloadConfig);
  const [tokens, setTokens] = useState(String(config?.contextTokens ?? ""));
  useEffect(() => setTokens(String(config?.contextTokens ?? "")), [config?.contextTokens]);
  if (config === null) return null;
  const patch = async (p: Parameters<typeof skm.patchConfig>[0]) => {
    const r = await skm.patchConfig(p);
    if (!r.ok) return void toast.error(errorText(r.error));
    toast.success(t("settings.saved"));
    await reloadConfig();
  };
  const saveTokens = () => {
    const n = Number(tokens);
    if (!Number.isInteger(n) || n <= 0 || n === config.contextTokens) return setTokens(String(config.contextTokens));
    void patch({ contextTokens: n });
  };
  return (
    <>
      <Row label={t("settings.backup")} hint={t("settings.backupHint")}>
        <Switch checked={config.backupBeforeApply} onCheckedChange={(on) => void patch({ backupBeforeApply: on })} />
      </Row>
      <Row label={t("settings.contextTokens")} hint={t("settings.contextTokensHint")}>
        <Input value={tokens} inputMode="numeric" onChange={(e) => setTokens(e.target.value)} onBlur={saveTokens} onKeyDown={(e) => { if (e.key === "Enter") saveTokens(); }} className="h-7 w-32 tabular text-[12.5px]" />
      </Row>
      <Row label={t("settings.configFile")}>
        <span className="font-mono text-[11.5px] text-muted-foreground selectable">{config.configPath}</span>
        <div className="flex gap-1.5">
          <Button variant="outline" size="xs" onClick={() => void window.skm.openPath(config.configPath)}>{t("settings.openConfig")}</Button>
          <Button variant="ghost" size="xs" onClick={() => void window.skm.revealPath(config.configPath)}>{t("common.reveal")}</Button>
        </div>
      </Row>
      <Row label={t("settings.store")} hint={t("settings.storeHint")}>
        <SavingInput value={config.storeRaw ?? config.store} placeholder="~/.skm/skills" onSave={async (v) => { await patch({ store: v || "~/.skm/skills" }); await useApp.getState().boot(); }} />
        <Button variant="ghost" size="xs" onClick={() => void window.skm.revealPath(config.store)}>{t("common.reveal")}</Button>
      </Row>
    </>
  );
};

export const SettingsDialog = () => {
  const t = useT();
  const open = useApp((s) => s.settingsOpen);
  const setPanel = useApp((s) => s.setPanel);
  const [section, setSection] = useState<Section>("general");

  return (
    <Dialog open={open} onOpenChange={(o) => setPanel({ settingsOpen: o })}>
      <DialogContent className="grid h-[540px] max-h-[calc(100vh-4rem)] grid-cols-[176px_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-[820px]">
        <nav className="flex flex-col gap-px border-r border-border/70 bg-sidebar px-2 pt-4">
          <DialogTitle className="px-2.5 pb-3 text-[13px] font-semibold">{t("settings.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("settings.title")}</DialogDescription>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={cn("relative flex h-[30px] items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-[color,scale] active:scale-[0.98]", section === s.id ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {section === s.id ? <motion.span layoutId="settings-active" transition={{ duration: 0.16 }} className="absolute inset-0 rounded-md bg-sidebar-accent" /> : null}
              <s.icon className="relative size-[15px]" strokeWidth={1.75} />
              <span className="relative">{t(s.key)}</span>
            </button>
          ))}
        </nav>
        <div className="min-h-0 overflow-y-auto px-6 pt-4 pb-6">
          <h2 className="pb-1 text-[15px] font-semibold">{t(SECTIONS.find((s) => s.id === section)?.key ?? "settings.general")}</h2>
          {section === "general" ? <General /> : section === "hosts" ? <Hosts /> : section === "agents" ? <Agents /> : section === "extensions" ? <Extensions /> : <Advanced />}
        </div>
      </DialogContent>
    </Dialog>
  );
};
