import pc from "picocolors";
import type { HostConfig } from "../core/config";
import type { Effective, PluginState } from "../core/effective";
import { findingText } from "../core/effective";
import type { Entry, Inventory } from "../core/inventory";
import { type Op, isMutation, opText } from "../core/plan";
import { sourceText, storageText } from "../core/sources";
import { type HostView, activePluginsText, buildHostView } from "../core/view";
import type { AppState } from "../shell/app";
import { agentsOn, desiredOn, planFor, runnerFor } from "../shell/hosts";
import { type HostError, hostErrorText, probeHost, writeInventoryCache } from "../shell/probe";
import { out, table, withApp } from "./common";

export type HostSnapshot = {
  readonly host: HostConfig;
  readonly result: { ok: true; inventory: Inventory; ops: Op[]; view: HostView } | { ok: false; error: HostError };
};

/** Probe every selected host in parallel, plan each, and derive the effective view. Successful probes are cached under ~/.skm/cache/inventory/. */
export const snapshotHosts = async (app: AppState, only?: string): Promise<HostSnapshot[]> =>
  Promise.all(
    app.config.hosts
      .filter((h) => only === undefined || h.id === only)
      .map(async (host): Promise<HostSnapshot> => {
        const agents = agentsOn(app.config, host);
        const inv = await probeHost(host, agents, runnerFor(host));
        if (!inv.ok) return { host, result: { ok: false as const, error: inv.error } };
        await writeInventoryCache(app.skmHome, host.id, inv.value);
        return { host, result: { ok: true as const, inventory: inv.value, ops: planFor(app.config, app.skills, host, inv.value, app.hubMarketplaces), view: buildHostView(host.id, agents, inv.value, app.config.contextTokens, app.claudeOverrides) } };
      }),
  );

const glyph = (e: Entry): string => {
  switch (e.kind) {
    case "managed": return e.direct ? pc.green("●") : pc.cyan("◐");
    case "dir": return pc.yellow("▣");
    case "foreign-link": return pc.magenta("↗");
    case "broken-link": return pc.red("✗");
    case "file": return pc.dim("·");
  }
};

const consumedList = (entries: readonly Entry[]): string =>
  entries.filter((e) => e.kind !== "file").map((e) => `${glyph(e)}${e.name}`).join(" ");

export const effectiveJson = (e: Effective) => ({
  name: e.name,
  source: e.source.kind,
  sourceText: sourceText(e.source),
  storage: storageText(e.storage),
  owner: e.owner,
  path: e.path,
  version: e.version.some ? e.version.value : null,
  enabled: e.enabled,
  listingChars: e.listingChars,
  bodyTokens: e.bodyTokens,
  hash: e.hash.slice(0, 8),
  listing: e.listing,
  plugin: e.source.kind === "plugin" ? e.source.plugin : null,
  marketplace: e.source.kind === "plugin" ? e.source.marketplace : null,
  dir: e.source.kind === "legacy" ? e.source.dir : null,
});

export const pluginJson = (p: PluginState) => ({
  id: p.id,
  name: p.name,
  marketplace: p.marketplace,
  enabled: p.enabled,
  version: p.active.some ? p.active.value.version : null,
  dir: p.active.some ? p.active.value.dir : null,
  skills: p.active.some ? p.active.value.skills : [],
  cachedVersions: p.cachedVersions,
});

export const budgetJson = (b: HostView["budget"][string] | undefined) =>
  b === undefined ? null : { usedChars: b.usedChars, budgetChars: Number.isFinite(b.budgetChars) ? b.budgetChars : null, droppedCount: b.droppedCount, overBy: b.overBy, note: b.note };

/** What an agent on a host actually loads. v1 fields kept; v2 adds effective/plugins/budget/tools/findings. */
export const consumedJson = (snap: HostSnapshot, app: AppState) => {
  if (!snap.result.ok) return { host: snap.host.id, reachable: false, error: hostErrorText(snap.result.error) };
  const { inventory: inv, ops, view } = snap.result;
  const desired = desiredOn(app.config, app.skills, snap.host);
  return {
    host: snap.host.id,
    reachable: true,
    home: inv.home,
    store: inv.storeSkills.map((s) => s.name),
    remoteOnly: ops.flatMap((o) => (o.op === "remote-only" ? [o.skill] : [])),
    tools: inv.tools,
    agents: Object.fromEntries(
      agentsOn(app.config, snap.host).map((a) => {
        const d = inv.agentDirs[a.id];
        const entries = (d?.entries ?? []).filter((e) => e.kind !== "file");
        return [
          a.id,
          {
            dir: a.userDir(inv.home),
            exists: d?.exists ?? false,
            consumed: entries.map((e) => ({ name: e.name, kind: e.kind, ...(e.kind === "foreign-link" || e.kind === "broken-link" ? { target: e.target } : {}) })),
            desired: desired[a.id] ?? [],
            alsoReads: Object.fromEntries(a.alsoReads.map((f) => [f(inv.home), (inv.alsoReads[a.id] ?? []).filter((e) => e.kind !== "file").map((e) => e.name)])),
            effective: (view.effective[a.id] ?? []).map(effectiveJson),
            counts: view.counts[a.id] ?? { user: 0, legacy: 0, builtin: 0, plugin: 0 },
            plugins: (view.states[a.id] ?? []).map(pluginJson),
            budget: budgetJson(view.budget[a.id]),
          },
        ];
      }),
    ),
    drift: ops.filter((o) => o.op !== "remote-only").map(opText),
    findings: view.findings.map((f) => ({ kind: f.kind, text: findingText(f) })),
    configErrors: view.facts.errors,
  };
};

const budgetText = (b: HostView["budget"][string] | undefined): string => {
  if (b === undefined) return "";
  if (!Number.isFinite(b.budgetChars)) return pc.dim(`${b.usedChars}c`);
  return b.overBy > 0 ? pc.red(`${b.usedChars}c / ${b.budgetChars}c  over by ${b.overBy}c (~${b.droppedCount} dropped)`) : pc.green(`${b.usedChars}c / ${b.budgetChars}c fits`);
};

const sourcesText = (view: HostView, agent: string): string => {
  const c = view.counts[agent];
  if (!c) return "";
  const plugins = activePluginsText(view.states[agent] ?? [], 3);
  return [
    `user ${c.user}`,
    ...(c.legacy > 0 ? [pc.dim(`legacy ${c.legacy}`)] : []),
    ...(c.builtin > 0 ? [pc.dim(`builtin ${c.builtin}`)] : []),
    ...(c.plugin > 0 ? [`plugin ${c.plugin}${plugins.length > 0 ? pc.dim(` (${plugins})`) : ""}`] : []),
  ].join(" · ");
};

export const runStatus = async (o: { host?: string; json: boolean }): Promise<void> =>
  withApp(async (app) => {
    const snaps = await snapshotHosts(app, o.host);
    if (o.json) return out(JSON.stringify(snaps.map((s) => consumedJson(s, app)), null, 2));
    snaps.forEach((snap) => {
      if (!snap.result.ok) return out(`${pc.bold(snap.host.id)}  ${pc.red("unreachable")}  ${pc.dim(hostErrorText(snap.result.error))}\n`);
      const { inventory: inv, ops, view } = snap.result;
      const mutations = ops.filter(isMutation);
      const conflicts = ops.filter((o) => o.op === "conflict");
      const blocked = ops.filter((o) => o.op === "blocked");
      const remoteOnly = ops.flatMap((o) => (o.op === "remote-only" ? [o.skill] : []));
      const tools = Object.keys(inv.tools);
      out(`${pc.bold(snap.host.id)}  ${pc.dim(inv.home)}  store:${inv.storeSkills.length}  ${mutations.length === 0 ? pc.green("in sync") : pc.yellow(`${mutations.length} pending ops`)}${conflicts.length > 0 ? pc.red(`  ${conflicts.length} conflicts`) : ""}${blocked.length > 0 ? pc.yellow(`  ${blocked.length} blocked`) : ""}${remoteOnly.length > 0 ? pc.magenta(`  ${remoteOnly.length} remote-only`) : ""}  ${pc.dim(`tools: ${tools.length > 0 ? tools.join(" ") : "none"}`)}`);
      const rows = agentsOn(app.config, snap.host).map((a) => {
        const d = inv.agentDirs[a.id];
        const entries = (d?.entries ?? []).filter((e) => e.kind !== "file");
        return [a.id, d?.exists ? String(entries.length) : pc.dim("absent"), sourcesText(view, a.id), budgetText(view.budget[a.id]), consumedList(entries)];
      });
      out(table(["agent", "n", "loads (all sources)", "listing / budget", "user dir"], rows));
      if (remoteOnly.length > 0) out(pc.magenta(`  remote-only in store: ${remoteOnly.join(" ")}`));
      conflicts.forEach((c) => out(pc.red(`  ${opText(c)}`)));
      blocked.forEach((b) => out(pc.yellow(`  ${opText(b)}`)));
      view.facts.errors.forEach((e) => out(pc.yellow(`  config parse: ${e}`)));
      out("");
    });
    out(pc.dim("● direct link to store  ◐ link resolving into store via another link  ▣ real dir (unmanaged)  ↗ link elsewhere  ✗ broken link  ·  `skm inventory` lists every source per agent"));
  });
