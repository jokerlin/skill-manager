import pc from "picocolors";
import { type TrimKind, fallbackContext, simulateListing, trimText } from "../core/budget";
import { type Finding, driftFindings, findingText } from "../core/effective";
import { allInsights } from "../core/heuristics";
import { isDesired } from "../core/scope";
import { buildHostView } from "../core/view";
import { agentsOn } from "../shell/hosts";
import { hostErrorText, readInventoryCache } from "../shell/probe";
import { out, table, withApp } from "./common";
import { type HostSnapshot, snapshotHosts } from "./status";
import { planFor } from "../shell/hosts";

export type DoctorOpts = { json?: boolean; cached?: boolean; host?: string };

/** All numbers in tokens by the agent's own accounting (see core/budget.ts). */
type BudgetRow = { host: string; agent: string; skills: number; usedTokens: number; budgetTokens: number | null; droppedCount: number; overBy: number; source: "effective" | "config-only"; window: string; trim: TrimKind };

/** "1000000 tokens × 3 chars/token × 1% (fable → claude-fable-5-1, native 1M, 3 chars/token)" — only Claude has a model-derived window. */
const windowText = (b: { agentId: string; context: { contextTokens: number; bytesPerToken: number; reason: string } } | undefined): string =>
  b === undefined ? "" : b.agentId === "claude" ? `${b.context.contextTokens} tokens × ${b.context.bytesPerToken} chars/token (${b.context.reason})` : `${b.context.contextTokens} tokens (${b.context.reason})`;

/** Budget per host × agent over the effective inventory; falls back to the config-only (store) estimate for unreachable hosts. */
const budgetRows = (app: Parameters<Parameters<typeof withApp>[0]>[0], snaps: readonly HostSnapshot[]): BudgetRow[] =>
  app.config.hosts.flatMap((h) =>
    agentsOn(app.config, h).map((a): BudgetRow => {
      const snap = snaps.find((s) => s.host.id === h.id);
      if (snap?.result.ok) {
        const b = snap.result.view.budget[a.id];
        const es = snap.result.view.effective[a.id] ?? [];
        return { host: h.id, agent: a.id, skills: es.length, usedTokens: b?.usedTokens ?? 0, budgetTokens: b && Number.isFinite(b.budgetTokens) ? b.budgetTokens : null, droppedCount: b?.droppedCount ?? 0, overBy: b?.overBy ?? 0, source: "effective", window: windowText(b), trim: b?.trim ?? "dropped" };
      }
      const linked = app.skills.filter((s) => isDesired(app.config, s.name, h.id, a.id));
      const ctx = fallbackContext(a, app.config.contextTokens, "host not probed → config contextTokens");
      const r = simulateListing(a, linked, ctx, a.id === "claude" ? app.claudeOverrides : {});
      return { host: h.id, agent: a.id, skills: linked.length, usedTokens: r.usedTokens, budgetTokens: Number.isFinite(r.budgetTokens) ? r.budgetTokens : null, droppedCount: r.droppedCount, overBy: r.overBy, source: "config-only", window: windowText(r), trim: r.trim };
    }),
  );

/** Snapshots from the on-disk probe cache (no ssh), for `doctor --cached`. */
const cachedSnapshots = async (app: Parameters<Parameters<typeof withApp>[0]>[0], only?: string): Promise<HostSnapshot[]> =>
  Promise.all(
    app.config.hosts.filter((h) => only === undefined || h.id === only).map(async (host): Promise<HostSnapshot> => {
      const inv = await readInventoryCache(app.skmHome, host.id);
      if (inv === undefined) return { host, result: { ok: false, error: { kind: "unreachable", host: host.id, detail: "no cached probe; run skm status" } } };
      const agents = agentsOn(app.config, host);
      return { host, result: { ok: true, inventory: inv, ops: planFor(app.config, app.skills, host, inv, app.hubMarketplaces), view: buildHostView(host.id, agents, inv, app.config.contextTokens, app.claudeOverrides) } };
    }),
  );

const findingColor = (f: Finding): string => {
  switch (f.kind) {
    case "same-name": return pc.yellow(f.kind);
    case "linked-twice": return pc.yellow(f.kind);
    case "shadowed": return pc.dim(f.kind);
    case "same-content": return pc.magenta(f.kind);
    case "version-drift": return pc.red(f.kind);
    case "stale-cache": return pc.dim(f.kind);
    case "disabled-cached": return pc.dim(f.kind);
    case "unloaded-cache": return pc.dim(f.kind);
    case "owned-drift": return pc.yellow(f.kind);
  }
};

export const runDoctor = async (o: DoctorOpts = {}): Promise<void> =>
  withApp(async (app) => {
    const insights = allInsights(app.skills);
    const snaps = o.cached ? await cachedSnapshots(app, o.host) : await snapshotHosts(app, o.host);
    const budget = budgetRows(app, snaps);
    const hostFindings = snaps.flatMap((s) => (s.result.ok ? s.result.view.findings : []));
    const drift = driftFindings(snaps.flatMap((s) => (s.result.ok ? [{ host: s.host.id, states: s.result.view.states }] : [])));
    const findings = [...drift, ...hostFindings];
    const unreachable = snaps.filter((s) => !s.result.ok);
    if (o.json) {
      return out(JSON.stringify({
        store: app.storeDir, skillCount: app.skills.length, contextTokens: app.config.contextTokens,
        budget, insights,
        findings: findings.map((f) => ({ kind: f.kind, text: findingText(f), ...("host" in f ? { host: f.host } : {}), ...("agent" in f ? { agent: f.agent } : {}), ...(f.kind === "owned-drift" ? { agents: f.agents } : {}) })),
        unreachable: unreachable.map((s) => ({ host: s.host.id, error: s.result.ok ? "" : hostErrorText(s.result.error) })),
      }, null, 2));
    }
    out(pc.bold(`store: ${app.storeDir}  ·  ${app.skills.length} skills${app.ignoredDirs.length > 0 ? pc.dim(`  ·  ignored (no SKILL.md): ${app.ignoredDirs.join(" ")}`) : ""}`));
    unreachable.forEach((s) => out(pc.yellow(`${s.host.id}: ${s.result.ok ? "" : hostErrorText(s.result.error)} — budget below is the config-only estimate`)));
    out("");
    out(pc.bold("startup context per host × agent (listing = name + description of every skill the agent loads: user dir, legacy dir, builtins, enabled plugins)"));
    const rows = budget.map((r) => {
      const verdict = r.budgetTokens === null ? pc.dim("no documented budget") : r.overBy > 0 ? pc.red(`over by ${r.overBy}t → ${trimText(r)}`) : pc.green("fits");
      return [r.host, r.agent, String(r.skills), `${r.usedTokens}t`, r.budgetTokens === null ? "—" : `${r.budgetTokens}t`, verdict, r.source === "effective" ? "" : pc.dim("config-only")];
    });
    out(table(["host", "agent", "skills", "listing", "budget", "verdict", ""], rows));
    budget.filter((r) => (r.agent === "claude" || r.agent === "codex") && r.window !== "").forEach((r) => out(pc.dim(`  ${r.host}/${r.agent}: window ${r.window}`)));
    out(pc.dim(`All numbers are tokens by each agent's own accounting. Claude: 1% of its model window (from each host's ~/.claude/settings.json model/env); Claude Code counts chars of "- name: desc" at 4 chars/token for Opus/Sonnet ≤4.6 and Haiku, else 3 — shown ÷ that; its own bundled skills are not counted. Codex: 2% of its model window (config.toml model → ~/.codex/models_cache.json context_window, or model_context_window), ⌈bytes/4⌉ per "- name: desc (file: rN/path)" line plus the skill-roots table, or [skills] max_context_tokens (≤ 10,000); over budget it shortens every description before omitting any skill. Others: o200k estimate, no documented budget. config contextTokens (${app.config.contextTokens}) is the fallback window when a model is unknown.`));
    out("");
    if (findings.length > 0) {
      out(pc.bold(`${findings.length} cross-source findings`));
      findings.forEach((f) => out(`  ${findingColor(f)}  ${findingText(f)}`));
      out("");
    }
    if (insights.length === 0) return out(pc.green("no store findings"));
    out(pc.bold(`${insights.length} store findings`));
    const byKind = insights.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {});
    out(pc.dim(Object.entries(byKind).map(([k, n]) => `${k}: ${n}`).join("  ")));
    insights.forEach((i) => out(`  ${i.kind === "spec-violation" ? pc.red(i.kind) : i.kind === "duplicate" ? pc.magenta(i.kind) : pc.yellow(i.kind)}  ${pc.bold(i.skill)}  ${i.detail}`));
  });
