import { mkdir, readFile, writeFile } from "node:fs/promises";
import pc from "picocolors";
import type { HostConfig } from "../core/config";
import { type HarnessMode, type HarnessResult, type HarnessTool, harnessScript, parseHarnessLine, shortVersion } from "../core/harness";
import type { AppState } from "../shell/app";
import { selects } from "../core/scope";
import { agentsOn, runnerFor } from "../shell/hosts";
import { runError } from "../shell/runner";
import { humanSink, jsonSink } from "./apply";
import { confirm, die, out, table, withApp } from "./common";

/** One host's harness state: the CLI version per agent, or why the host could not be checked. */
export type HarnessHost = {
  readonly host: string;
  readonly at: string;
  readonly error: string | null;
  readonly results: readonly HarnessResult[];
};

const cacheDir = (skm: string) => `${skm}/cache/harness`;
const cachePath = (skm: string, host: string) => `${cacheDir(skm)}/${host}.json`;

/** Results of a partial run (one tool, or a failed host) replace only their own entries of the previous run. Pure. */
export const mergeHarness = (prev: HarnessHost | null, next: HarnessHost): HarnessHost => {
  if (prev === null || next.error !== null) return next.error !== null && prev !== null ? { ...prev, error: next.error, at: next.at } : next;
  const ids = new Set(next.results.map((r) => r.agent));
  return { ...next, results: [...prev.results.filter((r) => !ids.has(r.agent)), ...next.results] };
};

const writeCache = async (skm: string, h: HarnessHost): Promise<HarnessHost> => {
  const merged = mergeHarness(await readCache(skm, h.host), h);
  await mkdir(cacheDir(skm), { recursive: true });
  await writeFile(cachePath(skm, h.host), JSON.stringify(merged, null, 2));
  return merged;
};

const readCache = async (skm: string, host: string): Promise<HarnessHost | null> => {
  const text = await readFile(cachePath(skm, host), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const h = JSON.parse(text) as HarnessHost;
    // caches written before `latest` existed
    return { ...h, results: h.results.map((r) => (r.kind === "checked" ? { ...r, latest: r.latest ?? "" } : r)) };
  } catch {
    return null;
  }
};

/**
 * Tools of one host: each enabled agent's CLI, plus its desktop app when it has one.
 * `--agent` picks one tool by id (an agent id, or an app id such as `chatgpt`). Without it a check covers everything,
 * while an update covers only the CLIs: an app update downloads the whole app and restarts it, so it is opt-in.
 */
const toolsOf = (app: AppState, h: HostConfig, pick: string | undefined, mode: HarnessMode): HarnessTool[] =>
  agentsOn(app.config, h)
    .flatMap((a): HarnessTool[] => [
      { kind: "cli", id: a.id, bin: a.cli.bin, update: a.cli.update },
      ...(a.app !== undefined ? [{ kind: "app" as const, id: a.app.id, bundle: a.app.bundle, feed: a.app.feed, marker: a.app.marker, ...(a.app.settle !== undefined ? { settle: a.app.settle } : {}) }] : []),
    ])
    .concat(app.config.registry.tools.filter((t) => selects(t.hosts, h.id)).map((t): HarnessTool => ({ kind: "cli", id: t.id, bin: t.bin, update: t.update, ...(t.onChange !== "" ? { onChange: t.onChange } : {}) })))
    // an agent with no update command (an extension that left it out) is checked, never updated
    .filter((t) => mode === "check" || t.kind === "app" || t.update !== "")
    .filter((t) => (pick === undefined ? mode === "check" || t.kind === "cli" : t.id === pick));

const toolText = (t: HarnessTool): string => {
  switch (t.kind) {
    case "cli":
      return t.update;
    case "app":
      return `update ${t.bundle} from ${t.feed}`;
  }
};

/** Every app the configured agents ship, for the JSON report. */
const appsOf = (app: AppState) =>
  app.agents.flatMap((a) => (a.app !== undefined ? [{ id: a.app.id, agent: a.id, name: a.app.name, bundle: a.app.bundle, marketplaces: a.app.marketplaces }] : []));

const hostsOf = (app: AppState, only: string | undefined): readonly HostConfig[] => {
  const hosts = app.config.hosts.filter((h) => only === undefined || h.id === only);
  return hosts.length > 0 ? hosts : die(`unknown host ${only ?? ""} (known: ${app.config.hosts.map((h) => h.id).join(", ")})`);
};

/** Run the script on one host; `onLine` receives every output line that is not a result line. */
const runHost = async (h: HostConfig, tools: readonly HarnessTool[], mode: HarnessMode, onLine: (line: string) => void): Promise<HarnessHost> => {
  const at = new Date().toISOString();
  if (tools.length === 0) return { host: h.id, at, error: null, results: [] };
  // updates download and install; give them far longer than a version check
  const r = await runnerFor(h).sh(harnessScript(tools, mode), { timeoutMs: mode === "update" ? 900_000 : 60_000 });
  if (!r.ok) return { host: h.id, at, error: runError(r.error), results: [] };
  const lines = r.value.stdout.split("\n").filter((l) => l.trim() !== "");
  lines.filter((l) => parseHarnessLine(l) === null).forEach(onLine);
  return { host: h.id, at, error: null, results: lines.flatMap((l) => { const x = parseHarnessLine(l); return x === null ? [] : [x]; }) };
};

const versionOf = (r: HarnessResult): string => {
  switch (r.kind) {
    case "missing":
      return "–";
    case "checked":
      return shortVersion(r.version);
    case "updated":
      return shortVersion(r.after);
  }
};

const cellText = (r: HarnessResult | undefined): string => {
  if (r === undefined) return pc.dim("·");
  switch (r.kind) {
    case "missing":
      return pc.dim("not installed");
    case "checked": {
      const v = shortVersion(r.version);
      return r.latest !== "" && shortVersion(r.latest) !== v ? `${pc.yellow(v)} ${pc.dim(`(latest ${shortVersion(r.latest)})`)}` : v;
    }
    case "updated": {
      const before = shortVersion(r.before);
      const after = shortVersion(r.after);
      if (!r.ok) return pc.red(`failed ${after}`);
      return before === after ? `${after} ${pc.dim("(latest)")}` : pc.green(`${before} → ${after}`);
    }
  }
};

/** `skm harness`: the agent CLI version on every host (live over ssh, or the last result with --cached). */
export const runHarness = async (o: { json: boolean; cached: boolean; host?: string; agent?: string }): Promise<void> =>
  withApp(async (app) => {
    const hosts = hostsOf(app, o.host);
    const rows = await Promise.all(hosts.map(async (h): Promise<HarnessHost> => {
      if (o.cached) return (await readCache(app.skmHome, h.id)) ?? { host: h.id, at: "", error: null, results: [] };
      const r = await runHost(h, toolsOf(app, h, o.agent, "check"), "check", () => undefined);
      return writeCache(app.skmHome, r);
    }));
    if (o.json) {
      return out(JSON.stringify({
        agents: app.agents.map((a) => ({ id: a.id, bin: a.cli.bin, update: a.cli.update })),
        apps: appsOf(app),
        tools: app.config.registry.tools.map((t) => ({ id: t.id, name: t.name, bin: t.bin, update: t.update, extension: t.extension })),
        hosts: rows.map((r) => ({
          ...r,
          versions: Object.fromEntries(r.results.map((x) => [x.agent, x.kind === "missing" ? null : versionOf(x)])),
          latest: Object.fromEntries(r.results.flatMap((x) => (x.kind === "checked" && x.latest !== "" ? [[x.agent, shortVersion(x.latest)]] : []))),
        })),
      }, null, 2));
    }
    const cols = [...app.agents.map((a) => a.id), ...appsOf(app).map((a) => a.id), ...app.config.registry.tools.map((t) => t.id)].filter((id) => o.agent === undefined || id === o.agent);
    out(table(["host", ...cols], rows.map((r) => [
      r.error === null ? r.host : pc.red(r.host),
      ...cols.map((id) => (r.error !== null ? pc.red("unreachable") : cellText(r.results.find((x) => x.agent === id)))),
    ])));
    rows.filter((r) => r.error !== null).forEach((r) => out(pc.yellow(`${r.host}: ${r.error}`)));
  });

/** `skm harness update`: run each agent CLI's own self-update on every selected host, in parallel. */
export const runHarnessUpdate = async (o: { yes: boolean; events: boolean; dryRun: boolean; host?: string; agent?: string }): Promise<void> =>
  withApp(async (app) => {
    const sink = o.events ? jsonSink : humanSink;
    const say = o.events ? () => undefined : out;
    const jobs = hostsOf(app, o.host).map((h) => ({ host: h, tools: toolsOf(app, h, o.agent, "update") })).filter((j) => j.tools.length > 0);
    jobs.forEach((j) => { say(pc.bold(`${j.host.id}:`)); j.tools.forEach((t) => say(`  ${toolText(t)}`)); });
    if (jobs.length === 0) return say("nothing to update");
    if (o.dryRun) return say(pc.dim("\n(dry run — nothing changed)"));
    if (!o.yes && (o.events || !confirm(`\nupdate on ${jobs.map((j) => j.host.id).join(", ")}?`))) return say("aborted");
    const done = await Promise.all(jobs.map(async ({ host, tools }) => {
      sink({ type: "host-start", host: host.id, ops: tools.length });
      const r = await runHost(host, tools, "update", (line) => sink({ type: "log", host: host.id, line }));
      await writeCache(app.skmHome, r);
      const updated = r.results.flatMap((x) => (x.kind === "updated" ? [x] : []));
      const failed = updated.filter((x) => !x.ok);
      r.results.forEach((x) => {
        if (x.kind === "missing") sink({ type: "warn", host: host.id, line: `${x.agent}: not installed` });
        if (x.kind === "updated") sink({ type: "log", host: host.id, line: `== ${x.agent} [${x.ok ? "ok" : "fail"}]: ${shortVersion(x.before)} → ${shortVersion(x.after)}` });
      });
      sink({
        type: "host-done", host: host.id, ok: r.error === null && failed.length === 0,
        rsynced: 0, applied: 0, commandsOk: updated.length - failed.length, commandsFailed: failed.length,
        failures: failed.map((x) => `${x.agent} update failed`), error: r.error,
      });
      return r;
    }));
    sink({ type: "verified", pending: done.flatMap((r) => (r.error !== null ? [r.host] : r.results.some((x) => x.kind === "updated" && !x.ok) ? [r.host] : [])) });
  });
