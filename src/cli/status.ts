import pc from "picocolors";
import type { HostConfig } from "../core/config";
import type { Entry, Inventory } from "../core/inventory";
import { type Op, opText } from "../core/plan";
import type { AppState } from "../shell/app";
import { agentsOn, desiredOn, planFor, runnerFor } from "../shell/hosts";
import { type HostError, hostErrorText, probeHost } from "../shell/probe";
import { out, table, withApp } from "./common";

export type HostSnapshot = {
  readonly host: HostConfig;
  readonly result: { ok: true; inventory: Inventory; ops: Op[] } | { ok: false; error: HostError };
};

/** Probe every selected host in parallel and plan each. */
export const snapshotHosts = async (app: AppState, only?: string): Promise<HostSnapshot[]> =>
  Promise.all(
    app.config.hosts
      .filter((h) => only === undefined || h.id === only)
      .map(async (host) => {
        const inv = await probeHost(host, agentsOn(app.config, host), runnerFor(host));
        return inv.ok
          ? { host, result: { ok: true as const, inventory: inv.value, ops: planFor(app.config, app.skills, host, inv.value) } }
          : { host, result: { ok: false as const, error: inv.error } };
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

/** What an agent on a host actually loads: everything non-file in its dir (links resolved or not). */
export const consumedJson = (snap: HostSnapshot, app: AppState) => {
  if (!snap.result.ok) return { host: snap.host.id, reachable: false, error: hostErrorText(snap.result.error) };
  const inv = snap.result.inventory;
  const desired = desiredOn(app.config, app.skills, snap.host);
  return {
    host: snap.host.id,
    reachable: true,
    home: inv.home,
    store: inv.storeSkills.map((s) => s.name),
    remoteOnly: snap.result.ops.flatMap((o) => (o.op === "remote-only" ? [o.skill] : [])),
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
          },
        ];
      }),
    ),
    drift: snap.result.ops.filter((o) => o.op !== "remote-only").map(opText),
  };
};

export const runStatus = async (o: { host?: string; json: boolean }): Promise<void> =>
  withApp(async (app) => {
    const snaps = await snapshotHosts(app, o.host);
    if (o.json) return out(JSON.stringify(snaps.map((s) => consumedJson(s, app)), null, 2));
    snaps.forEach((snap) => {
      if (!snap.result.ok) return out(`${pc.bold(snap.host.id)}  ${pc.red("unreachable")}  ${pc.dim(hostErrorText(snap.result.error))}\n`);
      const { inventory: inv, ops } = snap.result;
      const mutations = ops.filter((o) => o.op !== "remote-only" && o.op !== "conflict");
      const conflicts = ops.filter((o) => o.op === "conflict");
      const remoteOnly = ops.flatMap((o) => (o.op === "remote-only" ? [o.skill] : []));
      out(`${pc.bold(snap.host.id)}  ${pc.dim(inv.home)}  store:${inv.storeSkills.length}  ${mutations.length === 0 ? pc.green("in sync") : pc.yellow(`${mutations.length} pending ops`)}${conflicts.length > 0 ? pc.red(`  ${conflicts.length} conflicts`) : ""}${remoteOnly.length > 0 ? pc.magenta(`  ${remoteOnly.length} remote-only`) : ""}`);
      const rows = agentsOn(app.config, snap.host).map((a) => {
        const d = inv.agentDirs[a.id];
        const entries = (d?.entries ?? []).filter((e) => e.kind !== "file");
        const also = (inv.alsoReads[a.id] ?? []).filter((e) => e.kind !== "file");
        return [a.id, d?.exists ? String(entries.length) : pc.dim("absent"), consumedList(entries) + (also.length > 0 ? pc.dim(`  +legacy: ${also.map((e) => e.name).join(" ")}`) : "")];
      });
      out(table(["agent", "n", "consumed"], rows));
      if (remoteOnly.length > 0) out(pc.magenta(`  remote-only in store: ${remoteOnly.join(" ")}`));
      conflicts.forEach((c) => out(pc.red(`  ${opText(c)}`)));
      out("");
    });
    out(pc.dim("● direct link to store  ◐ link resolving into store via another link  ▣ real dir (unmanaged)  ↗ link elsewhere  ✗ broken link"));
  });
