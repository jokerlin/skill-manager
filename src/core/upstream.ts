import { createHash } from "node:crypto";
import { type Option, type Result, err, none, ok, some } from "../lib/result";

/**
 * Skills whose store copy comes from a git repository (an "upstream").
 * Pure: config shape, the directory digest both sides share, the state of each skill, tag choice, the lock file.
 */

/** One upstream under `upstreams:` in config.yaml. */
export type UpstreamPolicy = {
  readonly name: string;
  readonly repo: string;                 // anything `git clone` accepts
  readonly ref: Option<string>;          // branch, tag or commit; none ⇒ the newest release tag (vX.Y.Z), else the default branch
  readonly path: string;                 // where a skill lives in the repo; `{skill}` is the skill name
  readonly skills: readonly string[];    // store names; the repo dir has the same name
};

export const DEFAULT_UPSTREAM_PATH = "skills/{skill}";

const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
export const isSafeSkillName = (s: string): boolean => SAFE_NAME.test(s) && !s.includes("..");

/** Repo path of one skill. */
export const skillPath = (p: UpstreamPolicy, skill: string): string => p.path.replaceAll("{skill}", skill);

/** The directory that holds every skill when `{skill}` is the last path segment; none ⇒ skm cannot list new upstream skills. */
export const skillParent = (path: string): Option<string> => {
  if (path === "{skill}") return some("");
  if (!path.endsWith("/{skill}")) return none;
  const parent = path.slice(0, -"/{skill}".length);
  return parent.includes("{skill}") ? none : some(parent);
};

export type UpstreamConfigError = { readonly path: string; readonly message: string };

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

export const parseUpstream = (name: string, v: unknown): Result<UpstreamPolicy, UpstreamConfigError> => {
  const at = `upstreams.${name}`;
  if (!isSafeSkillName(name)) return err({ path: at, message: "upstream names use letters, digits, '.', '_' and '-'" });
  if (!isRecord(v)) return err({ path: at, message: "expected a map with repo: and skills:" });
  const repo = v["repo"];
  if (typeof repo !== "string" || repo.trim() === "") return err({ path: `${at}.repo`, message: "expected a git URL or path" });
  const ref = v["ref"];
  if (ref !== undefined && (typeof ref !== "string" || ref.trim() === "")) return err({ path: `${at}.ref`, message: "expected a branch, tag or commit" });
  const path = v["path"] ?? DEFAULT_UPSTREAM_PATH;
  if (typeof path !== "string" || !path.includes("{skill}")) return err({ path: `${at}.path`, message: "expected a repo path that contains {skill}, e.g. skills/{skill}" });
  if (path.startsWith("/") || path.split("/").includes("..")) return err({ path: `${at}.path`, message: "expected a path inside the repo" });
  const skills = v["skills"];
  if (!Array.isArray(skills) || skills.length === 0 || !skills.every((s) => typeof s === "string")) return err({ path: `${at}.skills`, message: "expected a non-empty list of skill names" });
  const bad = (skills as string[]).filter((s) => !isSafeSkillName(s));
  if (bad.length > 0) return err({ path: `${at}.skills`, message: `not a skill name: ${bad.join(", ")}` });
  return ok({ name, repo: repo.trim(), ref: ref === undefined ? none : some((ref as string).trim()), path, skills: [...new Set(skills as string[])] });
};

/** Every skill name claimed by more than one upstream. */
export const duplicateClaims = (ps: readonly UpstreamPolicy[]): readonly string[] => {
  const seen = ps.flatMap((p) => p.skills);
  return [...new Set(seen.filter((s, i) => seen.indexOf(s) !== i))];
};

export const upstreamToRaw = (p: UpstreamPolicy): Raw => ({
  repo: p.repo,
  ...(p.ref.some ? { ref: p.ref.value } : {}),
  ...(p.path === DEFAULT_UPSTREAM_PATH ? {} : { path: p.path }),
  skills: [...p.skills],
});

export const upstreamFor = (ps: readonly UpstreamPolicy[], skill: string): Option<UpstreamPolicy> => {
  const p = ps.find((x) => x.skills.includes(skill));
  return p ? some(p) : none;
};

// ---------- digest ----------

/** One file of a skill dir: its path inside the dir and its git blob id (a symlink's blob is its target). */
export type TreeEntry = { readonly path: string; readonly blob: string };

/** Files neither side counts or copies: OS and interpreter litter that never belongs to a skill. */
export const ignoredFile = (rel: string): boolean => {
  const parts = rel.split("/");
  return parts.some((s) => s === ".DS_Store" || s === "__pycache__" || s === ".git") || rel.endsWith(".pyc");
};

/** Git's blob id of some bytes, so the store copy and a repo tree hash the same way without checking anything out. */
export const gitBlobId = (bytes: Uint8Array): string =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

/** Content digest of a skill dir. Same files ⇒ same digest, wherever they live; file modes do not count. */
export const treeDigest = (entries: readonly TreeEntry[]): string =>
  createHash("sha256")
    .update(entries.filter((e) => !ignoredFile(e.path)).map((e) => `${e.path}\0${e.blob}\n`).sort().join(""))
    .digest("hex");

// ---------- state ----------

/**
 * One store skill against its upstream. `base` is the digest skm last wrote (from the lock),
 * `store` what the store holds now, `target` what the upstream ref holds.
 */
export type SkillUpstreamState =
  | { readonly kind: "current" }       // store already matches the target
  | { readonly kind: "behind" }        // store is the untouched base; the target moved on
  | { readonly kind: "modified" }      // someone edited the store copy since skm wrote it
  | { readonly kind: "unbased" }       // no lock entry and the store differs: skm cannot tell an edit from an old version
  | { readonly kind: "absent" }        // listed in config, not in the store yet
  | { readonly kind: "gone" };         // the target ref has no such dir

export type StateKind = SkillUpstreamState["kind"];

export const skillState = (base: Option<string>, store: Option<string>, target: Option<string>): SkillUpstreamState => {
  if (!target.some) return { kind: "gone" };
  if (!store.some) return { kind: "absent" };
  if (store.value === target.value) return { kind: "current" };
  if (!base.some) return { kind: "unbased" };
  return store.value === base.value ? { kind: "behind" } : { kind: "modified" };
};

/** What `skm upstream update` does with a skill in this state. */
export type UpdateAction = "write" | "skip" | "refuse";

export const updateAction = (s: SkillUpstreamState, force: boolean): UpdateAction => {
  switch (s.kind) {
    case "behind":
    case "absent":
      return "write";
    case "modified":
    case "unbased":
      return force ? "write" : "refuse";
    case "current":
    case "gone":
      return "skip";
  }
};

// ---------- refs ----------

const RELEASE_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** The newest release tag (vX.Y.Z or X.Y.Z, no pre-release suffix); none when the repo has none. */
export const latestReleaseTag = (tags: readonly string[]): Option<string> => {
  const parsed = tags.flatMap((t) => {
    const m = RELEASE_TAG.exec(t.trim());
    return m ? [{ tag: t.trim(), v: [Number(m[1]), Number(m[2]), Number(m[3])] as const }] : [];
  });
  const best = parsed.reduce<(typeof parsed)[number] | undefined>(
    (acc, x) => (acc === undefined || x.v[0] > acc.v[0] || (x.v[0] === acc.v[0] && (x.v[1] > acc.v[1] || (x.v[1] === acc.v[1] && x.v[2] > acc.v[2]))) ? x : acc),
    undefined,
  );
  return best ? some(best.tag) : none;
};

const UNLISTED_SHOWN = 3;

/**
 * The human line for skill dirs an upstream has but the config does not track. A repo can hold hundreds
 * (bytedcli ships ~300 bytedance-* guides), so a long list becomes a count plus a few examples; `--json` keeps every name.
 */
export const unlistedSummary = (upstream: string, names: readonly string[]): Option<string> => {
  if (names.length === 0) return none;
  if (names.length <= UNLISTED_SHOWN) return some(`also upstream, not tracked: ${names.join(", ")} (add to upstreams.${upstream}.skills)`);
  return some(`also upstream, not tracked: ${names.length} skills (${names.slice(0, UNLISTED_SHOWN).join(", ")}, …; all names: \`skm upstream --json\`)`);
};

// ---------- lock ----------

/** What skm last wrote for one skill. */
export type LockEntry = {
  readonly commit: string;   // the upstream commit the files came from
  readonly label: string;    // human name of that commit: a tag, or `git describe` output
  readonly digest: string;   // treeDigest of the files written
};

/** upstream name → skill → entry */
export type UpstreamLock = Readonly<Record<string, Readonly<Record<string, LockEntry>>>>;

export const EMPTY_LOCK: UpstreamLock = {};

const isEntry = (v: unknown): v is LockEntry =>
  isRecord(v) && typeof v["commit"] === "string" && typeof v["label"] === "string" && typeof v["digest"] === "string";

export const parseLock = (text: string): Result<UpstreamLock, string> => {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
  if (!isRecord(doc) || doc["version"] !== 1 || !isRecord(doc["upstreams"])) return err("expected { version: 1, upstreams: { … } }");
  const ups = Object.entries(doc["upstreams"]).map(([name, skills]) =>
    isRecord(skills) && Object.values(skills).every(isEntry) ? ok([name, skills as Record<string, LockEntry>] as const) : err(`bad entry under upstreams.${name}`));
  const bad = ups.find((u) => !u.ok);
  if (bad && !bad.ok) return err(bad.error);
  return ok(Object.fromEntries(ups.flatMap((u) => (u.ok ? [u.value] : []))));
};

export const serializeLock = (l: UpstreamLock): string => {
  const sorted = Object.fromEntries(Object.keys(l).sort().map((n) => [n, Object.fromEntries(Object.keys(l[n] ?? {}).sort().map((s) => [s, l[n]?.[s]]))]));
  return `${JSON.stringify({ version: 1, upstreams: sorted }, null, 2)}\n`;
};

export const lockEntry = (l: UpstreamLock, upstream: string, skill: string): Option<LockEntry> => {
  const e = l[upstream]?.[skill];
  return e ? some(e) : none;
};

export const setLockEntry = (l: UpstreamLock, upstream: string, skill: string, e: LockEntry): UpstreamLock => ({
  ...l,
  [upstream]: { ...(l[upstream] ?? {}), [skill]: e },
});
