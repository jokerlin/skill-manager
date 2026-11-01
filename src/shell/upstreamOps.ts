import { hubOf } from "../core/config";
import {
  type GitUpstream, type LockEntry, type SkillUpstreamState, type SourceUpstream, type UpdateAction, type UpstreamLock, type UpstreamPolicy, type Version,
  lockEntry, setLockEntry, skillPath, skillState, stateHint, updateAction,
} from "../core/upstream";
import { type Option, type Result, err, none, ok, some } from "../lib/result";
import type { AppState } from "./app";
import { backupHost } from "./backup";
import { homeDir, nowStamp } from "./paths";
import { hostErrorText } from "./probe";
import { localRunner } from "./runner";
import { checkSource } from "./sources";
import {
  type Change, type RawEntry, type UpstreamError,
  changesBetween, readLock, resolveTarget, skillTrees, storeDigest, syncMirror, unlistedSkills, writeLock, writeSkill, writeSkillFromDir,
} from "./upstream";

/**
 * The upstream flows the CLI and the TUI share: judge every skill of each upstream, then write the chosen ones.
 * Callers do the talking (tables, prompts, log lines); these functions only report what happened.
 */

/** Where an update reads a skill's target files from. */
export type SkillFiles =
  | { readonly kind: "git"; readonly gitDir: string; readonly entries: readonly RawEntry[] }
  | { readonly kind: "dir"; readonly dir: string };

export type SkillReport = {
  readonly skill: string;
  readonly state: SkillUpstreamState;
  readonly base: Option<LockEntry>;
  /** the version an update writes: the upstream's commit for git, this skill's own version for a source */
  readonly target: Version;
  readonly targetDigest: Option<string>;
  readonly files: Option<SkillFiles>;
  /** upstream commits between base and target that touch the skill (git only) */
  readonly changes: readonly Change[];
};

export type UpstreamReport = {
  readonly policy: UpstreamPolicy;
  /** the one version every skill targets (git); none when each skill has its own (source) */
  readonly target: Option<Version>;
  readonly warning: Option<string>;
  readonly skills: readonly SkillReport[];
  readonly unlisted: readonly string[];
};

export type UpstreamResult = { readonly policy: UpstreamPolicy; readonly result: Result<UpstreamReport, UpstreamError> };

export type CheckOptions = { readonly offline: boolean; readonly ref: Option<string> };

const storePath = (app: AppState, skill: string): string => `${app.storeDir}/${skill}`;

const stateOf = async (app: AppState, base: Option<LockEntry>, skill: string, target: Option<string>): Promise<SkillUpstreamState> =>
  skillState(base.some ? some(base.value.digest) : none, await storeDigest(storePath(app, skill)), target);

/** Fetch the mirror (unless offline), resolve the target commit and judge every skill of one git upstream. */
const gitReport = async (app: AppState, lock: UpstreamLock, p: GitUpstream, o: CheckOptions): Promise<Result<UpstreamReport, UpstreamError>> => {
  const m = await syncMirror(app.skmHome, p, o.offline);
  if (!m.ok) return m;
  const target = await resolveTarget(m.value.gitDir, o.ref.some ? o.ref : p.ref, p.name);
  if (!target.ok) return target;
  const version: Version = { rev: target.value.commit, label: target.value.label };
  const trees = await skillTrees(m.value.gitDir, p, target.value.commit);
  if (!trees.ok) return trees;
  const skills = await Promise.all(trees.value.map(async (t): Promise<SkillReport> => {
    const base = lockEntry(lock, p.name, t.skill);
    const state = await stateOf(app, base, t.skill, t.digest);
    const changes = base.some && (state.kind === "behind" || state.kind === "modified") && base.value.rev !== version.rev
      ? await changesBetween(m.value.gitDir, base.value.rev, version.rev, skillPath(p, t.skill))
      : [];
    const files: Option<SkillFiles> = t.entries.some ? some({ kind: "git", gitDir: m.value.gitDir, entries: t.entries.value }) : none;
    return { skill: t.skill, state, base, target: version, targetDigest: t.digest, files, changes };
  }));
  const unlisted = await unlistedSkills(m.value.gitDir, p, target.value.commit);
  return ok({ policy: p, target: some(version), warning: m.value.warning, skills, unlisted });
};

/** Ask the source for each skill's version (unless offline or pinned), fetch it, and judge it. */
const sourceReport = async (app: AppState, lock: UpstreamLock, p: SourceUpstream, o: CheckOptions): Promise<Result<UpstreamReport, UpstreamError>> => {
  const fetched = await checkSource(app.skmHome, app.config.registry.sources, p, o);
  if (!fetched.ok) return fetched;
  const skills = await Promise.all(fetched.value.map(async (t): Promise<SkillReport> => {
    const base = lockEntry(lock, p.name, t.skill);
    return { skill: t.skill, state: await stateOf(app, base, t.skill, t.digest), base, target: t.version, targetDigest: t.digest, files: some({ kind: "dir", dir: t.dir }), changes: [] };
  }));
  return ok({ policy: p, target: none, warning: none, skills, unlisted: [] });
};

const reportFor = (app: AppState, lock: UpstreamLock, p: UpstreamPolicy, o: CheckOptions): Promise<Result<UpstreamReport, UpstreamError>> => {
  switch (p.kind) {
    case "git": return gitReport(app, lock, p, o);
    case "source": return sourceReport(app, lock, p, o);
  }
};

export const reportsFor = async (app: AppState, lock: UpstreamLock, ps: readonly UpstreamPolicy[], o: CheckOptions): Promise<readonly UpstreamResult[]> =>
  Promise.all(ps.map(async (p) => ({ policy: p, result: await reportFor(app, lock, p, o) })));

/** Every configured upstream, judged against the lock on disk. */
export const checkUpstreams = async (app: AppState, o: CheckOptions): Promise<Result<readonly UpstreamResult[], string>> => {
  const lock = await readLock(app.skmHome);
  return lock.ok ? ok(await reportsFor(app, lock.value, app.config.upstreams, o)) : lock;
};

// ---------- update ----------

export type Pick = { readonly r: UpstreamReport; readonly s: SkillReport; readonly action: UpdateAction };

export type UpdatePlan = {
  readonly lock: UpstreamLock;                  // the lock as read
  readonly reports: readonly UpstreamResult[];
  readonly picked: readonly Pick[];
  /** `lock` plus skills already equal to the target, moved onto it so the next edit is judged against the right base */
  readonly relocked: UpstreamLock;
};

export type UpdateOutcome = {
  readonly upstream: string;
  readonly skill: string;
  readonly from: string | null;
  readonly to: string;
  readonly result: "updated" | "skipped" | "refused" | "failed";
  readonly reason: string;
};

/** What `runUpdate` reports while it works, for the caller to show. */
export type UpdateEvent =
  | { readonly kind: "backup"; readonly dir: string; readonly host: string; readonly ts: string }
  | { readonly kind: "updated"; readonly skill: string; readonly label: string }
  | { readonly kind: "failed"; readonly skill: string; readonly reason: string };

export type UpdateRun = { readonly backup: string | null; readonly outcomes: readonly UpdateOutcome[] };

export type Selection = { readonly kind: "all" } | { readonly kind: "named"; readonly names: readonly string[] };

const entryFor = (x: Pick): LockEntry => ({ rev: x.s.target.rev, label: x.s.target.label, digest: x.s.targetDigest.some ? x.s.targetDigest.value : "" });

const outcomeOf = (x: Pick, result: UpdateOutcome["result"], reason: string): UpdateOutcome =>
  ({ upstream: x.r.policy.name, skill: x.s.skill, from: x.s.base.some ? x.s.base.value.label : null, to: x.s.target.label, result, reason });

const chosen = (sel: Selection, skill: string): boolean => sel.kind === "all" || sel.names.includes(skill);

/** Judge the selected skills and decide, per skill, whether an update writes, skips or refuses. Writes nothing. */
export const planUpdate = async (app: AppState, sel: Selection, o: CheckOptions & { readonly force: boolean }): Promise<Result<UpdatePlan, string>> => {
  const lock = await readLock(app.skmHome);
  if (!lock.ok) return lock;
  const ps = app.config.upstreams.filter((p) => p.skills.some((s) => chosen(sel, s)));
  const reports = await reportsFor(app, lock.value, ps, o);
  const picked = reports.flatMap((x) => (x.result.ok ? [x.result.value] : []))
    .flatMap((r) => r.skills.filter((s) => chosen(sel, s.skill)).map((s) => ({ r, s, action: updateAction(s.state, o.force) })));
  const relocked = picked
    .filter((x) => x.s.state.kind === "current" && (!x.s.base.some || x.s.base.value.rev !== x.s.target.rev || (x.s.targetDigest.some && x.s.base.value.digest !== x.s.targetDigest.value)))
    .reduce((l, x) => setLockEntry(l, x.r.policy.name, x.s.skill, entryFor(x)), lock.value);
  return ok({ lock: lock.value, reports, picked, relocked });
};

export const toWrite = (p: UpdatePlan): readonly Pick[] => p.picked.filter((x) => x.action === "write");

/** Outcomes for the picked skills an update does not write. */
export const notWritten = (p: UpdatePlan): readonly UpdateOutcome[] =>
  p.picked.filter((x) => x.action !== "write").map((x) => outcomeOf(x, x.action === "refuse" ? "refused" : "skipped", x.action === "refuse" ? stateHint[x.s.state.kind] : x.s.state.kind));

/**
 * Back up the replaced store dirs and the lock (when `backup` and the config's backup setting are on), write each
 * skill from the mirror, read it back, and save the lock. A failed backup writes nothing.
 */
export const runUpdate = async (app: AppState, plan: UpdatePlan, o: { readonly backup: boolean; readonly onEvent: (e: UpdateEvent) => void }): Promise<Result<UpdateRun, string>> => {
  const picks = toWrite(plan);
  const skipped = notWritten(plan);
  if (picks.length === 0) {
    if (plan.relocked !== plan.lock) await writeLock(app.skmHome, plan.relocked);
    return ok({ backup: null, outcomes: skipped });
  }
  const backup = o.backup && app.config.backupBeforeApply ? await backupStore(app, picks) : ok(null);
  if (!backup.ok) return err(`${backup.error} — nothing written`);
  if (backup.value !== null) o.onEvent({ kind: "backup", ...backup.value });

  const written = await picks.reduce<Promise<{ lock: UpstreamLock; outcomes: readonly UpdateOutcome[] }>>(async (accP, x) => {
    const acc = await accP;
    const fail = (reason: string) => {
      o.onEvent({ kind: "failed", skill: x.s.skill, reason });
      return { ...acc, outcomes: [...acc.outcomes, outcomeOf(x, "failed", reason)] };
    };
    if (!x.s.files.some) return fail("no files at the target");
    const w = await writeFiles(app.storeDir, x.s.skill, x.s.files.value);
    if (!w.ok) return fail(w.error);
    // read the result back: what landed must hash to what the upstream holds
    const after = await storeDigest(storePath(app, x.s.skill));
    if (!after.some || !x.s.targetDigest.some || after.value !== x.s.targetDigest.value) return fail("the written files do not match the upstream tree");
    o.onEvent({ kind: "updated", skill: x.s.skill, label: x.s.target.label });
    return { lock: setLockEntry(acc.lock, x.r.policy.name, x.s.skill, entryFor(x)), outcomes: [...acc.outcomes, outcomeOf(x, "updated", "")] };
  }, Promise.resolve({ lock: plan.relocked, outcomes: [] }));
  if (written.lock !== plan.lock) await writeLock(app.skmHome, written.lock);
  return ok({ backup: backup.value?.dir ?? null, outcomes: [...written.outcomes, ...skipped] });
};

const writeFiles = (storeDir: string, skill: string, f: SkillFiles): Promise<Result<void, string>> => {
  switch (f.kind) {
    case "git": return writeSkill(f.gitDir, storeDir, skill, f.entries);
    case "dir": return writeSkillFromDir(f.dir, storeDir, skill);
  }
};

const backupStore = async (app: AppState, picks: readonly Pick[]): Promise<Result<{ readonly dir: string; readonly host: string; readonly ts: string }, string>> => {
  const hub = hubOf(app.config);
  const home = homeDir();
  const tilde = (p: string) => (p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);
  const b = await backupHost(hub, localRunner(home, hub.id), [...picks.map((x) => tilde(storePath(app, x.s.skill))), tilde(`${app.skmHome}/upstreams.lock.json`)], app.skmHome, nowStamp());
  return b.ok ? ok({ dir: b.value.dir, host: hub.id, ts: b.value.ts }) : err(hostErrorText(b.error));
};
