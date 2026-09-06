import pc from "picocolors";
import { type Skill, descriptionOf } from "../core/skill";
import { isDesired } from "../core/scope";
import { findDuplicates, lintSkill } from "../core/heuristics";
import type { AppState } from "../shell/app";
import { agentsOn } from "../shell/hosts";
import { fmtBytes, fmtK, out, table, withApp } from "./common";

export type LsOpts = { json: boolean; host?: string; agent?: string; sort: "name" | "cost" };

export const skillRow = (s: Skill, targets: Record<string, Record<string, boolean>> = {}, insights: string[] = []): Record<string, unknown> => ({
  name: s.name,
  description: descriptionOf(s),
  descChars: s.cost.descChars,
  descTokens: s.cost.descTokens,
  bodyTokens: s.cost.bodyTokens,
  bodyLines: s.cost.bodyLines,
  files: s.cost.fileCount,
  bytes: s.cost.totalBytes,
  violations: s.violations.map((v) => `${v.field}:${v.kind}`),
  hash: s.contentHash.slice(0, 8),
  targets,
  insights,
});

export const targetsOf = (app: AppState, name: string): Record<string, Record<string, boolean>> =>
  Object.fromEntries(app.config.hosts.map((h) => [h.id, Object.fromEntries(agentsOn(app.config, h).map((a) => [a.id, isDesired(app.config, name, h.id, a.id)]))]));

export const runLs = async (o: LsOpts): Promise<void> =>
  withApp(async (app) => {
    const filtered = app.skills.filter((s) => {
      if (o.host === undefined && o.agent === undefined) return true;
      const hosts = o.host === undefined ? app.config.hosts.map((h) => h.id) : [o.host];
      const agents = o.agent === undefined ? app.config.agents : [o.agent];
      return hosts.some((h) => agents.some((a) => isDesired(app.config, s.name, h, a)));
    });
    const sorted = [...filtered].sort((a, b) => (o.sort === "cost" ? b.cost.descTokens - a.cost.descTokens : a.name.localeCompare(b.name)));
    if (o.json) {
      const dups = findDuplicates(app.skills);
      return out(JSON.stringify(sorted.map((s) => skillRow(s, targetsOf(app, s.name), [...lintSkill(s), ...dups.filter((d) => d.skill === s.name)].map((i) => `${i.kind}: ${i.detail}`))), null, 2));
    }
    const rows = sorted.map((s) => {
      const flags = [...s.violations.map(() => "!"), ...lintSkill(s).map(() => "?")].join("");
      return [
        s.violations.length > 0 ? pc.red(s.name) : s.name,
        `${s.cost.descTokens}t`,
        `${fmtK(s.cost.bodyTokens)}t/${s.cost.bodyLines}L`,
        String(s.cost.fileCount),
        fmtBytes(s.cost.totalBytes),
        flags.length > 0 ? pc.yellow(flags) : "",
        pc.dim(descriptionOf(s).replace(/\s+/g, " ").slice(0, 60)),
      ];
    });
    out(table(["skill", "listing", "body", "files", "size", "", "description"], rows));
    out(pc.dim(`\n${sorted.length} skills  ·  listing = description tokens (paid every turn)  ·  body = tokens/lines (paid on activation)  ·  ! spec violation  ? hint`));
  });
