import pc from "picocolors";
import { lintSkill, findDuplicates } from "../core/heuristics";
import { isDesired } from "../core/scope";
import { descriptionOf } from "../core/skill";
import { agentsOn } from "../shell/hosts";
import { die, fmtBytes, fmtK, out, table, withApp } from "./common";

export const runShow = async (name: string): Promise<void> =>
  withApp(async (app) => {
    const s = app.skills.find((x) => x.name === name);
    if (!s) return die(`no skill named ${name} in ${app.storeDir}`);
    out(pc.bold(s.name) + "  " + pc.dim(s.dir));
    out(descriptionOf(s));
    if (s.parsed.ok && s.parsed.value.frontmatter.whenToUse.some) out(pc.dim(`when_to_use: ${s.parsed.value.frontmatter.whenToUse.value}`));
    out("");
    out(`listing: ${s.cost.descTokens} tokens (every turn)   body: ${fmtK(s.cost.bodyTokens)} tokens, ${s.cost.bodyLines} lines (on activation)   files: ${s.cost.fileCount}, ${fmtBytes(s.cost.totalBytes)}`);
    if (s.parsed.ok) {
      const extra = Object.keys(s.parsed.value.frontmatter.extra);
      if (extra.length > 0) out(pc.dim(`other frontmatter: ${extra.join(", ")}`));
    }
    out("");
    out(pc.bold("targets (from config; ● wanted ○ not)"));
    const agents = app.config.agents;
    out(table(["host", ...agents], app.config.hosts.map((h) => [h.id, ...agents.map((a) => (agentsOn(app.config, h).some((x) => x.id === a) ? (isDesired(app.config, s.name, h.id, a) ? pc.green("●") : "○") : pc.dim("–")))])));
    const ins = [...lintSkill(s), ...findDuplicates(app.skills).filter((i) => i.skill === s.name)];
    if (ins.length > 0) { out(""); out(pc.bold("insights")); ins.forEach((i) => out(`  ${pc.yellow(i.kind)}  ${i.detail}`)); }
  });
