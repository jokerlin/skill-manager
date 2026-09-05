import pc from "picocolors";
import { type Skill, descriptionOf } from "../core/skill";
import { isDesired } from "../core/scope";
import { lintSkill } from "../core/heuristics";
import { fmtBytes, fmtK, out, table, withApp } from "./common";

export type LsOpts = { json: boolean; host?: string; agent?: string; sort: "name" | "cost" };

export const skillRow = (s: Skill): Record<string, unknown> => ({
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
});

export const runLs = async (o: LsOpts): Promise<void> =>
  withApp(async (app) => {
    const filtered = app.skills.filter((s) => {
      if (o.host === undefined && o.agent === undefined) return true;
      const hosts = o.host === undefined ? app.config.hosts.map((h) => h.id) : [o.host];
      const agents = o.agent === undefined ? app.config.agents : [o.agent];
      return hosts.some((h) => agents.some((a) => isDesired(app.config, s.name, h, a)));
    });
    const sorted = [...filtered].sort((a, b) => (o.sort === "cost" ? b.cost.descChars - a.cost.descChars : a.name.localeCompare(b.name)));
    if (o.json) return out(JSON.stringify(sorted.map(skillRow), null, 2));
    const rows = sorted.map((s) => {
      const flags = [...s.violations.map(() => "!"), ...lintSkill(s).map(() => "?")].join("");
      return [
        s.violations.length > 0 ? pc.red(s.name) : s.name,
        `${s.cost.descChars}c/${s.cost.descTokens}t`,
        `${fmtK(s.cost.bodyTokens)}t/${s.cost.bodyLines}L`,
        String(s.cost.fileCount),
        fmtBytes(s.cost.totalBytes),
        flags.length > 0 ? pc.yellow(flags) : "",
        pc.dim(descriptionOf(s).replace(/\s+/g, " ").slice(0, 60)),
      ];
    });
    out(table(["skill", "listing", "body", "files", "size", "", "description"], rows));
    out(pc.dim(`\n${sorted.length} skills  ·  listing = description chars/tokens (paid every turn)  ·  body = tokens/lines (paid on activation)  ·  ! spec violation  ? hint`));
  });
