import pc from "picocolors";
import { buildEvalPrompt, evalErrorText, parseEvalResponse, type EvalItem } from "../core/evalPrompt";
import { readEvalCache, writeEvalCache } from "../shell/cache";
import { evaluators, type EvaluatorId } from "../shell/evaluators";
import { die, out, table, withApp } from "./common";

export type EvalOpts = { agent?: EvaluatorId; model?: string; fresh: boolean; json: boolean; batch: number; cached?: boolean };

const verdictColor = (v: EvalItem["verdict"]): string =>
  v === "keep" ? pc.green(v) : v === "trim" ? pc.yellow(v) : v === "merge" ? pc.magenta(v) : pc.red(v);

export const runEval = async (names: string[], o: EvalOpts): Promise<void> =>
  withApp(async (app) => {
    const evaluatorId = o.agent ?? app.config.eval.agent;
    const model = o.model ?? (app.config.eval.model.some ? app.config.eval.model.value : undefined);
    const targets = names.length === 0 ? app.skills : app.skills.filter((s) => names.includes(s.name));
    const missing = names.filter((n) => !app.skills.some((s) => s.name === n));
    if (missing.length > 0) return die(`unknown skills: ${missing.join(", ")}`);
    const cache = await readEvalCache(app.skmHome);
    const stale = o.cached ? [] : targets.filter((s) => o.fresh || cache[s.name]?.hash !== s.contentHash || cache[s.name]?.evaluator !== evaluatorId);
    if (stale.length > 0) {
      out(pc.dim(`evaluating ${stale.length} skills with ${evaluatorId}${model ? ` (${model})` : ""} in batches of ${o.batch}; ${targets.length - stale.length} cached`));
      const batches = Array.from({ length: Math.ceil(stale.length / o.batch) }, (_, i) => stale.slice(i * o.batch, (i + 1) * o.batch));
      // the model sees the whole library's names so overlaps can be judged across batches
      const roster = app.skills.map((s) => `${s.name}: ${s.cost.descChars > 0 ? (s.parsed.ok && s.parsed.value.frontmatter.description.some ? s.parsed.value.frontmatter.description.value : "").slice(0, 120) : "(no description)"}`).join("\n");
      const failed = await batches.reduce(async (p, batch, i) => {
        const failures = await p;
        out(pc.dim(`  batch ${i + 1}/${batches.length}: ${batch.map((s) => s.name).join(" ")}`));
        const prompt = `${buildEvalPrompt(batch)}\n\n=== ALL SKILL NAMES IN THE LIBRARY (for overlap judgement) ===\n${roster}\n`;
        const r = await evaluators[evaluatorId](prompt, model);
        if (!r.ok) { out(pc.red(`  ${evalErrorText(r.error)}`)); return failures + 1; }
        const items = parseEvalResponse(r.value);
        if (!items.ok) { out(pc.red(`  ${evalErrorText(items.error)}`)); return failures + 1; }
        items.value.forEach((item) => {
          const s = batch.find((x) => x.name === item.name);
          if (s) cache[s.name] = { hash: s.contentHash, evaluator: evaluatorId, at: new Date().toISOString(), item };
        });
        return failures;
      }, Promise.resolve(0));
      await writeEvalCache(app.skmHome, cache);
      if (failed > 0) { out(pc.red(`${failed}/${batches.length} batches failed`)); process.exitCode = 1; }
    }
    const rows = targets.flatMap((s) => { const c = cache[s.name]; return c ? [{ skill: s, item: c.item, at: c.at }] : []; });
    if (o.json) return out(JSON.stringify(rows.map((r) => ({ ...r.item, evaluatedAt: r.at })), null, 2));
    const sorted = [...rows].sort((a, b) => a.item.usefulness - b.item.usefulness || b.skill.cost.descChars - a.skill.cost.descChars);
    out(table(["skill", "useful", "desc", "verdict", "overlaps", "reason"], sorted.map((r) => [r.skill.name, "★".repeat(r.item.usefulness) + pc.dim("☆".repeat(5 - r.item.usefulness)), String(r.item.description_quality), verdictColor(r.item.verdict), r.item.overlaps.join(","), r.item.reason.slice(0, 80)])));
    const trims = sorted.filter((r) => r.item.trim_suggestion.length > 0);
    if (trims.length > 0) { out(""); out(pc.bold("suggested descriptions")); trims.forEach((r) => out(`  ${pc.bold(r.skill.name)}: ${r.item.trim_suggestion}`)); }
  });
