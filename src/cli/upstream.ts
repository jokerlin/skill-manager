import pc from "picocolors";
import { hubOf } from "../core/config";
import {
  type LockEntry, type SkillUpstreamState, type StateKind, type UpstreamLock, type UpstreamPolicy,
  DEFAULT_UPSTREAM_PATH, isSafeSkillName, lockEntry, setLockEntry, skillPath, skillState, updateAction,
} from "../core/upstream";
import { type Option, none, some } from "../lib/result";
import type { AppState } from "../shell/app";
import { backupHost } from "../shell/backup";
import { homeDir, nowStamp } from "../shell/paths";
import { hostErrorText } from "../shell/probe";
import { localRunner } from "../shell/runner";
import {
  type Change, type RawEntry, type Target, type UpstreamError,
  changesBetween, describe, findBases, readLock, resolveTarget, skillTrees, storeDigest, syncMirror, unlistedSkills, upstreamErrorText, writeLock, writeSkill,
} from "../shell/upstream";
import { confirm, die, out, saveConfig, table, withApp } from "./common";

export type SkillReport = {
  readonly skill: string;
  readonly state: SkillUpstreamState;
  readonly base: Option<LockEntry>;
  readonly targetDigest: Option<string>;
  readonly entries: Option<readonly RawEntry[]>;
  readonly changes: readonly Change[];
};

export type UpstreamReport = {
  readonly policy: UpstreamPolicy;
  readonly gitDir: string;
  readonly target: Target;
  readonly warning: Option<string>;
  readonly skills: readonly SkillReport[];
  readonly unlisted: readonly string[];
};

const storePath = (app: AppState, skill: string): string => `${app.storeDir}/${skill}`;

/** Fetch (unless offline), resolve the target and judge every skill of one upstream. */
const reportFor = async (app: AppState, lock: UpstreamLock, p: UpstreamPolicy, o: { readonly offline: boolean; readonly ref: Option<string> }): Promise<{ ok: true; value: UpstreamReport } | { ok: false; error: UpstreamError }> => {
  const m = await syncMirror(app.skmHome, p, o.offline);
  if (!m.ok) return m;
  const target = await resolveTarget(m.value.gitDir, o.ref.some ? o.ref : p.ref, p.name);
  if (!target.ok) return target;
  const trees = await skillTrees(m.value.gitDir, p, target.value.commit);
  if (!trees.ok) return trees;
  const skills = await Promise.all(trees.value.map(async (t): Promise<SkillReport> => {
    const base = lockEntry(lock, p.name, t.skill);
    const state = skillState(base.some ? some(base.value.digest) : none, await storeDigest(storePath(app, t.skill)), t.digest);
    const changes = base.some && (state.kind === "behind" || state.kind === "modified") && base.value.commit !== target.value.commit
      ? await changesBetween(m.value.gitDir, base.value.commit, target.value.commit, skillPath(p, t.skill))
      : [];
    return { skill: t.skill, state, base, targetDigest: t.digest, entries: t.entries, changes };
  }));
  const unlisted = await unlistedSkills(m.value.gitDir, p, target.value.commit);
  return { ok: true, value: { policy: p, gitDir: m.value.gitDir, target: target.value, warning: m.value.warning, skills, unlisted } };
};

const stateText = (s: StateKind): string => {
  switch (s) {
    case "current": return pc.green("current");
    case "behind": return pc.cyan("update available");
    case "modified": return pc.yellow("edited locally");
    case "unbased": return pc.yellow("unknown base");
    case "absent": return pc.cyan("not in store");
    case "gone": return pc.red("gone upstream");
  }
};

const stateHint: Readonly<Record<StateKind, string>> = {
  current: "",
  behind: "",
  modified: "the store copy changed since skm wrote it; update refuses unless --force (a backup is taken first)",
  unbased: "skm has no record of which version the store copy is; run `skm upstream adopt` to find it, or update --force",
  absent: "",
  gone: "the target ref has no such dir; update leaves the store copy alone",
};

const skillJson = (s: SkillReport) => ({
  skill: s.skill,
  state: s.state.kind,
  base: s.base.some ? { commit: s.base.value.commit, label: s.base.value.label } : null,
  changes: s.changes,
});

const reportJson = (r: UpstreamReport) => ({
  name: r.policy.name,
  repo: r.policy.repo,
  ref: r.policy.ref.some ? r.policy.ref.value : null,
  target: r.target,
  warning: r.warning.some ? r.warning.value : null,
  error: null,
  skills: r.skills.map(skillJson),
  unlisted: r.unlisted,
});

const loadLock = async (app: AppState): Promise<UpstreamLock> => {
  const l = await readLock(app.skmHome);
  return l.ok ? l.value : die(l.error);
};

const reportsFor = async (app: AppState, lock: UpstreamLock, ps: readonly UpstreamPolicy[], o: { offline: boolean; ref: Option<string> }) =>
  Promise.all(ps.map(async (p) => ({ policy: p, result: await reportFor(app, lock, p, o) })));

/** `skm upstream`: every configured upstream, its target ref, and the state of each skill it supplies. */
export const runUpstream = async (o: { json: boolean; cached: boolean; log: boolean }): Promise<void> =>
  withApp(async (app) => {
    const ups = app.config.upstreams;
    if (ups.length === 0 && !o.json) return out(pc.dim("no upstreams in config.yaml; add one with `skm upstream adopt <name> --repo <url>`"));
    const lock = await loadLock(app);
    const reports = await reportsFor(app, lock, ups, { offline: o.cached, ref: none });
    if (o.json) {
      return out(JSON.stringify({
        upstreams: reports.map((r) => (r.result.ok ? reportJson(r.result.value) : { name: r.policy.name, repo: r.policy.repo, ref: r.policy.ref.some ? r.policy.ref.value : null, target: null, warning: null, error: upstreamErrorText(r.result.error), skills: [], unlisted: [] })),
      }, null, 2));
    }
    reports.forEach((r, i) => {
      if (i > 0) out("");
      if (!r.result.ok) return out(`${pc.bold(r.policy.name)}  ${pc.red(upstreamErrorText(r.result.error))}`);
      const v = r.result.value;
      out(`${pc.bold(v.policy.name)}  ${pc.dim(v.policy.repo)}  → ${pc.bold(v.target.label)} ${pc.dim(v.target.commit.slice(0, 7))}`);
      if (v.warning.some) out(pc.yellow(`  ${v.warning.value}`));
      out(table(["  skill", "state", "store version", "changes"], v.skills.map((s) => [
        `  ${s.skill}`,
        stateText(s.state.kind),
        s.base.some ? s.base.value.label : pc.dim("—"),
        s.changes.length > 0 ? `${s.changes.length} commits` : "",
      ])));
      v.skills.filter((s) => stateHint[s.state.kind] !== "").forEach((s) => out(pc.dim(`  ${s.skill}: ${stateHint[s.state.kind]}`)));
      if (o.log) v.skills.filter((s) => s.changes.length > 0).forEach((s) => {
        out(`\n  ${pc.bold(s.skill)}`);
        s.changes.forEach((c) => out(`    ${pc.dim(`${c.commit} ${c.date}`)} ${c.subject}`));
      });
      if (v.unlisted.length > 0) out(pc.dim(`  also upstream, not tracked: ${v.unlisted.join(", ")} (add to upstreams.${v.policy.name}.skills)`));
    });
    const pending = reports.flatMap((r) => (r.result.ok ? r.result.value.skills.filter((s) => s.state.kind === "behind" || s.state.kind === "absent") : []));
    if (pending.length > 0) out(pc.dim(`\nnext: \`skm upstream update ${pending.map((s) => s.skill).join(" ")}\`${o.log ? "" : " · commit list: `skm upstream --log`"}`));
  });

type UpdateOutcome = { readonly upstream: string; readonly skill: string; readonly from: string | null; readonly to: string; readonly result: "updated" | "skipped" | "refused" | "failed"; readonly reason: string };

/** `skm upstream update [skills…]`: write the target version of each skill into the store, back up first, record it in the lock. */
export const runUpstreamUpdate = async (names: readonly string[], o: { all: boolean; to?: string; force: boolean; yes: boolean; backup: boolean; dryRun: boolean; cached: boolean; json: boolean }): Promise<void> =>
  withApp(async (app) => {
    const say = o.json ? () => undefined : out;
    if (names.length === 0 && !o.all) return die("name the skills to update, or pass --all");
    const unknown = names.filter((n) => !app.config.upstreams.some((p) => p.skills.includes(n)));
    if (unknown.length > 0) return die(`not supplied by any upstream in config.yaml: ${unknown.join(", ")}`);
    const ps = app.config.upstreams.filter((p) => o.all || p.skills.some((s) => names.includes(s)));
    if (o.to !== undefined && ps.length > 1) return die("--to names a ref in one repo; pick skills from one upstream");
    const lock = await loadLock(app);
    const reports = await reportsFor(app, lock, ps, { offline: o.cached, ref: o.to === undefined ? none : some(o.to) });
    reports.forEach((r) => { if (!r.result.ok) say(pc.red(upstreamErrorText(r.result.error))); });
    const ok = reports.flatMap((r) => (r.result.ok ? [r.result.value] : []));
    ok.forEach((r) => { if (r.warning.some) say(pc.yellow(`${r.policy.name}: ${r.warning.value}`)); });
    const picked = ok.flatMap((r) => r.skills.filter((s) => o.all || names.includes(s.skill)).map((s) => ({ r, s, action: updateAction(s.state, o.force) })));
    const toWrite = picked.filter((x) => x.action === "write");
    picked.forEach((x) => say(`${x.action === "write" ? pc.cyan("update") : x.action === "refuse" ? pc.yellow("refuse") : pc.dim("skip  ")} ${x.s.skill}  ${x.s.base.some ? x.s.base.value.label : "—"} → ${x.r.target.label}  ${pc.dim(x.s.state.kind)}${x.s.changes.length > 0 ? pc.dim(`, ${x.s.changes.length} commits`) : ""}`));
    picked.filter((x) => x.action === "refuse").forEach((x) => say(pc.dim(`  ${x.s.skill}: ${stateHint[x.s.state.kind]}`)));

    // skills already equal to the target still get their lock entry moved to it, so the next edit is detected against the right base
    const relock = picked.filter((x) => x.s.state.kind === "current" && (!x.s.base.some || x.s.base.value.commit !== x.r.target.commit || x.s.targetDigest.some && x.s.base.value.digest !== x.s.targetDigest.value));
    const entryFor = (x: (typeof picked)[number]): LockEntry => ({ commit: x.r.target.commit, label: x.r.target.label, digest: x.s.targetDigest.some ? x.s.targetDigest.value : "" });
    const finish = async (outcomes: readonly UpdateOutcome[], backup: string | null, nextLock: UpstreamLock): Promise<void> => {
      if (nextLock !== lock) await writeLock(app.skmHome, nextLock);
      const failed = outcomes.some((x) => x.result === "failed") || reports.some((r) => !r.result.ok);
      if (o.json) out(JSON.stringify({ backup, outcomes, errors: reports.flatMap((r) => (r.result.ok ? [] : [upstreamErrorText(r.result.error)])) }, null, 2));
      else if (outcomes.some((x) => x.result === "updated")) say(pc.dim("\nnext: `skm plan` to review, then `skm sync` to copy the new versions to every host"));
      // --json readers get each failure in outcomes/errors; the exit code is for people and scripts reading text
      if (failed && !o.json) process.exitCode = 1;
    };
    const outcomeOf = (x: (typeof picked)[number], result: UpdateOutcome["result"], reason: string): UpdateOutcome =>
      ({ upstream: x.r.policy.name, skill: x.s.skill, from: x.s.base.some ? x.s.base.value.label : null, to: x.r.target.label, result, reason });
    const notWritten = picked.filter((x) => x.action !== "write").map((x) => outcomeOf(x, x.action === "refuse" ? "refused" : "skipped", x.action === "refuse" ? stateHint[x.s.state.kind] : x.s.state.kind));
    const relocked = relock.reduce((l, x) => setLockEntry(l, x.r.policy.name, x.s.skill, entryFor(x)), lock);

    if (toWrite.length === 0) {
      say(pc.green("\nnothing to write"));
      return o.dryRun ? undefined : finish(notWritten, null, relocked);
    }
    if (o.dryRun) return say(pc.dim("\n(dry run — nothing changed)"));
    if (!o.yes && (o.json || !confirm(`\nwrite ${toWrite.length} skills into ${app.storeDir}?`))) return say("aborted");

    let backup: string | null = null;
    if (o.backup && app.config.backupBeforeApply) {
      const hub = hubOf(app.config);
      const home = homeDir();
      const tilde = (p: string) => (p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);
      const b = await backupHost(hub, localRunner(home, hub.id), [...toWrite.map((x) => tilde(storePath(app, x.s.skill))), tilde(`${app.skmHome}/upstreams.lock.json`)], app.skmHome, nowStamp());
      if (!b.ok) return die(`${hostErrorText(b.error)} — nothing written`);
      backup = b.value.dir;
      say(`backup ${b.value.dir}  restore: ${pc.cyan(`skm restore ${hub.id} ${b.value.ts}`)}`);
    }

    const written = await toWrite.reduce<Promise<{ lock: UpstreamLock; outcomes: UpdateOutcome[] }>>(async (accP, x) => {
      const acc = await accP;
      if (!x.s.entries.some) return { ...acc, outcomes: [...acc.outcomes, outcomeOf(x, "failed", "no files at the target")] };
      const w = await writeSkill(x.r.gitDir, app.storeDir, x.s.skill, x.s.entries.value);
      if (!w.ok) {
        say(`${pc.red("failed")} ${x.s.skill}: ${w.error}`);
        return { ...acc, outcomes: [...acc.outcomes, outcomeOf(x, "failed", w.error)] };
      }
      // read the result back: what landed must hash to what the upstream holds
      const after = await storeDigest(storePath(app, x.s.skill));
      if (!after.some || !x.s.targetDigest.some || after.value !== x.s.targetDigest.value) {
        say(`${pc.red("failed")} ${x.s.skill}: the written files do not match the upstream tree`);
        return { ...acc, outcomes: [...acc.outcomes, outcomeOf(x, "failed", "written files do not match the upstream tree")] };
      }
      say(`${pc.green("updated")} ${x.s.skill} → ${x.r.target.label}`);
      return { lock: setLockEntry(acc.lock, x.r.policy.name, x.s.skill, entryFor(x)), outcomes: [...acc.outcomes, outcomeOf(x, "updated", "")] };
    }, Promise.resolve({ lock: relocked, outcomes: [] }));
    await finish([...written.outcomes, ...notWritten], backup, written.lock);
  });

/**
 * `skm upstream adopt <name> --repo <url> [skills…]`: declare an upstream for skills already in the store and
 * find, for each, the upstream commit its files equal, so later updates know what an untouched copy looks like.
 */
export const runUpstreamAdopt = async (name: string, skills: readonly string[], o: { repo?: string; path?: string; ref?: string; json: boolean }): Promise<void> =>
  withApp(async (app) => {
    const say = o.json ? () => undefined : out;
    if (!isSafeSkillName(name)) return die("upstream names use letters, digits, '.', '_' and '-'");
    const existing = app.config.upstreams.find((p) => p.name === name);
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
    const probe: UpstreamPolicy = { name, repo, path, ref, skills: existing?.skills ?? [] };
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
    const policy: UpstreamPolicy = { ...probe, skills: [...new Set([...(existing?.skills ?? []), ...chosen])] };

    const digests = new Map((await Promise.all(chosen.map(async (s) => [s, await storeDigest(storePath(app, s))] as const)))
      .flatMap(([s, d]) => (d.some ? [[s, d.value] as const] : [])));
    say(pc.dim(`searching ${name} history for the version of ${digests.size} store skills…`));
    const bases = await findBases(m.value.gitDir, policy, digests);
    const lock0 = await loadLock(app);
    const labels = new Map(await Promise.all([...new Set(bases.values())].map(async (c) => [c, await describe(m.value.gitDir, c)] as const)));
    const lock = [...bases.entries()].reduce((l, [s, c]) => setLockEntry(l, name, s, { commit: c, label: labels.get(c) ?? c.slice(0, 7), digest: digests.get(s) ?? "" }), lock0);

    const next = { ...app.config, upstreams: existing ? app.config.upstreams.map((p) => (p.name === name ? policy : p)) : [...app.config.upstreams, policy] };
    await saveConfig(app.configPath, next);
    await writeLock(app.skmHome, lock);

    const rows = chosen.map((s) => ({ skill: s, inStore: digests.has(s), base: bases.get(s) ?? null, label: bases.has(s) ? labels.get(bases.get(s) ?? "") ?? null : null }));
    if (o.json) return out(JSON.stringify({ upstream: name, repo, path, ref: ref.some ? ref.value : null, target: target.value, skills: rows }, null, 2));
    say(table(["skill", "store version"], rows.map((r) => [r.skill, r.label !== null ? pc.green(r.label) : r.inStore ? pc.yellow("no upstream commit has these files") : pc.dim("not in store")])));
    say(pc.dim(`\nwrote upstreams.${name} to ${app.configPath}. next: \`skm upstream\` to see what changed upstream`));
  });
