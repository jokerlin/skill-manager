import pc from "picocolors";
import { hostById } from "../core/config";
import { backupHost, listBackups, restoreHost } from "../shell/backup";
import { agentsOn, backupPathsFor, runnerFor } from "../shell/hosts";
import { nowStamp } from "../shell/paths";
import { hostErrorText } from "../shell/probe";
import { confirm, die, out, withApp } from "./common";

export const runBackup = async (hosts: string[]): Promise<void> =>
  withApp(async (app) => {
    const ts = nowStamp();
    const targets = hosts.length === 0 ? app.config.hosts : app.config.hosts.filter((h) => hosts.includes(h.id));
    if (targets.length === 0) return die(`no such host: ${hosts.join(", ")}`);
    await Promise.all(
      targets.map(async (h) => {
        const r = await backupHost(h, runnerFor(h), backupPathsFor(h, agentsOn(app.config, h)), app.skmHome, ts);
        out(r.ok ? `${pc.bold(h.id)}: ${pc.green("backed up")} ${r.value.dir}${r.value.hubCopy ? pc.dim(`  copy → ${r.value.hubCopy}`) : ""}\n    restore: ${pc.cyan(`skm restore ${h.id} ${ts}`)}  or on the host: ${pc.cyan(`sh ${r.value.dir}/restore.sh`)}` : `${pc.bold(h.id)}: ${pc.red(hostErrorText(r.error))}`);
      }),
    );
  });

export const runBackups = async (host?: string): Promise<void> =>
  withApp(async (app) => {
    const targets = host === undefined ? app.config.hosts : app.config.hosts.filter((h) => h.id === host);
    await Promise.all(
      targets.map(async (h) => {
        const r = await listBackups(h, runnerFor(h));
        if (!r.ok) return out(`${pc.bold(h.id)}: ${pc.red(hostErrorText(r.error))}`);
        out(`${pc.bold(h.id)}: ${r.value.length === 0 ? pc.dim("no backups") : ""}`);
        r.value.forEach((b) => out(`  ${b.ts}  ${pc.dim(`${b.presentCount} paths`)}`));
      }),
    );
  });

export const runRestore = async (hostId: string, ts: string, yes: boolean): Promise<void> =>
  withApp(async (app) => {
    const h = hostById(app.config, hostId);
    if (!h.some) return die(`no such host: ${hostId}`);
    if (!yes && !confirm(`restore ${hostId} to backup ${ts}? current skill dirs on ${hostId} will be replaced`)) return out("aborted");
    const r = await restoreHost(h.value, runnerFor(h.value), ts);
    out(r.ok ? `${pc.green("restored")}\n${r.value}` : pc.red(hostErrorText(r.error)));
  });
