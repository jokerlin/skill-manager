import { chmod, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { type Option, type Result, err, none, ok, some } from "../lib/result";
import {
  type LockEntry, type TreeEntry, type UpstreamLock, type UpstreamPolicy,
  EMPTY_LOCK, gitBlobId, ignoredFile, latestReleaseTag, parseLock, serializeLock, skillParent, skillPath, treeDigest,
} from "../core/upstream";
import { exec, runError } from "./runner";

/**
 * Side effects for `skm upstream`: a bare mirror of each upstream repo under <skm>/cache/upstreams,
 * reading trees and blobs out of it, digesting store dirs, and swapping a skill dir in the store.
 * Files are written from git blobs directly, so .gitattributes export rules never change what lands.
 */

export type UpstreamError = { readonly upstream: string; readonly step: string; readonly detail: string };
export const upstreamErrorText = (e: UpstreamError): string => `${e.upstream}: ${e.step} failed: ${e.detail}`;

const git = (gitDir: string, args: readonly string[], timeoutMs = 120_000) =>
  exec(["git", "--git-dir", gitDir, ...args], { timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });

export const mirrorDir = (skm: string, name: string): string => `${skm}/cache/upstreams/${name}.git`;

const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

/**
 * Make the bare mirror exist and, unless `offline`, fetch every branch and tag.
 * A failed fetch with an existing mirror degrades to the cached refs and reports a warning.
 */
export const syncMirror = async (skm: string, p: UpstreamPolicy, offline: boolean): Promise<Result<{ readonly gitDir: string; readonly warning: Option<string> }, UpstreamError>> => {
  const gitDir = mirrorDir(skm, p.name);
  const fail = (step: string, detail: string) => err<UpstreamError>({ upstream: p.name, step, detail });
  if (!(await exists(gitDir))) {
    if (offline) return fail("read cache", `no mirror at ${gitDir}; run without --cached once`);
    await mkdir(dirname(gitDir), { recursive: true });
    const c = await exec(["git", "clone", "--bare", "--quiet", p.repo, gitDir], { timeoutMs: 600_000, env: { GIT_TERMINAL_PROMPT: "0" } });
    if (!c.ok) {
      await rm(gitDir, { recursive: true, force: true });
      return fail("clone", runError(c.error));
    }
  }
  if (offline) return ok({ gitDir, warning: none });
  // the URL in config.yaml is the truth; follow it when it changes
  const url = await git(gitDir, ["remote", "set-url", "origin", p.repo]);
  if (!url.ok) return fail("set remote", runError(url.error));
  const f = await git(gitDir, ["fetch", "--quiet", "--prune", "--prune-tags", "--force", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], 600_000);
  return ok({ gitDir, warning: f.ok ? none : some(`fetch failed, using the cached mirror: ${runError(f.error)}`) });
};

export type Target = { readonly commit: string; readonly label: string };

/** A commit's human name: the tag on it, else `git describe` (v1.2.0-5-gabc1234), else the short hash. */
export const describe = async (gitDir: string, commit: string): Promise<string> => {
  const d = await git(gitDir, ["describe", "--tags", "--always", commit]);
  return d.ok ? d.value.stdout.trim() : commit.slice(0, 7);
};

/** The commit `ref` names; no ref ⇒ the newest release tag, or the default branch when there is none. */
export const resolveTarget = async (gitDir: string, ref: Option<string>, upstream: string): Promise<Result<Target, UpstreamError>> => {
  const name = ref.some
    ? ref.value
    : await git(gitDir, ["tag", "--list"]).then((t) => (t.ok ? latestReleaseTag(t.value.stdout.split("\n")) : none)).then((t) => (t.some ? t.value : "HEAD"));
  const c = await git(gitDir, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
  if (!c.ok) return err({ upstream, step: "resolve ref", detail: `${name} is not a branch, tag or commit in the repo` });
  const commit = c.value.stdout.trim();
  return ok({ commit, label: name === "HEAD" ? await describe(gitDir, commit) : name });
};

/** A repo file: its blob, path inside the skill dir, and git mode (100644, 100755, 120000). */
export type RawEntry = TreeEntry & { readonly mode: string };

/** Every file under each repo path at a commit, grouped by path; a path with no files is absent. */
const lsTree = async (gitDir: string, commit: string, paths: readonly string[]): Promise<Result<ReadonlyMap<string, readonly RawEntry[]>, string>> => {
  const r = await git(gitDir, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", ...paths.map((p) => `${p}/`)]);
  if (!r.ok) return err(runError(r.error));
  const rows = r.value.stdout.split("\0").filter((l) => l !== "").flatMap((l) => {
    const tab = l.indexOf("\t");
    const [mode = "", type = "", blob = ""] = l.slice(0, tab).split(" ");
    return type === "blob" ? [{ mode, blob, full: l.slice(tab + 1) }] : [];
  });
  return ok(new Map(paths.map((p) => [p, rows.filter((x) => x.full.startsWith(`${p}/`)).map((x) => ({ mode: x.mode, blob: x.blob, path: x.full.slice(p.length + 1) })).filter((e) => !ignoredFile(e.path))])));
};

export type UpstreamSkillTree = { readonly skill: string; readonly entries: Option<readonly RawEntry[]>; readonly digest: Option<string> };

/** The policy's skills as the commit holds them. */
export const skillTrees = async (gitDir: string, p: UpstreamPolicy, commit: string): Promise<Result<readonly UpstreamSkillTree[], UpstreamError>> => {
  const t = await lsTree(gitDir, commit, p.skills.map((s) => skillPath(p, s)));
  if (!t.ok) return err({ upstream: p.name, step: "read tree", detail: t.error });
  return ok(p.skills.map((skill) => {
    const es = t.value.get(skillPath(p, skill)) ?? [];
    return es.length === 0 ? { skill, entries: none, digest: none } : { skill, entries: some(es), digest: some(treeDigest(es)) };
  }));
};

/** Skill dirs (a dir with SKILL.md under the parent of `{skill}`) that the commit has and the policy does not list. */
export const unlistedSkills = async (gitDir: string, p: UpstreamPolicy, commit: string): Promise<readonly string[]> => {
  const parent = skillParent(p.path);
  if (!parent.some) return [];
  const prefix = parent.value === "" ? "" : `${parent.value}/`;
  const r = await git(gitDir, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", commit, ...(prefix === "" ? [] : ["--", prefix])]);
  if (!r.ok) return [];
  const names = r.value.stdout.split("\0").flatMap((f) => {
    const rest = f.startsWith(prefix) ? f.slice(prefix.length) : "";
    const parts = rest.split("/");
    return parts.length === 2 && parts[1] === "SKILL.md" && parts[0] ? [parts[0]] : [];
  });
  return [...new Set(names)].filter((n) => !p.skills.includes(n)).sort();
};

export type Change = { readonly commit: string; readonly date: string; readonly subject: string };

/** Commits in from..to that touch the path, newest first. */
export const changesBetween = async (gitDir: string, from: string, to: string, path: string): Promise<readonly Change[]> => {
  const r = await git(gitDir, ["log", "--no-merges", "--format=%h%x09%cs%x09%s", `${from}..${to}`, "--", path]);
  if (!r.ok) return [];
  return r.value.stdout.split("\n").filter((l) => l !== "").map((l) => {
    const [commit = "", date = "", ...s] = l.split("\t");
    return { commit, date, subject: s.join("\t") };
  });
};

/**
 * For each skill, the newest commit (on any branch or tag) whose files equal the store copy.
 * Only commits that touch a skill's path can change it, so those are the candidates.
 */
export const findBases = async (gitDir: string, p: UpstreamPolicy, digests: ReadonlyMap<string, string>): Promise<ReadonlyMap<string, string>> => {
  const wanted = p.skills.filter((s) => digests.has(s));
  if (wanted.length === 0) return new Map();
  const paths = wanted.map((s) => skillPath(p, s));
  // topo order: children before parents even when commits share a timestamp
  const revs = await git(gitDir, ["rev-list", "--topo-order", "--all", "--", ...paths], 300_000);
  if (!revs.ok) return new Map();
  const commits = revs.value.stdout.split("\n").filter((l) => l !== "");
  // newest first: the first match per skill is the most recent commit with those exact files
  return commits.reduce<Promise<Map<string, string>>>(async (accP, c) => {
    const acc = await accP;
    const open = wanted.filter((s) => !acc.has(s));
    if (open.length === 0) return acc;
    const t = await lsTree(gitDir, c, open.map((s) => skillPath(p, s)));
    if (!t.ok) return acc;
    open.forEach((s) => {
      const es = t.value.get(skillPath(p, s)) ?? [];
      if (es.length > 0 && treeDigest(es) === digests.get(s)) acc.set(s, c);
    });
    return acc;
  }, Promise.resolve(new Map()));
};

// ---------- store side ----------

const walkEntries = async (root: string, dir: string): Promise<TreeEntry[]> => {
  const items = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(items.map(async (it): Promise<TreeEntry[]> => {
    const full = join(dir, it.name);
    const rel = relative(root, full);
    if (ignoredFile(rel)) return [];
    if (it.isDirectory()) return walkEntries(root, full);
    if (it.isSymbolicLink()) return [{ path: rel, blob: gitBlobId(new TextEncoder().encode(await readlink(full))) }];
    if (it.isFile()) return [{ path: rel, blob: gitBlobId(new Uint8Array(await readFile(full))) }];
    return [];
  }));
  return nested.flat();
};

/** Digest of a store skill dir; none when it does not exist. */
export const storeDigest = async (dir: string): Promise<Option<string>> => {
  const st = await lstat(dir).catch(() => undefined);
  if (st === undefined || !(st.isDirectory() || st.isSymbolicLink())) return none;
  const es = await walkEntries(dir, dir).catch(() => undefined);
  return es === undefined ? none : some(treeDigest(es));
};

/** Read blobs in one `git cat-file --batch` run. */
const readBlobs = async (gitDir: string, ids: readonly string[]): Promise<Result<ReadonlyMap<string, Uint8Array>, string>> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return ok(new Map());
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", "--git-dir", gitDir, "cat-file", "--batch"], { stdin: new TextEncoder().encode(unique.join("\n") + "\n"), stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  const [buf, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream).arrayBuffer(), new Response(proc.stderr as ReadableStream).text(), proc.exited]);
  if (code !== 0) return err(stderr.trim() || `git cat-file exit ${code}`);
  const bytes = new Uint8Array(buf);
  const out = new Map<string, Uint8Array>();
  let pos = 0;
  for (const id of unique) {
    const nl = bytes.indexOf(10, pos);
    const header = new TextDecoder().decode(bytes.subarray(pos, nl)).split(" ");
    if (header[0] !== id || header[1] !== "blob") return err(`unexpected cat-file header for ${id}: ${header.join(" ")}`);
    const size = Number(header[2]);
    out.set(id, bytes.slice(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return ok(out);
};

/**
 * Write the skill's files into `<store>/.upstream-<skill>` (a dot dir the store scan skips), then swap it in.
 * The old dir is removed only after the new one is complete, so a failure leaves the store copy as it was.
 */
export const writeSkill = async (gitDir: string, storeDir: string, skill: string, entries: readonly RawEntry[]): Promise<Result<void, string>> => {
  const blobs = await readBlobs(gitDir, entries.map((e) => e.blob));
  if (!blobs.ok) return blobs;
  const tmp = join(storeDir, `.upstream-${skill}`);
  const dest = join(storeDir, skill);
  const old = join(storeDir, `.upstream-old-${skill}`);
  try {
    await rm(tmp, { recursive: true, force: true });
    await rm(old, { recursive: true, force: true });
    for (const e of entries) {
      const f = join(tmp, e.path);
      await mkdir(dirname(f), { recursive: true });
      const data = blobs.value.get(e.blob) ?? new Uint8Array();
      if (e.mode === "120000") await symlink(new TextDecoder().decode(data), f);
      else {
        await writeFile(f, data);
        await chmod(f, e.mode === "100755" ? 0o755 : 0o644);
      }
    }
    if (await exists(dest)) await rename(dest, old);
    await rename(tmp, dest);
    await rm(old, { recursive: true, force: true });
    return ok(undefined);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    if (!(await exists(dest)) && (await exists(old))) await rename(old, dest).catch(() => undefined);
    return err(e instanceof Error ? e.message : String(e));
  }
};

// ---------- lock file ----------

export const lockPath = (skm: string): string => `${skm}/upstreams.lock.json`;

export const readLock = async (skm: string): Promise<Result<UpstreamLock, string>> => {
  const text = await readFile(lockPath(skm), "utf8").catch(() => undefined);
  if (text === undefined) return ok(EMPTY_LOCK);
  const l = parseLock(text);
  return l.ok ? l : err(`${lockPath(skm)}: ${l.error}`);
};

export const writeLock = async (skm: string, l: UpstreamLock): Promise<void> => {
  await mkdir(skm, { recursive: true });
  const tmp = `${lockPath(skm)}.tmp`;
  await writeFile(tmp, serializeLock(l), "utf8");
  await rename(tmp, lockPath(skm));
};

export type { LockEntry };
