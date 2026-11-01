import pc from "picocolors";
import {
  type GitUpstream, type StateKind, type UpstreamLock, type UpstreamPolicy,
  DEFAULT_UPSTREAM_PATH, isSafeSkillName, originText, setLockEntry, stateHint, stateLabel, unlistedSummary,
} from "../core/upstream";
import { none, some } from "../lib/result";
import type { AppState } from "../shell/app";
import { describe, findBases, readLock, resolveTarget, storeDigest, syncMirror, unlistedSkills, upstreamErrorText, writeLock } from "../shell/upstream";
import { type UpstreamReport, type UpdateOutcome, checkUpstreams, planUpdate, runUpdate, toWrite } from "../shell/upstreamOps";
import { confirm, die, out, saveConfig, table, withApp } from "./common";

const storePath = (app: AppState, skill: string): string => `${app.storeDir}/${skill}`;

const stateText = (s: StateKind): string => {
  const label = stateLabel[s];
  switch (s) {
    case "current": return pc.green(label);
    case "behind": return pc.cyan(label);
    case "modified": return pc.yellow(label);
    case "unbased": return pc.yellow(label);
    case "absent": return pc.cyan(label);
    case "gone": return pc.red(label);
  }
};

const skillJson = (s: UpstreamReport["skills"][number]) => ({
  skill: s.skill,
  state: s.state.kind,
  base: s.base.some ? { rev: s.base.value.rev, label: s.base.value.label } : null,
  target: s.target,
  changes: s.changes,
});

/** The fields both a checked and a failed upstream report: what it is and where its files come from. */
const policyJson = (p: UpstreamPolicy) => ({
  name: p.name,
  kind: p.kind,
  /** the repo URL, or the source and its params */
  repo: originText(p),
  source: p.kind === "source" ? p.source : null,
  ref: p.ref.some ? p.ref.value : null,
});

const reportJson = (r: UpstreamReport) => ({
  ...policyJson(r.policy),
  target: r.target.some ? r.target.value : null,
  warning: r.warning.some ? r.warning.value : null,
  error: null,
  skills: r.skills.map(skillJson),
  unlisted: r.unlisted,
});

const loadLock = async (app: AppState): Promise<UpstreamLock> => {
  const l = await readLock(app.skmHome);
  return l.ok ? l.value : die(l.error);
};

/** `skm upstream`: every configured upstream, its target ref, and the state of each skill it supplies. */
export const runUpstream = async (o: { json: boolean; cached: boolean; log: boolean }): Promise<void> =>
  withApp(async (app) => {
    const ups = app.config.upstreams;
    if (ups.length === 0 && !o.json) return out(pc.dim("no upstreams in config.yaml; add one with `skm upstream adopt <name> --repo <url>`"));
    const checked = await checkUpstreams(app, { offline: o.cached, ref: none });
    const reports = checked.ok ? checked.value : die(checked.error);
    if (o.json) {
      return out(JSON.stringify({
        upstreams: reports.map((r) => (r.result.ok ? reportJson(r.result.value) : { ...policyJson(r.policy), target: null, warning: null, error: upstreamErrorText(r.result.error), skills: [], unlisted: [] })),
      }, null, 2));
    }
    reports.forEach((r, i) => {
      if (i > 0) out("");
      if (!r.result.ok) return out(`${pc.bold(r.policy.name)}  ${pc.red(upstreamErrorText(r.result.error))}`);
      const v = r.result.value;
      out(`${pc.bold(v.policy.name)}  ${pc.dim(originText(v.policy))}${v.target.some ? `  → ${pc.bold(v.target.value.label)} ${pc.dim(v.target.value.rev.slice(0, 7))}` : ""}`);
      if (v.warning.some) out(pc.yellow(`  ${v.warning.value}`));
      // a source gives each skill its own version, so the table shows the target per row
      out(table(["  skill", "state", "store version", ...(v.target.some ? ["changes"] : ["upstream version"])], v.skills.map((s) => [
        `  ${s.skill}`,
        stateText(s.state.kind),
        s.base.some ? s.base.value.label : pc.dim("—"),
        v.target.some ? (s.changes.length > 0 ? `${s.changes.length} commits` : "") : s.target.label,
      ])));
      v.skills.filter((s) => stateHint[s.state.kind] !== "").forEach((s) => out(pc.dim(`  ${s.skill}: ${stateHint[s.state.kind]}`)));
      if (o.log) v.skills.filter((s) => s.changes.length > 0).forEach((s) => {
        out(`\n  ${pc.bold(s.skill)}`);
        s.changes.forEach((c) => out(`    ${pc.dim(`${c.commit} ${c.date}`)} ${c.subject}`));
      });
      const unlisted = unlistedSummary(v.policy.name, v.unlisted);
      if (unlisted.some) out(pc.dim(`  ${unlisted.value}`));
    });
    const pendingIn = reports.flatMap((r) => (r.result.ok ? [{ git: r.policy.kind === "git", skills: r.result.value.skills.filter((s) => s.state.kind === "behind" || s.state.kind === "absent") }] : []));
    const pending = pendingIn.flatMap((x) => x.skills);
    // only a git upstream has commits to list
    const logHint = !o.log && pendingIn.some((x) => x.git && x.skills.length > 0) ? " · commit list: `skm upstream --log`" : "";
    if (pending.length > 0) out(pc.dim(`\nnext: \`skm upstream update ${pending.map((s) => s.skill).join(" ")}\`${logHint}`));
  });

/** `skm upstream update [skills…]`: write the target version of each skill into the store, back up first, record it in the lock. */
export const runUpstreamUpdate = async (names: readonly string[], o: { all: boolean; to?: string; force: boolean; yes: boolean; backup: boolean; dryRun: boolean; cached: boolean; json: boolean }): Promise<void> =>
  withApp(async (app) => {
    const say = o.json ? () => undefined : out;
    if (names.length === 0 && !o.all) return die("name the skills to update, or pass --all");
    const unknown = names.filter((n) => !app.config.upstreams.some((p) => p.skills.includes(n)));
    if (unknown.length > 0) return die(`not supplied by any upstream in config.yaml: ${unknown.join(", ")}`);
    if (o.to !== undefined && app.config.upstreams.filter((p) => o.all || p.skills.some((s) => names.includes(s))).length > 1) return die("--to names a ref (or version) of one upstream; pick skills from one upstream");
    const planned = await planUpdate(app, o.all ? { kind: "all" } : { kind: "named", names }, { offline: o.cached, ref: o.to === undefined ? none : some(o.to), force: o.force });
    const plan = planned.ok ? planned.value : die(planned.error);
    plan.reports.forEach((r) => { if (!r.result.ok) say(pc.red(upstreamErrorText(r.result.error))); });
    plan.reports.forEach((r) => { if (r.result.ok && r.result.value.warning.some) say(pc.yellow(`${r.policy.name}: ${r.result.value.warning.value}`)); });
    plan.picked.forEach((x) => say(`${x.action === "write" ? pc.cyan("update") : x.action === "refuse" ? pc.yellow("refuse") : pc.dim("skip  ")} ${x.s.skill}  ${x.s.base.some ? x.s.base.value.label : "—"} → ${x.s.target.label}  ${pc.dim(x.s.state.kind)}${x.s.changes.length > 0 ? pc.dim(`, ${x.s.changes.length} commits`) : ""}`));
    plan.picked.filter((x) => x.action === "refuse").forEach((x) => say(pc.dim(`  ${x.s.skill}: ${stateHint[x.s.state.kind]}`)));

    const errors = plan.reports.flatMap((r) => (r.result.ok ? [] : [upstreamErrorText(r.result.error)]));
    const finish = (backup: string | null, outcomes: readonly UpdateOutcome[]): void => {
      const failed = outcomes.some((x) => x.result === "failed") || errors.length > 0;
      if (o.json) out(JSON.stringify({ backup, outcomes, errors }, null, 2));
      else if (outcomes.some((x) => x.result === "updated")) say(pc.dim("\nnext: `skm plan` to review, then `skm sync` to copy the new versions to every host"));
      // --json readers get each failure in outcomes/errors; the exit code is for people and scripts reading text
      if (failed && !o.json) process.exitCode = 1;
    };

    const writes = toWrite(plan);
    if (writes.length === 0) {
      say(pc.green("\nnothing to write"));
      if (o.dryRun) return;
    } else {
      if (o.dryRun) return say(pc.dim("\n(dry run — nothing changed)"));
      if (!o.yes && (o.json || !confirm(`\nwrite ${writes.length} skills into ${app.storeDir}?`))) return say("aborted");
    }
    const run = await runUpdate(app, plan, {
      backup: o.backup,
      onEvent: (e) => {
        switch (e.kind) {
          case "backup": return say(`backup ${e.dir}  restore: ${pc.cyan(`skm restore ${e.host} ${e.ts}`)}`);
          case "updated": return say(`${pc.green("updated")} ${e.skill} → ${e.label}`);
          case "failed": return say(`${pc.red("failed")} ${e.skill}: ${e.reason}`);
        }
      },
    });
    if (!run.ok) return die(run.error);
    finish(run.value.backup, run.value.outcomes);
  });

/**
 * `skm upstream adopt <name> --repo <url> [skills…]`: declare an upstream for skills already in the store and
 * find, for each, the upstream commit its files equal, so later updates know what an untouched copy looks like.
 */
export const runUpstreamAdopt = async (name: string, skills: readonly string[], o: { repo?: string; path?: string; ref?: string; json: boolean }): Promise<void> =>
  withApp(async (app) => {
    const say = o.json ? () => undefined : out;
    if (!isSafeSkillName(name)) return die("upstream names use letters, digits, '.', '_' and '-'");
    const found = app.config.upstreams.find((p) => p.name === name);
    if (found?.kind === "source") return die(`adopt searches git history; ${name} comes from source ${found.source}. \`skm upstream update\` records the skills that already match the source's version`);
    const existing: GitUpstream | undefined = found;
    const repo = o.repo ?? existing?.repo;
    if (repo === undefined) return die(`--repo is required for a new upstream`);
    const path = o.path ?? existing?.path ?? DEFAULT_UPSTREAM_PATH;
    if (!path.includes("{skill}")) return die("--path must contain {skill}, e.g. skills/{skill}");
    const ref = o.ref !== undefined ? some(o.ref) : existing?.ref ?? none;
    const bad = skills.filter((s) => !isSafeSkillName(s));
    if (bad.length > 0) return die(`not a skill name: ${bad.join(", ")}`);
    const taken = skills.filter((s) => app.config.upstreams.some((p) => p.name !== name && p.skills.includes(s)));
    if (taken.length > 0) return die(`already supplied by another upstream: ${taken.join(", ")}`);

    // with no skills named: every store skill the target ref also has, that no other upstream claims
    const probe: GitUpstream = { kind: "git", name, repo, path, ref, skills: existing?.skills ?? [] };
    const m = await syncMirror(app.skmHome, probe, false);
    if (!m.ok) return die(upstreamErrorText(m.error));
    if (m.value.warning.some) say(pc.yellow(m.value.warning.value));
    const target = await resolveTarget(m.value.gitDir, ref, name);
    if (!target.ok) return die(upstreamErrorText(target.error));
    const offered = await unlistedSkills(m.value.gitDir, { ...probe, skills: [] }, target.value.commit);
    const inStore = new Set(app.skills.map((s) => s.name));
    const claimedElsewhere = new Set(app.config.upstreams.filter((p) => p.name !== name).flatMap((p) => p.skills));
    const chosen = skills.length > 0 ? [...skills] : offered.filter((s) => inStore.has(s) && !claimedElsewhere.has(s));
    if (chosen.length === 0) return die(`no store skill matches a skill dir in ${repo} at ${target.value.label} (path ${path}); name the skills to track`);
    const policy: GitUpstream = { ...probe, skills: [...new Set([...(existing?.skills ?? []), ...chosen])] };

    const digests = new Map((await Promise.all(chosen.map(async (s) => [s, await storeDigest(storePath(app, s))] as const)))
      .flatMap(([s, d]) => (d.some ? [[s, d.value] as const] : [])));
    say(pc.dim(`searching ${name} history for the version of ${digests.size} store skills…`));
    const bases = await findBases(m.value.gitDir, policy, digests);
    const lock0 = await loadLock(app);
    const labels = new Map(await Promise.all([...new Set(bases.values())].map(async (c) => [c, await describe(m.value.gitDir, c)] as const)));
    const lock = [...bases.entries()].reduce((l, [s, c]) => setLockEntry(l, name, s, { rev: c, label: labels.get(c) ?? c.slice(0, 7), digest: digests.get(s) ?? "" }), lock0);

    const next = { ...app.config, upstreams: existing ? app.config.upstreams.map((p) => (p.name === name ? policy : p)) : [...app.config.upstreams, policy] };
    await saveConfig(app.configPath, next);
    await writeLock(app.skmHome, lock);

    const rows = chosen.map((s) => ({ skill: s, inStore: digests.has(s), base: bases.get(s) ?? null, label: bases.has(s) ? labels.get(bases.get(s) ?? "") ?? null : null }));
    if (o.json) return out(JSON.stringify({ upstream: name, repo, path, ref: ref.some ? ref.value : null, target: target.value, skills: rows }, null, 2));
    say(table(["skill", "store version"], rows.map((r) => [r.skill, r.label !== null ? pc.green(r.label) : r.inStore ? pc.yellow("no upstream commit has these files") : pc.dim("not in store")])));
    say(pc.dim(`\nwrote upstreams.${name} to ${app.configPath}. next: \`skm upstream\` to see what changed upstream`));
  });
