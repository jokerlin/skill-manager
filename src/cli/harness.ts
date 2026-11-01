import pc from "picocolors";
import type { HostConfig } from "../core/config";
import { type HarnessResult, type HarnessTool, shortVersion } from "../core/harness";
import type { AppState } from "../shell/app";
import { type HarnessHost, appsOf, readHarnessCache, runHarnessHost, toolsOf, writeHarnessCache } from "../shell/harness";
import { humanSink, jsonSink } from "./apply";
import { confirm, die, out, table, withApp } from "./common";

const toolText = (t: HarnessTool): string => {
  switch (t.kind) {
    case "cli":
      return t.update;
    case "app":
      return `update ${t.bundle} from ${t.feed}`;
  }
};

const hostsOf = (app: AppState, only: string | undefined): readonly HostConfig[] => {
  const hosts = app.config.hosts.filter((h) => only === undefined || h.id === only);
  return hosts.length > 0 ? hosts : die(`unknown host ${only ?? ""} (known: ${app.config.hosts.map((h) => h.id).join(", ")})`);
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
      if (o.cached) return (await readHarnessCache(app.skmHome, h.id)) ?? { host: h.id, at: "", error: null, results: [] };
      const r = await runHarnessHost(h, toolsOf(app, h, o.agent, "check"), "check", () => undefined);
      return writeHarnessCache(app.skmHome, r);
    }));
    if (o.json) {
      return out(JSON.stringify({
        agents: app.agents.map((a) => ({ id: a.id, bin: a.cli.bin, update: a.cli.update })),
        apps: appsOf(app),
        hosts: rows.map((r) => ({
          ...r,
          versions: Object.fromEntries(r.results.map((x) => [x.agent, x.kind === "missing" ? null : versionOf(x)])),
          latest: Object.fromEntries(r.results.flatMap((x) => (x.kind === "checked" && x.latest !== "" ? [[x.agent, shortVersion(x.latest)]] : []))),
        })),
      }, null, 2));
    }
    const cols = [...app.agents.map((a) => a.id), ...appsOf(app).map((a) => a.id)].filter((id) => o.agent === undefined || id === o.agent);
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
      const r = await runHarnessHost(host, tools, "update", (line) => sink({ type: "log", host: host.id, line }));
      await writeHarnessCache(app.skmHome, r);
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
