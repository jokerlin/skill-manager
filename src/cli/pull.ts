import pc from "picocolors";
import { hostById } from "../core/config";
import { agentsOn, runnerFor } from "../shell/hosts";
import { hostErrorText, probeHost } from "../shell/probe";
import { rsyncMirror, runError } from "../shell/runner";
import { die, out, withApp } from "./common";

const rel = (p: string): string => (p.startsWith("~/") ? p.slice(2) : p);

/** Copy remote-only skills from a host's store into the hub store. */
export const runPull = async (hostId: string, skills: string[], all: boolean, force: boolean): Promise<void> =>
  withApp(async (app) => {
    const h = hostById(app.config, hostId);
    if (!h.some) return die(`no such host: ${hostId}`);
    if (!h.value.ssh.some) return die("pull only makes sense for ssh hosts");
    const runner = runnerFor(h.value);
    const inv = await probeHost(h.value, agentsOn(app.config, h.value), runner);
    if (!inv.ok) return die(hostErrorText(inv.error));
    const hub = new Set(app.skills.map((s) => s.name));
    const remoteOnly = inv.value.storeSkills.map((s) => s.name).filter((n) => !hub.has(n));
    const wanted = all ? remoteOnly : skills;
    if (wanted.length === 0) return out(remoteOnly.length === 0 ? pc.dim("nothing remote-only on this host") : `remote-only on ${hostId}: ${remoteOnly.join(" ")}\nuse --all or name them`);
    await wanted.reduce(async (p, name) => {
      await p;
      if (!inv.value.storeSkills.some((s) => s.name === name)) return out(`${pc.red("missing")} ${name} is not in ${hostId}'s store`);
      if (hub.has(name) && !force) return out(`${pc.yellow("skip")} ${name} already in hub store (use --force to overwrite)`);
      const r = await rsyncMirror(runner.rsyncPath(`${rel(h.value.skm)}/skills/${name}`), `${app.storeDir}/${name}`);
      out(r.ok ? `${pc.green("pulled")} ${name}` : `${pc.red("failed")} ${name}: ${runError(r.error)}`);
    }, Promise.resolve());
  });
