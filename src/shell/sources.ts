import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RegistrySource } from "../core/extensions";
import { type SourceUpstream, type Version, ignoredFile } from "../core/upstream";
import { type Option, type Result, err, none, ok, some } from "../lib/result";
import { exec, runError } from "./runner";
import { type UpstreamError, storeDigest } from "./upstream";

/**
 * Side effects for upstreams served by an extension's `sources:` entry: run its `latest` and `fetch` commands,
 * and keep each fetched version under <skm>/cache/sources/<upstream>/<skill>/<version>/ so a check without the
 * network (`--cached`) and a later update read the same files the check digested.
 */

/** One skill of a source upstream at its target version. */
export type SourceSkill = {
  readonly skill: string;
  readonly version: Version;
  /** the fetched files (the skill root) */
  readonly dir: string;
  readonly digest: Option<string>;
};

const COMMAND_TIMEOUT_MS = 300_000;
/** A version becomes a cache dir name, so it must be one path segment. */
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

export const sourceCacheDir = (skm: string, upstream: string, skill: string): string => `${skm}/cache/sources/${upstream}/${skill}`;
const latestFile = (skm: string, upstream: string, skill: string): string => `${sourceCacheDir(skm, upstream, skill)}/latest`;

const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

/** The env a source command sees: the upstream's params upper-cased, then what skm sets itself. */
const envFor = (p: SourceUpstream, extra: Readonly<Record<string, string>>): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(p.params).map(([k, v]) => [k.toUpperCase(), v])),
  ...extra,
});

const run = async (cmd: string, env: Record<string, string>): Promise<Result<string, string>> => {
  const r = await exec(["sh", "-c", cmd], { env, timeoutMs: COMMAND_TIMEOUT_MS });
  return r.ok ? ok(r.value.stdout) : err(runError(r.error));
};

/** The last non-empty stdout line: tools often log a line or two before the answer. */
const lastLine = (s: string): string => s.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1) ?? "";

/** Where the fetched skill lives inside $OUT: $OUT itself, or its only subdir, whichever holds SKILL.md. */
const skillRoot = async (out: string): Promise<Option<string>> => {
  if (await exists(join(out, "SKILL.md"))) return some(out);
  const names = (await readdir(out).catch(() => [] as string[])).filter((n) => !ignoredFile(n) && n !== "__MACOSX");
  if (names.length !== 1 || names[0] === undefined) return none;
  const only = join(out, names[0]);
  return (await exists(join(only, "SKILL.md"))) ? some(only) : none;
};

/** Run `fetch` for one version into a scratch dir and move the skill root into the cache. */
const fetchInto = async (def: RegistrySource, p: SourceUpstream, skill: string, version: string, dest: string, skm: string): Promise<Result<void, string>> => {
  const scratch = join(skm, "cache", "sources", ".work");
  await mkdir(scratch, { recursive: true });
  const work = await mkdtemp(join(scratch, `${p.name}-${skill}-`));
  try {
    const out = join(work, "out");
    await mkdir(out);
    const r = await run(def.fetch, envFor(p, { SKILL: skill, VERSION: version, OUT: out, WORK: work }));
    if (!r.ok) return r;
    const root = await skillRoot(out);
    if (!root.some) return err(`fetch left no SKILL.md in $OUT or in one subdir of it (${def.extension}: sources.${def.id}.fetch)`);
    await mkdir(join(dest, ".."), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await rename(root.value, dest);
    return ok(undefined);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

/** The version to judge against: a pin, the newest the source reports, or (offline) the newest seen last time. */
const targetVersion = async (def: RegistrySource, p: SourceUpstream, skill: string, pin: Option<string>, offline: boolean, skm: string): Promise<Result<string, string>> => {
  if (pin.some) return ok(pin.value);
  if (offline) {
    const seen = await readFile(latestFile(skm, p.name, skill), "utf8").then((t) => t.trim(), () => "");
    return seen !== "" ? ok(seen) : err("not checked yet; run `skm upstream` without --cached first");
  }
  const r = await run(def.latest, envFor(p, { SKILL: skill }));
  if (!r.ok) return r;
  const v = lastLine(r.value);
  if (!VERSION.test(v)) return err(`latest printed ${JSON.stringify(v)}, which is not a version (${def.extension}: sources.${def.id}.latest)`);
  await mkdir(sourceCacheDir(skm, p.name, skill), { recursive: true });
  await writeFile(latestFile(skm, p.name, skill), `${v}\n`);
  return ok(v);
};

const oneSkill = async (def: RegistrySource, p: SourceUpstream, skill: string, pin: Option<string>, offline: boolean, skm: string): Promise<Result<SourceSkill, string>> => {
  const v = await targetVersion(def, p, skill, pin, offline, skm);
  if (!v.ok) return v;
  if (!VERSION.test(v.value)) return err(`${JSON.stringify(v.value)} is not a version`);
  const dir = join(sourceCacheDir(skm, p.name, skill), v.value);
  if (!(await exists(dir))) {
    if (offline) return err(`version ${v.value} is not fetched yet; run \`skm upstream\` without --cached first`);
    const f = await fetchInto(def, p, skill, v.value, dir, skm);
    if (!f.ok) return f;
  }
  return ok({ skill, version: { rev: v.value, label: v.value }, dir, digest: await storeDigest(dir) });
};

/** Judge every skill of one source upstream: its target version and the digest of that version's files. */
export const checkSource = async (
  skm: string, sources: readonly RegistrySource[], p: SourceUpstream, o: { readonly offline: boolean; readonly ref: Option<string> },
): Promise<Result<readonly SourceSkill[], UpstreamError>> => {
  const def = sources.find((x) => x.id === p.source);
  if (def === undefined) return err({ upstream: p.name, step: "source", detail: `no extension defines source ${p.source} (\`skm extensions\` lists the sources)` });
  const missing = def.params.filter((k) => p.params[k] === undefined);
  if (missing.length > 0) return err({ upstream: p.name, step: "config", detail: `source ${p.source} needs ${missing.map((k) => `upstreams.${p.name}.${k}`).join(", ")}` });
  const pin = o.ref.some ? o.ref : p.ref;
  // one skill at a time: registries rate-limit, and the commands may prompt a login on first use
  const done = await p.skills.reduce<Promise<Result<readonly SourceSkill[], UpstreamError>>>(async (accP, skill) => {
    const acc = await accP;
    if (!acc.ok) return acc;
    const r = await oneSkill(def, p, skill, pin, o.offline, skm);
    return r.ok ? ok([...acc.value, r.value]) : err({ upstream: p.name, step: `${p.source} ${skill}`, detail: r.error });
  }, Promise.resolve(ok([])));
  return done;
};
