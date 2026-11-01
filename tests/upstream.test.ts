import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { none, some } from "../src/lib/result";
import { parseConfig, serializeConfig } from "../src/core/config";
import {
  gitBlobId, latestReleaseTag, parseLock, serializeLock, setLockEntry, skillParent, skillState, treeDigest, unlistedSummary, updateAction, EMPTY_LOCK,
} from "../src/core/upstream";
import { storeDigest } from "../src/shell/upstream";

const SCRATCH = process.env["CLAUDE_SCRATCHPAD"] ?? tmpdir();

describe("upstreams in config.yaml", () => {
  const base = "hosts: { local: {} }\n";
  test("parses, fills defaults and writes back the same", () => {
    const r = parseConfig(`${base}upstreams:\n  waza: { repo: https://example.com/waza.git, skills: [check, hunt] }\n  kit: { repo: /src/kit, ref: main, path: "{skill}", skills: [doc] }\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.upstreams).toEqual([
      { kind: "git", name: "waza", repo: "https://example.com/waza.git", ref: none, path: "skills/{skill}", skills: ["check", "hunt"] },
      { kind: "git", name: "kit", repo: "/src/kit", ref: some("main"), path: "{skill}", skills: ["doc"] },
    ]);
    const again = parseConfig(serializeConfig(r.value));
    expect(again.ok && again.value.upstreams).toEqual(r.value.upstreams);
    expect(serializeConfig(r.value)).not.toContain("path: skills/{skill}");
  });
  test("rejects a skill claimed by two upstreams, unsafe names and paths, and a path without {skill}", () => {
    expect(parseConfig(`${base}upstreams:\n  a: { repo: x, skills: [s] }\n  b: { repo: y, skills: [s] }\n`).ok).toBe(false);
    expect(parseConfig(`${base}upstreams:\n  a: { repo: x, skills: ["../etc"] }\n`).ok).toBe(false);
    expect(parseConfig(`${base}upstreams:\n  a: { repo: x, path: "../{skill}", skills: [s] }\n`).ok).toBe(false);
    expect(parseConfig(`${base}upstreams:\n  a: { repo: x, path: skills, skills: [s] }\n`).ok).toBe(false);
    expect(parseConfig(`${base}upstreams:\n  a: { repo: x, skills: [] }\n`).ok).toBe(false);
  });
  test("a source upstream keeps its params and writes back the same", () => {
    const r = parseConfig(`${base}upstreams:\n  reg: { source: my-registry, namespace: team/kit, ref: "1.2.0", skills: [doc] }\n`);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.upstreams).toEqual([{ kind: "source", name: "reg", source: "my-registry", params: { namespace: "team/kit" }, ref: some("1.2.0"), skills: ["doc"] }]);
    const again = parseConfig(serializeConfig(r.value));
    expect(again.ok && again.value.upstreams).toEqual(r.value.upstreams);
  });
  test("rejects git keys on a source upstream, reserved or odd param names, and unknown keys on a git upstream", () => {
    expect(parseConfig(`${base}upstreams:\n  a: { source: reg, repo: x, skills: [s] }\n`).ok).toBe(false);
    expect(parseConfig(`${base}upstreams:\n  a: { source: reg, version: "1", skills: [s] }\n`).ok).toBe(false);
    expect(parseConfig(`${base}upstreams:\n  a: { source: reg, Name-Space: x, skills: [s] }\n`).ok).toBe(false);
    expect(parseConfig(`${base}upstreams:\n  a: { source: reg, namespace: 3, skills: [s] }\n`).ok).toBe(false);
    expect(parseConfig(`${base}upstreams:\n  a: { repo: x, namespace: y, skills: [s] }\n`).ok).toBe(false);
  });
  test("a config without upstreams writes no upstreams key", () => {
    const r = parseConfig(base);
    expect(r.ok && serializeConfig(r.value)).not.toContain("upstreams");
  });
});

describe("skill state against its upstream", () => {
  const s = (x: string | undefined) => (x === undefined ? none : some(x));
  test.each([
    // base, store, target, state
    ["A", "A", "A", "current"],
    ["A", "A", "B", "behind"],
    ["A", "C", "B", "modified"],
    ["A", "B", "B", "current"],      // edited by hand into exactly the target
    [undefined, "B", "B", "current"],
    [undefined, "A", "B", "unbased"],
    ["A", undefined, "B", "absent"],
    ["A", "A", undefined, "gone"],
  ] as const)("base %p store %p target %p → %p", (b, st, t, want) => {
    expect(skillState(s(b), s(st), s(t)).kind).toBe(want);
  });
  test("update writes behind and absent, refuses edited and unknown copies unless forced, skips the rest", () => {
    expect(updateAction({ kind: "behind" }, false)).toBe("write");
    expect(updateAction({ kind: "absent" }, false)).toBe("write");
    expect(updateAction({ kind: "modified" }, false)).toBe("refuse");
    expect(updateAction({ kind: "unbased" }, false)).toBe("refuse");
    expect(updateAction({ kind: "modified" }, true)).toBe("write");
    expect(updateAction({ kind: "current" }, true)).toBe("skip");
    expect(updateAction({ kind: "gone" }, true)).toBe("skip");
  });
});

describe("refs, digests, lock", () => {
  test("the newest release tag compares numerically and ignores pre-releases", () => {
    expect(latestReleaseTag(["v3.9.0", "v3.41.0", "v3.40.2", "v4.0.0-rc.1", "nightly"])).toEqual(some("v3.41.0"));
    expect(latestReleaseTag(["1.2.3", "1.10.0"])).toEqual(some("1.10.0"));
    expect(latestReleaseTag(["latest"])).toEqual(none);
  });
  test("gitBlobId equals git hash-object", async () => {
    const bytes = new TextEncoder().encode("hello\n");
    expect(gitBlobId(bytes)).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
  test("treeDigest ignores order and OS/interpreter litter", () => {
    const a = [{ path: "SKILL.md", blob: "1" }, { path: "x/y.py", blob: "2" }];
    expect(treeDigest(a)).toBe(treeDigest([...a].reverse()));
    expect(treeDigest([...a, { path: ".DS_Store", blob: "3" }, { path: "x/__pycache__/y.pyc", blob: "4" }])).toBe(treeDigest(a));
    expect(treeDigest(a)).not.toBe(treeDigest([{ path: "SKILL.md", blob: "1" }]));
  });
  test("skillParent finds the dir that holds every skill only when {skill} is the last segment", () => {
    expect(skillParent("skills/{skill}")).toEqual(some("skills"));
    expect(skillParent("{skill}")).toEqual(some(""));
    expect(skillParent("{skill}/src")).toEqual(none);
  });
  test("lock round-trips as version 2 and rejects other shapes", () => {
    const l = setLockEntry(setLockEntry(EMPTY_LOCK, "waza", "hunt", { rev: "c2", label: "v2", digest: "d2" }), "waza", "check", { rev: "c1", label: "v1", digest: "d1" });
    const text = serializeLock(l);
    expect(JSON.parse(text).version).toBe(2);
    expect(parseLock(text)).toEqual({ ok: true, value: l });
    expect(text.indexOf("check")).toBeLessThan(text.indexOf("hunt"));
    expect(parseLock("{}").ok).toBe(false);
    expect(parseLock(`{"version":1,"upstreams":{"w":{"s":{"commit":1}}}}`).ok).toBe(false);
    expect(parseLock(`{"version":2,"upstreams":{"w":{"s":{"commit":"c","label":"v","digest":"d"}}}}`).ok).toBe(false);
  });
  test("a version 1 lock (rev named commit) still reads", () => {
    expect(parseLock(`{"version":1,"upstreams":{"w":{"s":{"commit":"c1","label":"v1","digest":"d1"}}}}`))
      .toEqual({ ok: true, value: { w: { s: { rev: "c1", label: "v1", digest: "d1" } } } });
  });
});

// ---------- end to end: a real git repo, the real CLI, a throwaway HOME ----------

const sh = (cwd: string, script: string): string => {
  const p = Bun.spawnSync(["sh", "-c", script], { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  if (p.exitCode !== 0) throw new Error(`${script}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};

const md = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} skill. Use when testing.\n---\n${body}\n`;

describe("untracked upstream skills line", () => {
  test("nothing untracked prints nothing", () => {
    expect(unlistedSummary("kit", [])).toEqual(none);
  });
  test("a few names are listed in full", () => {
    expect(unlistedSummary("kit", ["a", "b", "c"])).toEqual(some("also upstream, not tracked: a, b, c (add to upstreams.kit.skills)"));
  });
  test("a long list shows a count and three examples, never every name", () => {
    const names = Array.from({ length: 300 }, (_, i) => `bytedance-${String(i).padStart(3, "0")}`);
    const r = unlistedSummary("bytedcli", names);
    expect(r).toEqual(some("also upstream, not tracked: 300 skills (bytedance-000, bytedance-001, bytedance-002, …; all names: `skm upstream --json`)"));
    expect(r.some && r.value.includes("bytedance-003")).toBe(false);
  });
});

describe("skm upstream end to end", () => {
  const root = mkdtempSync(join(SCRATCH, "skm-upstream-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const skm = join(home, ".skm");
  const store = join(skm, "skills");
  const run = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "bin", "skm.ts"), ...args], { env: { ...process.env, HOME: home, SKM_HOME: skm, GIT_CONFIG_GLOBAL: "/dev/null" } });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const json = (...args: string[]) => {
    const r = run(...args);
    if (r.code !== 0) throw new Error(`skm ${args.join(" ")} exited ${r.code}: ${r.err}${r.out}`);
    return JSON.parse(r.out);
  };
  const write = (p: string, text: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };
  let c1 = "";
  let c3 = "";

  beforeAll(() => {
    mkdirSync(store, { recursive: true });
    writeFileSync(join(skm, "config.yaml"), "store: ~/.skm/skills\nagents: [claude]\nhosts:\n  local: {}\n");
    mkdirSync(repo, { recursive: true });
    sh(repo, "git init -q -b main");
    write(join(repo, "skills/alpha/SKILL.md"), md("alpha", "v1"));
    write(join(repo, "skills/beta/SKILL.md"), md("beta", "v1"));
    write(join(repo, "skills/beta/scripts/run.sh"), "#!/bin/sh\necho beta\n");
    chmodSync(join(repo, "skills/beta/scripts/run.sh"), 0o755);
    write(join(repo, ".gitattributes"), "skills/** export-ignore\n");
    sh(repo, "git add -A && git commit -qm 'first' && git tag v1.0.0");
    c1 = sh(repo, "git rev-parse HEAD").trim();
    // the store holds the v1.0.0 copies, as if installed by hand back then, plus Finder litter
    sh(root, `cp -R ${repo}/skills/alpha ${repo}/skills/beta ${store}/ && touch ${store}/alpha/.DS_Store`);
    write(join(repo, "skills/alpha/SKILL.md"), md("alpha", "v2"));
    write(join(repo, "skills/gamma/SKILL.md"), md("gamma", "v1"));
    sh(repo, "git add -A && git commit -qm 'alpha v2, add gamma' && git tag v1.1.0");
    write(join(repo, "skills/alpha/SKILL.md"), md("alpha", "v3 unreleased"));
    sh(repo, "git commit -qam 'alpha v3'");
    c3 = sh(repo, "git rev-parse HEAD").trim();
  });

  test("adopt finds the newest commit each store copy equals and records the upstream", () => {
    const r = json("upstream", "adopt", "up", "--repo", repo, "--json");
    expect(r.target.label).toBe("v1.1.0");
    // beta never changed, so every commit holds the same files: the newest one wins
    expect(r.skills.map((s: { skill: string; base: string }) => [s.skill, s.base])).toEqual([["alpha", c1], ["beta", c3]]);
    expect(readFileSync(join(skm, "config.yaml"), "utf8")).toContain("upstreams:");
    const lock = JSON.parse(readFileSync(join(skm, "upstreams.lock.json"), "utf8"));
    expect(lock.upstreams.up.alpha.label).toBe("v1.0.0");
  });

  test("status follows the newest release tag, lists the commits and the untracked upstream skill", () => {
    const r = json("upstream", "--json").upstreams[0];
    expect(r.target.label).toBe("v1.1.0");
    expect(r.skills.map((s: { skill: string; state: string }) => [s.skill, s.state])).toEqual([["alpha", "behind"], ["beta", "current"]]);
    expect(r.skills[0].changes.map((c: { subject: string }) => c.subject)).toEqual(["alpha v2, add gamma"]);
    expect(r.unlisted).toEqual(["gamma"]);
  });

  test("update writes behind skills, refuses an edited copy, backs up and records the new base", () => {
    writeFileSync(join(store, "beta", "SKILL.md"), md("beta", "my local edit"));
    const r = json("upstream", "update", "--all", "-y", "--json");
    const by = Object.fromEntries(r.outcomes.map((o: { skill: string; result: string }) => [o.skill, o.result]));
    expect(by).toEqual({ alpha: "updated", beta: "refused" });
    expect(readFileSync(join(store, "alpha", "SKILL.md"), "utf8")).toContain("v2");
    expect(readFileSync(join(store, "beta", "SKILL.md"), "utf8")).toContain("my local edit");
    expect(existsSync(join(store, "alpha", ".DS_Store"))).toBe(false);
    expect(r.backup).toContain(join(".skm", "backups"));
    expect(readFileSync(join(r.backup, "manifest.txt"), "utf8")).toContain(".skm/skills/alpha");
    expect(JSON.parse(readFileSync(join(skm, "upstreams.lock.json"), "utf8")).upstreams.up.alpha.label).toBe("v1.1.0");
    expect(readdirSync(store).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("--force overwrites the edited copy with the upstream files, modes included", () => {
    const r = json("upstream", "update", "beta", "--force", "-y", "--json");
    expect(r.outcomes[0].result).toBe("updated");
    expect(readFileSync(join(store, "beta", "SKILL.md"), "utf8")).toContain("v1");
    expect(statSync(join(store, "beta", "scripts", "run.sh")).mode & 0o111).not.toBe(0);
    expect(json("upstream", "--json", "--cached").upstreams[0].skills.every((s: { state: string }) => s.state === "current")).toBe(true);
  });

  test("--to follows a branch for one run; --dry-run changes nothing", () => {
    const dry = run("upstream", "update", "alpha", "--to", "main", "--dry-run");
    expect(dry.code).toBe(0);
    expect(readFileSync(join(store, "alpha", "SKILL.md"), "utf8")).toContain("v2");
    const r = json("upstream", "update", "alpha", "--to", "main", "-y", "--json", "--cached");
    expect(r.outcomes[0].result).toBe("updated");
    expect(readFileSync(join(store, "alpha", "SKILL.md"), "utf8")).toContain("v3 unreleased");
  });

  test("the store digest of a written dir equals the digest of the same files copied by hand", async () => {
    const copy = join(root, "copy");
    rmSync(copy, { recursive: true, force: true });
    sh(root, `cp -R ${store}/beta ${copy}`);
    expect(await storeDigest(copy)).toEqual(await storeDigest(join(store, "beta")));
  });

  test("unknown skills and missing selection are errors", () => {
    expect(run("upstream", "update").code).not.toBe(0);
    expect(run("upstream", "update", "nope", "-y").code).not.toBe(0);
  });
});
