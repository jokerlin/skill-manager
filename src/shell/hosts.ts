import { type Agent, agentById } from "../core/agents";
import { type Config, type HostConfig, hostAgents } from "../core/config";
import { type Inventory } from "../core/inventory";
import { type Op, planHost } from "../core/plan";
import { desiredFor } from "../core/scope";
import type { Skill } from "../core/skill";
import { type Runner, localRunner, sshRunner } from "./runner";
import { homeDir } from "./paths";

export const runnerFor = (h: HostConfig): Runner => (h.ssh.some ? sshRunner(h.id, h.ssh.value) : localRunner(homeDir()));

/** Agents enabled on this host, resolved to registry entries (unknown ids are dropped). */
export const agentsOn = (c: Config, h: HostConfig): readonly Agent[] =>
  hostAgents(c, h).flatMap((id) => { const a = agentById(id); return a.some ? [a.value] : []; });

/** agent id → home-relative user dir (`~/.claude/skills`) */
export const agentDirsRel = (agents: readonly Agent[]): Record<string, string> =>
  Object.fromEntries(agents.map((a) => [a.id, a.userDir("~")]));

export const alsoReadsRel = (agents: readonly Agent[]): Record<string, string[]> =>
  Object.fromEntries(agents.filter((a) => a.alsoReads.length > 0).map((a) => [a.id, a.alsoReads.map((f) => f("~"))]));

/** agent id → sorted skills wanted on this host */
export const desiredOn = (c: Config, skills: readonly Skill[], h: HostConfig): Record<string, string[]> =>
  Object.fromEntries(agentsOn(c, h).map((a) => [a.id, desiredFor(c, skills.map((s) => s.name), h.id, a.id)]));

export const planFor = (c: Config, skills: readonly Skill[], h: HostConfig, inv: Inventory): Op[] =>
  planHost({
    hostId: h.id,
    isLocal: !h.ssh.some,
    desired: desiredOn(c, skills, h),
    inventory: inv,
    hubSkills: skills.map((s) => ({ name: s.name, hash: s.contentHash })),
    agentDirs: agentDirsRel(agentsOn(c, h)),
  });

/** Every home-relative path a backup should capture on this host. */
export const backupPathsFor = (h: HostConfig, agents: readonly Agent[]): string[] => [
  `${h.skm}/skills`,
  ...agents.map((a) => a.userDir("~")),
  ...agents.flatMap((a) => a.alsoReads.map((f) => f("~"))),
];
