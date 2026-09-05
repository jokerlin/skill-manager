import pc from "picocolors";
import { simulateListing } from "../core/budget";
import { allInsights } from "../core/heuristics";
import { isDesired } from "../core/scope";
import { agentsOn } from "../shell/hosts";
import { fmtK, out, table, withApp } from "./common";

export const runDoctor = async (o: { json?: boolean } = {}): Promise<void> =>
  withApp(async (app) => {
    const insights = allInsights(app.skills);
    if (o.json) {
      const budget = app.config.hosts.flatMap((h) =>
        agentsOn(app.config, h).map((a) => {
          const linked = app.skills.filter((s) => isDesired(app.config, s.name, h.id, a.id));
          const r = simulateListing(a, linked, app.config.contextTokens, a.id === "claude" ? app.claudeOverrides : {});
          return { host: h.id, agent: a.id, skills: linked.length, usedChars: r.usedChars, tokens: linked.reduce((n, s) => n + s.cost.descTokens, 0), budgetChars: Number.isFinite(r.budgetChars) ? r.budgetChars : null, droppedCount: r.droppedCount, overBy: r.overBy };
        }),
      );
      return out(JSON.stringify({ store: app.storeDir, skillCount: app.skills.length, contextTokens: app.config.contextTokens, budget, insights }, null, 2));
    }
    out(pc.bold(`store: ${app.storeDir}  ·  ${app.skills.length} skills${app.ignoredDirs.length > 0 ? pc.dim(`  ·  ignored (no SKILL.md): ${app.ignoredDirs.join(" ")}`) : ""}`));
    out("");
    out(pc.bold("startup context per host × agent (listing = name + description of every linked skill)"));
    const rows = app.config.hosts.flatMap((h) =>
      agentsOn(app.config, h).map((a) => {
        const linked = app.skills.filter((s) => isDesired(app.config, s.name, h.id, a.id));
        const r = simulateListing(a, linked, app.config.contextTokens, a.id === "claude" ? app.claudeOverrides : {});
        const tokens = linked.reduce((n, s) => n + s.cost.descTokens, 0);
        const budget = Number.isFinite(r.budgetChars) ? String(r.budgetChars) : "—";
        const verdict = !Number.isFinite(r.budgetChars) ? pc.dim("no documented budget") : r.overBy > 0 ? pc.red(`over by ${r.overBy}c → ~${r.droppedCount} descriptions dropped`) : pc.green("fits");
        return [h.id, a.id, String(linked.length), `${r.usedChars}c / ~${fmtK(tokens)}t`, budget, verdict];
      }),
    );
    out(table(["host", "agent", "skills", "listing", "budget(c)", "verdict"], rows));
    out(pc.dim(`context window assumed ${app.config.contextTokens} tokens (config: contextTokens); Claude overrides from ~/.claude/settings.json: ${JSON.stringify(app.claudeOverrides)}`));
    out("");
    if (insights.length === 0) return out(pc.green("no findings"));
    out(pc.bold(`${insights.length} findings`));
    const byKind = insights.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.kind]: (acc[i.kind] ?? 0) + 1 }), {});
    out(pc.dim(Object.entries(byKind).map(([k, n]) => `${k}: ${n}`).join("  ")));
    insights.forEach((i) => out(`  ${i.kind === "spec-violation" ? pc.red(i.kind) : i.kind === "duplicate" ? pc.magenta(i.kind) : pc.yellow(i.kind)}  ${pc.bold(i.skill)}  ${i.detail}`));
  });
