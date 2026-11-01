import pc from "picocolors";
import { type Cell, PLUGIN_AGENTS } from "../core/config";
import { isMutation, opText } from "../core/plan";
import { pluginRows, pluginUpdateOps } from "../core/pluginUpdate";
import { pluginWanted, setPluginScope, splitPluginId } from "../core/scope";
import type { AppState } from "../shell/app";
import { agentsOn } from "../shell/hosts";
import { hostErrorText } from "../shell/probe";
import { applyJobs, humanSink, jsonSink } from "./apply";
import { confirm, die, out, saveConfig, table, withApp } from "./common";
import { type HostSnapshot, snapshotHosts } from "./status";

/**
 * Hosts that run Claude or Codex but have no probe result. A plugin's first policy copies today's enabled cells so a
 * flip changes only one cell; a host skm knows nothing about would get no cells, and the next apply would switch the
 * plugin off there. Pure.
 */
export const unprobedPluginHosts = (app: AppState, snaps: readonly HostSnapshot[]): readonly string[] =>
  snaps.filter((s) => !s.result.ok && agentsOn(app.config, s.host).some((a) => PLUGIN_AGENTS.includes(a.id))).map((s) => s.host.id);

const okSnaps = (snaps: readonly HostSnapshot[]) =>
  snaps.flatMap((s) => (s.result.ok ? [{ host: s.host.id, states: s.result.view.states, facts: s.result.view.facts }] : []));

/** `skm plugins`: every plugin any agent has configured, across hosts × agents, with versions, drift and the config policy. */
export const runPlugins = async (o: { json: boolean; cached: boolean; host?: string }): Promise<void> =>
  withApp(async (app) => {
    const snaps = await snapshotHosts(app, o.host, { cached: o.cached });
    const rows = pluginRows(okSnaps(snaps));
    const grid = app.config.hosts.flatMap((h) => agentsOn(app.config, h).filter((a) => PLUGIN_AGENTS.includes(a.id)).map((a) => ({ host: h.id, agent: a.id })));
    const names = [...new Set([...rows.map((r) => r.name), ...app.config.plugins.map((p) => p.name)])].sort();
    const json = names.map((name) => {
      const row = rows.find((r) => r.name === name);
      const policy = app.config.plugins.find((p) => p.name === name);
      return {
        name,
        ids: row?.ids ?? [],
        versions: row?.versions ?? [],
        drift: row?.drift ?? false,
        policy: policy === undefined ? null : { enabled: policy.enabled, marketplace: policy.marketplace },
        cells: grid.map((g) => {
          const c = row?.cells.find((x) => x.host === g.host && x.agent === g.agent);
          return { ...g, enabled: c?.enabled ?? null, version: c?.version ?? null, scopes: c?.scopes ?? [], skills: c?.skills ?? [], marketplace: c?.marketplace ?? null, source: c?.source ?? null, wanted: policy === undefined ? null : pluginWanted(policy, g.host, g.agent) };
        }),
      };
    });
    if (o.json) return out(JSON.stringify({ hosts: snaps.map((s) => ({ host: s.host.id, reachable: s.result.ok, probedAt: s.probedAt || null, error: s.result.ok ? null : hostErrorText(s.result.error) })), grid, plugins: json }, null, 2));
    snaps.filter((s) => !s.result.ok).forEach((s) => out(pc.yellow(s.result.ok ? "" : hostErrorText(s.result.error))));
    out(table(["plugin", ...grid.map((g) => `${g.host}/${g.agent}`)], json.map((p) => [
      p.drift ? pc.red(p.name) : p.policy ? pc.green(p.name) : p.name,
      ...p.cells.map((c) => (c.version === null ? (c.wanted ? pc.yellow("missing") : pc.dim("·")) : c.enabled === "off" ? pc.dim(`off ${c.version}`) : p.drift ? pc.red(c.version) : c.version)),
    ])));
    out(pc.dim("red = active versions differ across hosts/agents (`skm plugin update <name>`) · green = declared under plugins: in config.yaml"));
  });

/** `skm plugin update [names…]`: refresh marketplaces and update the plugins on every selected host, with a backup first. */
export const runPluginUpdate = async (names: readonly string[], o: { host?: string; agent?: string; yes: boolean; events: boolean; backup: boolean; dryRun: boolean }): Promise<void> =>
  withApp(async (app) => {
    const sink = o.events ? jsonSink : humanSink;
    const say = o.events ? () => undefined : out;
    const snaps = await snapshotHosts(app, o.host);
    const target = { plugins: [...names], agents: o.agent === undefined ? [] : [o.agent] };
    const jobs = snaps.flatMap((s) => {
      if (!s.result.ok) {
        if (o.events) sink({ type: "host-done", host: s.host.id, ok: false, rsynced: 0, applied: 0, commandsOk: 0, commandsFailed: 0, failures: [], error: `${hostErrorText(s.result.error)} — skipped` });
        say(`${pc.bold(s.host.id)}: ${pc.red(hostErrorText(s.result.error))} — skipped`);
        return [];
      }
      const ops = pluginUpdateOps(s.host.id, s.result.view.states, s.result.view.facts, s.result.inventory.tools, target);
      say(pc.bold(`${s.host.id}: ${ops.filter(isMutation).length} commands`));
      ops.forEach((op) => say(`  ${op.op === "blocked" ? pc.yellow(opText(op)) : opText(op)}`));
      return ops.some(isMutation) ? [{ host: s.host, ops }] : [];
    });
    if (jobs.length === 0) {
      if (o.events) sink({ type: "verified", pending: [] });
      return say(pc.green("\nnothing to update"));
    }
    if (o.dryRun) return say(pc.dim("\n(dry run — nothing changed)"));
    if (!o.yes && (o.events || !confirm(`\nupdate on ${jobs.map((j) => j.host.id).join(", ")}?`))) return say("aborted");
    await applyJobs(app, jobs, { backup: o.backup, replaceConflicts: false }, sink);
    // re-probe so the cache (and the app) see the new versions; report hosts where the plugin still drifts
    const after = await snapshotHosts(app, o.host);
    const rows = pluginRows(okSnaps(after)).filter((r) => r.drift && (names.length === 0 || names.includes(r.name) || r.ids.some((id) => names.includes(id))));
    sink({ type: "verified", pending: rows.map((r) => `${r.name} ${r.versions.join(" / ")}`) });
  });

/** `skm scope --plugin <plugin> <host>/<agent> on|off`: cells where the plugin is enabled today seed a policy the config does not have yet. */
export const runPluginScope = async (plugin: string, cell: Cell, on: boolean): Promise<void> =>
  withApp(async (app) => {
    const { name } = splitPluginId(plugin);
    const known = app.config.plugins.some((p) => p.name === name);
    if (!known && splitPluginId(plugin).marketplace === "") return die(`${plugin} is not under plugins: in config.yaml; pass name@marketplace`);
    const snaps = known ? [] : await snapshotHosts(app, undefined, { cached: true });
    const unprobed = unprobedPluginHosts(app, snaps);
    if (unprobed.length > 0) return die(`${name} is not under plugins: yet, so skm copies where it is enabled today; it has no probe result for ${unprobed.join(", ")}. Run \`skm status ${unprobed.join(" ")}\`, then try again`);
    const active: Cell[] = known ? [] : okSnaps(snaps).flatMap((h) =>
      Object.entries(h.states).flatMap(([agent, ps]) => (ps.some((p) => p.name === name && p.enabled === "on") ? [{ host: h.host, agent }] : [])));
    const next = setPluginScope(app.config, plugin, cell.host, cell.agent, on, active);
    if (next !== app.config) await saveConfig(app.configPath, next);
    const policy = next.plugins.find((p) => p.name === name);
    out(`${pc.green("ok")} plugin ${name} ${cell.host}/${cell.agent} → ${policy !== undefined && pluginWanted(policy, cell.host, cell.agent) ? "on" : "off"}`);
  });
