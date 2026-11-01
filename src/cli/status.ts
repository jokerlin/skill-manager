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
import { type HostError, clearProbeError, hostErrorText, probeHost, readInventoryCacheEntry, readProbeError, writeInventoryCache, writeProbeError } from "../shell/probe";
import { trimText } from "../core/budget";
import { out, table, withApp } from "./common";

export type HostSnapshot = {
  readonly host: HostConfig;
  readonly result: { ok: true; inventory: Inventory; ops: Op[]; view: HostView } | { ok: false; error: HostError };
  /** when the inventory was probed (ISO 8601); "" when unknown */
  readonly probedAt: string;
  /** set when this snapshot came from the cache and the last live probe after it failed */
  readonly lastError?: { readonly at: string; readonly error: string };
};

const snapshotOf = (app: AppState, host: HostConfig, inv: Inventory, probedAt: string): HostSnapshot => {
  const agents = agentsOn(app.config, host);
  return { host, probedAt, result: { ok: true as const, inventory: inv, ops: planFor(app.config, app.skills, host, inv, app.hubMarketplaces), view: buildHostView(host.id, agents, inv, app.config.contextTokens, app.claudeOverrides, app.config.owned) } };
};

/**
 * Probe every selected host in parallel, plan each, and derive the effective view. Successful probes are cached under ~/.skm/cache/inventory/.
 * `cached`: read that cache instead of probing (no ssh); a host never probed comes back unreachable.
 */
export const snapshotHosts = async (app: AppState, only?: string, opts: { readonly cached?: boolean } = {}): Promise<HostSnapshot[]> =>
  Promise.all(
    app.config.hosts
      .filter((h) => only === undefined || h.id === only)
      .map(async (host): Promise<HostSnapshot> => {
        if (opts.cached) {
          const [entry, lastError] = await Promise.all([readInventoryCacheEntry(app.skmHome, host.id), readProbeError(app.skmHome, host.id)]);
          if (entry === undefined) return { host, probedAt: "", result: { ok: false, error: { kind: "unreachable", host: host.id, detail: lastError?.error ?? "no cached probe; run skm status" } } };
          const snap = snapshotOf(app, host, entry.inventory, entry.at);
          return lastError !== undefined && lastError.at > entry.at ? { ...snap, lastError } : snap;
        }
        const inv = await probeHost(host, agentsOn(app.config, host), app.config.owned, runnerFor(host));
        if (!inv.ok) {
          await writeProbeError(app.skmHome, host.id, inv.error);
          return { host, probedAt: "", result: { ok: false as const, error: inv.error } };
        }
        await Promise.all([writeInventoryCache(app.skmHome, host.id, inv.value), clearProbeError(app.skmHome, host.id)]);
        return snapshotOf(app, host, inv.value, new Date().toISOString());
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
  promptVisible: e.promptVisible,
  listingChars: e.listingChars,
  listingTokens: e.listingTokens,
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
  b === undefined ? null : { usedTokens: b.usedTokens, budgetTokens: Number.isFinite(b.budgetTokens) ? b.budgetTokens : null, droppedCount: b.droppedCount, overBy: b.overBy, note: b.note, context: b.context, trim: b.trim };

/** What an agent on a host actually loads. v1 fields kept; v2 adds effective/plugins/budget/tools/findings. */
export const consumedJson = (snap: HostSnapshot, app: AppState) => {
  const ssh = snap.host.ssh.some ? snap.host.ssh.value : null;
  if (!snap.result.ok) return { host: snap.host.id, ssh, reachable: false, error: hostErrorText(snap.result.error), probedAt: snap.probedAt || null };
  const { inventory: inv, ops, view } = snap.result;
  const desired = desiredOn(app.config, app.skills, snap.host);
  return {
    host: snap.host.id,
    ssh,
    reachable: true,
    probedAt: snap.probedAt || null,
    ...(snap.lastError !== undefined ? { lastError: snap.lastError } : {}),
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
  if (!Number.isFinite(b.budgetTokens)) return pc.dim(`${b.usedTokens}t`);
  return b.overBy > 0 ? pc.red(`${b.usedTokens}t / ${b.budgetTokens}t  over by ${b.overBy}t (${trimText(b)})`) : pc.green(`${b.usedTokens}t / ${b.budgetTokens}t fits`);
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

export const runStatus = async (o: { host?: string; json: boolean; cached?: boolean }): Promise<void> =>
  withApp(async (app) => {
    const snaps = await snapshotHosts(app, o.host, { cached: o.cached === true });
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
