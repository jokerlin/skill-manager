import { none } from "../lib/result";
import type { HostFacts, PluginState } from "./effective";
import type { Op } from "./plan";

/** Which plugins `skm plugin update` touches: names or `name@marketplace` ids (empty = every enabled plugin), optionally limited to some agents. */
export type UpdateTarget = { readonly plugins: readonly string[]; readonly agents: readonly string[] };

const matches = (t: UpdateTarget, p: PluginState): boolean =>
  (t.plugins.length === 0 || t.plugins.includes(p.name) || t.plugins.includes(p.id)) && (t.agents.length === 0 || t.agents.includes(p.agent));

/**
 * Ops that bring every enabled, installed plugin matched by `target` on one host to its marketplace's newest version. Pure.
 * - Claude: refresh each marketplace, then `claude plugin update` once per install record (user / project / local scope).
 * - Codex: refresh Git marketplaces (a local-dir marketplace is read live, `upgrade` only knows Git ones), then re-add the plugin.
 * A missing agent CLI makes each matched plugin `blocked` on that host.
 */
export const pluginUpdateOps = (
  host: string, states: Readonly<Record<string, readonly PluginState[]>>, facts: HostFacts, tools: Readonly<Record<string, string>>, target: UpdateTarget,
): Op[] =>
  Object.entries(states).flatMap(([agent, ps]): Op[] => {
    const picked = ps.filter((p) => p.enabled === "on" && p.active.some && matches(target, p));
    if (picked.length === 0) return [];
    if (tools[agent] === undefined) return picked.map((p): Op => ({ op: "blocked", host, agent, what: `plugin ${p.id}`, reason: `${agent} CLI not found on ${host}` }));
    const marketplaces = [...new Set(picked.map((p) => p.marketplace))].sort();
    const refresh = marketplaces
      .filter((m) => agent !== "codex" || facts.codex.marketplaces[m]?.kind === "portable")
      .map((marketplace): Op => ({ op: "marketplace-refresh", host, agent, marketplace }));
    const updates = picked.flatMap((p): Op[] => {
      const from = p.active.some ? p.active.value.version : "";
      if (agent !== "claude") return [{ op: "plugin-update", host, agent, plugin: p.id, scope: "user", projectPath: none, from }];
      const installs = facts.claudeInstalled[p.id]?.installs ?? [];
      return (installs.length > 0 ? installs : [{ scope: "user", projectPath: none, version: from }])
        .map((i): Op => ({ op: "plugin-update", host, agent, plugin: p.id, scope: i.scope, projectPath: i.projectPath, from: i.version }));
    });
    return [...refresh, ...updates];
  });

/** One plugin's state in one (host, agent) cell, for the cross-host plugin matrix. */
export type PluginCellState = {
  readonly host: string;
  readonly agent: string;
  readonly enabled: "on" | "off";
  readonly version: string | null;
  readonly scopes: readonly string[];
  readonly skills: readonly string[];
  readonly marketplace: string;
  /** where that marketplace comes from on this host: git/url (`skm plugin update` refreshes it), a local dir (read live), or not configured */
  readonly source: "portable" | "local-dir" | "unknown";
};

/** A plugin across every host × agent, with the newest active version and whether the active ones differ. */
export type PluginRow = {
  readonly name: string;
  readonly ids: readonly string[];
  readonly cells: readonly PluginCellState[];
  readonly versions: readonly string[];
  readonly drift: boolean;
};

/** Group per-host plugin states into one row per plugin name (Claude and Codex can install the same plugin from different marketplaces). Pure. */
export const pluginRows = (
  perHost: readonly { readonly host: string; readonly states: Readonly<Record<string, readonly PluginState[]>>; readonly facts: HostFacts }[],
): PluginRow[] => {
  const cells = perHost.flatMap((h) =>
    Object.entries(h.states).flatMap(([agent, ps]) =>
      ps.filter((p) => p.configured).map((p) => ({
        name: p.name,
        id: p.id,
        cell: {
          host: h.host, agent, enabled: p.enabled,
          version: p.active.some ? p.active.value.version : null,
          scopes: agent === "claude" ? (h.facts.claudeInstalled[p.id]?.installs ?? []).map((i) => i.scope) : p.active.some ? ["user"] : [],
          skills: p.active.some ? p.active.value.skills : [],
          marketplace: p.marketplace,
          source: (agent === "claude" ? h.facts.claudeMarketplaces[p.marketplace] : agent === "codex" ? h.facts.codex.marketplaces[p.marketplace] : undefined)?.kind ?? "unknown",
        } satisfies PluginCellState,
      })),
    ),
  );
  const names = [...new Set(cells.map((c) => c.name))].sort();
  return names.map((name) => {
    const mine = cells.filter((c) => c.name === name);
    const active = mine.filter((c) => c.cell.enabled === "on" && c.cell.version !== null).map((c) => c.cell.version as string);
    const versions = [...new Set(active)].sort();
    return { name, ids: [...new Set(mine.map((c) => c.id))].sort(), cells: mine.map((c) => c.cell), versions, drift: versions.length > 1 };
  });
};
