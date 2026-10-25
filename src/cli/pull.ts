import pc from "picocolors";
import { hostById } from "../core/config";
import type { Inventory } from "../core/inventory";
import type { Agent } from "../core/agents";
import { agentsOn, runnerFor } from "../shell/hosts";
import { hostErrorText, probeHost } from "../shell/probe";
import { rsyncMirror, runError } from "../shell/runner";
import { die, out, withApp } from "./common";

const rel = (p: string): string => (p.startsWith("~/") ? p.slice(2) : p);

export type PullCandidate = { readonly name: string; readonly source: string /* home-relative dir on the host */; readonly via: string };

/**
 * Skills a host has that the hub store lacks: remote-only store entries first, then real
 * (unmanaged) directories inside agent dirs. One candidate per name, first source wins.
 */
export const pullCandidates = (inv: Inventory, agents: readonly Agent[], skm: string, hubNames: ReadonlySet<string>): PullCandidate[] => {
  const fromStore = inv.storeSkills.map((s): PullCandidate => ({ name: s.name, source: `${rel(skm)}/skills/${s.name}`, via: "store" }));
  const fromAgents = agents.flatMap((a) =>
    (inv.agentDirs[a.id]?.entries ?? [])
      .filter((e) => e.kind === "dir")
      .map((e): PullCandidate => ({ name: e.name, source: `${rel(a.userDir("~"))}/${e.name}`, via: a.id })),
  );
  return [...fromStore, ...fromAgents]
    .filter((c) => !hubNames.has(c.name) && !c.name.startsWith("."))
    .reduce<PullCandidate[]>((acc, c) => (acc.some((x) => x.name === c.name) ? acc : [...acc, c]), []);
};

/** Copy skills from a host (its store or its agent dirs) into the hub store. */
export const runPull = async (hostId: string, skills: string[], all: boolean, force: boolean): Promise<void> =>
  withApp(async (app) => {
    const h = hostById(app.config, hostId);
    if (!h.some) return die(`no such host: ${hostId}`);
    if (!h.value.ssh.some) return die("pull only makes sense for ssh hosts (use `skm adopt` locally)");
    const runner = runnerFor(h.value);
    const agents = agentsOn(app.config, h.value);
    const inv = await probeHost(h.value, agents, app.config.owned, runner);
    if (!inv.ok) return die(hostErrorText(inv.error));
    const hub = new Set(app.skills.map((s) => s.name));
    const candidates = pullCandidates(inv.value, agents, h.value.skm, force ? new Set() : hub);
    const wanted = all ? candidates : candidates.filter((c) => skills.includes(c.name));
    const unknown = skills.filter((n) => !candidates.some((c) => c.name === n));
    unknown.forEach((n) => out(`${pc.yellow("skip")} ${n}: ${hub.has(n) ? "already in hub store (use --force to overwrite)" : `not found on ${hostId}`}`));
    if (wanted.length === 0) {
      return out(candidates.length === 0 ? pc.dim(`nothing on ${hostId} that the hub lacks`) : `${hostId} has ${candidates.length} skills the hub lacks:\n  ${candidates.map((c) => `${c.name} ${pc.dim(`(${c.via})`)}`).join("\n  ")}\nuse --all or name them`);
    }
    await wanted.reduce(async (p, c) => {
      await p;
      const r = await rsyncMirror(runner.rsyncPath(c.source), `${app.storeDir}/${c.name}`);
      out(r.ok ? `${pc.green("pulled")} ${c.name} ${pc.dim(`← ${hostId}:${c.source}`)}` : `${pc.red("failed")} ${c.name}: ${runError(r.error)}`);
    }, Promise.resolve());
    out(pc.dim("\nnext: `skm rules infer` to scope them, then `skm sync --replace-conflicts` to turn the remote copies into links"));
  });
