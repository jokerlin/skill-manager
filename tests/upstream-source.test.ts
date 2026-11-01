import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = process.env["CLAUDE_SCRATCHPAD"] ?? tmpdir();

const md = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} skill. Use when testing.\n---\n${body}\n`;

/**
 * A source upstream end to end: an extension whose commands read a fake registry on disk
 * (<reg>/<namespace>/<skill>/latest names the newest version, <version>/ holds its files), the real CLI, a throwaway HOME.
 */
describe("skm upstream with an extension source", () => {
  const root = mkdtempSync(join(SCRATCH, "skm-source-"));
  const home = join(root, "home");
  const reg = join(root, "registry");
  const skm = join(home, ".skm");
  const store = join(skm, "skills");
  const run = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "bin", "skm.ts"), ...args], { env: { ...process.env, HOME: home, SKM_HOME: skm, FAKE_REG: reg } });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const json = (...args: string[]) => {
    const r = run(...args);
    if (r.code !== 0) throw new Error(`skm ${args.join(" ")} exited ${r.code}: ${r.err}${r.out}`);
    return JSON.parse(r.out);
  };
  const write = (p: string, text: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };
  /** Publish a version of a skill to the fake registry and make it the newest. */
  const publish = (skill: string, version: string, body: string) => {
    write(join(reg, "team/kit", skill, version, "SKILL.md"), md(skill, body));
    writeFileSync(join(reg, "team/kit", skill, "latest"), `${version}\n`);
  };
  const lock = () => JSON.parse(readFileSync(join(skm, "upstreams.lock.json"), "utf8"));

  beforeAll(() => {
    mkdirSync(store, { recursive: true });
    // latest logs a line first (the last line counts); fetch nests the files one dir down, like an unzipped archive
    write(join(skm, "extensions", "fake.yaml"), [
      "sources:",
      "  - id: fake-reg",
      "    params: [namespace]",
      "    latest: 'echo checking >&2; echo resolving; cat \"$FAKE_REG/$NAMESPACE/$SKILL/latest\"'",
      "    fetch: 'mkdir -p \"$OUT/$SKILL\" && cp -R \"$FAKE_REG/$NAMESPACE/$SKILL/$VERSION/.\" \"$OUT/$SKILL/\"'",
      "",
    ].join("\n"));
    writeFileSync(join(skm, "config.yaml"), [
      "store: ~/.skm/skills",
      "agents: [claude]",
      "hosts:",
      "  local: {}",
      "upstreams:",
      "  kit:",
      "    source: fake-reg",
      "    namespace: team/kit",
      "    skills: [doc, pdf]",
      "",
    ].join("\n"));
    publish("doc", "1.0.0", "doc v1");
    publish("pdf", "2.0.0", "pdf v2");
    // the store already holds doc 1.0.0 (installed by hand); pdf is not in the store yet
    write(join(store, "doc", "SKILL.md"), md("doc", "doc v1"));
  });

  test("skm extensions lists the source", () => {
    const r = json("extensions", "--json");
    expect(r.extensions).toEqual([expect.objectContaining({ name: "fake", enabled: true, sources: ["fake-reg"], warnings: [] })]);
  });

  test("status asks the source per skill and judges the store copy against each version", () => {
    const u = json("upstream", "--json").upstreams[0];
    expect(u).toMatchObject({ name: "kit", kind: "source", source: "fake-reg", repo: "fake-reg namespace=team/kit", target: null, error: null, unlisted: [] });
    expect(u.skills.map((s: { skill: string; state: string; target: { label: string } }) => [s.skill, s.state, s.target.label])).toEqual([["doc", "current", "1.0.0"], ["pdf", "absent", "2.0.0"]]);
  });

  test("update writes the absent skill from the fetched files and locks both", () => {
    const r = json("upstream", "update", "--all", "-y", "--json");
    expect(Object.fromEntries(r.outcomes.map((o: { skill: string; result: string }) => [o.skill, o.result]))).toEqual({ pdf: "updated", doc: "skipped" });
    expect(readFileSync(join(store, "pdf", "SKILL.md"), "utf8")).toContain("pdf v2");
    expect(lock().version).toBe(2);
    expect(lock().upstreams.kit).toMatchObject({ doc: { rev: "1.0.0", label: "1.0.0" }, pdf: { rev: "2.0.0", label: "2.0.0" } });
    expect(readdirSync(store).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("a new version makes the untouched copy behind and an edited copy modified; update refuses the edit", () => {
    publish("doc", "1.1.0", "doc v1.1");
    publish("pdf", "2.1.0", "pdf v2.1");
    writeFileSync(join(store, "pdf", "SKILL.md"), md("pdf", "my local edit"));
    const u = json("upstream", "--json").upstreams[0];
    expect(u.skills.map((s: { skill: string; state: string; base: { label: string } }) => [s.skill, s.state, s.base.label])).toEqual([["doc", "behind", "1.0.0"], ["pdf", "modified", "2.0.0"]]);
    const r = json("upstream", "update", "--all", "-y", "--json");
    expect(Object.fromEntries(r.outcomes.map((o: { skill: string; result: string }) => [o.skill, o.result]))).toEqual({ doc: "updated", pdf: "refused" });
    expect(readFileSync(join(store, "doc", "SKILL.md"), "utf8")).toContain("doc v1.1");
    expect(readFileSync(join(store, "pdf", "SKILL.md"), "utf8")).toContain("my local edit");
  });

  test("--cached reads the versions seen last time and runs no command", () => {
    publish("doc", "9.9.9", "never fetched");
    const u = json("upstream", "--cached", "--json").upstreams[0];
    expect(u.skills.map((s: { skill: string; target: { label: string } }) => [s.skill, s.target.label])).toEqual([["doc", "1.1.0"], ["pdf", "2.1.0"]]);
    expect(existsSync(join(skm, "cache", "sources", "kit", "doc", "9.9.9"))).toBe(false);
  });

  test("a source no extension defines, or a missing param, is that upstream's error", () => {
    const cfg = readFileSync(join(skm, "config.yaml"), "utf8");
    writeFileSync(join(skm, "config.yaml"), cfg.replace("source: fake-reg", "source: nowhere"));
    expect(json("upstream", "--json").upstreams[0].error).toContain("no extension defines source nowhere");
    writeFileSync(join(skm, "config.yaml"), cfg.replace("    namespace: team/kit\n", ""));
    expect(json("upstream", "--json").upstreams[0].error).toContain("source fake-reg needs upstreams.kit.namespace");
    writeFileSync(join(skm, "config.yaml"), cfg);
  });

  test("a fetch without SKILL.md and a latest that prints no version are reported with the command", () => {
    const ext = readFileSync(join(skm, "extensions", "fake.yaml"), "utf8");
    publish("doc", "3.0.0", "doc v3");
    writeFileSync(join(skm, "extensions", "fake.yaml"), ext.replace(/fetch: .*/, "fetch: 'touch \"$OUT/README\"'"));
    expect(json("upstream", "--json").upstreams[0].error).toContain("fetch left no SKILL.md");
    writeFileSync(join(skm, "extensions", "fake.yaml"), ext.replace(/latest: .*/, "latest: 'echo \"no such skill\"'"));
    expect(json("upstream", "--json").upstreams[0].error).toContain('latest printed "no such skill"');
    writeFileSync(join(skm, "extensions", "fake.yaml"), ext);
  });

  test("adopt refuses a source upstream and points at update", () => {
    const r = run("upstream", "adopt", "kit");
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toContain("comes from source fake-reg");
  });
});
