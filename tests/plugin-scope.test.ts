import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyInventory } from "../src/core/inventory";

// a host where Claude has superpowers@official enabled, as a probe caches it
const inventoryWithPlugin = (home: string) => ({
  ...emptyInventory(home),
  files: {
    "claude-settings": JSON.stringify({ enabledPlugins: { "superpowers@official": true } }),
    "claude-installed": JSON.stringify({ version: 2, plugins: { "superpowers@official": [{ scope: "user", installPath: `${home}/.claude/plugins/cache/official/superpowers/6.3.0`, version: "6.3.0" }] } }),
  },
  pluginCache: [{ agent: "claude", marketplace: "official", plugin: "superpowers", version: "6.3.0", dir: `${home}/.claude/plugins/cache/official/superpowers/6.3.0` }],
});

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "skm-plugin-scope-"));
  const skm = join(home, ".skm");
  mkdirSync(join(skm, "cache", "inventory"), { recursive: true });
  const config = join(skm, "config.yaml");
  writeFileSync(config, ["store: ~/.skm/skills", "agents:", "  - claude", "hosts:", "  local: {}", "  far:", "    ssh: far-host", ""].join("\n"));
  const cache = (host: string) => writeFileSync(join(skm, "cache", "inventory", `${host}.json`), JSON.stringify({ at: new Date().toISOString(), inventory: inventoryWithPlugin(home) }));
  const run = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "bin", "skm.ts"), ...args], { env: { ...process.env, HOME: home, SKM_HOME: skm } });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  return { config, cache, run };
};

test("a plugin's first switch is refused while a host that runs Claude or Codex has no probe result", () => {
  const { config, cache, run } = setup();
  cache("local"); // far was never probed: skm cannot tell whether superpowers is enabled there
  const before = readFileSync(config, "utf8");
  const r = run("scope", "--plugin", "superpowers@official", "local/claude", "off");
  expect(r.code).toBe(1);
  expect(r.err).toContain("has no probe result for far");
  expect(r.err).toContain("skm status far");
  expect(readFileSync(config, "utf8")).toBe(before); // no policy that would switch it off on far
});

test("with every host probed, the first policy keeps the plugin on where it is enabled today", () => {
  const { config, cache, run } = setup();
  cache("local");
  cache("far");
  const r = run("scope", "--plugin", "superpowers@official", "local/claude", "off");
  expect(r.code).toBe(0);
  const text = readFileSync(config, "utf8");
  expect(text).toContain("superpowers:");
  expect(text).toContain("- far/claude");
  expect(text).not.toContain("- local/claude");
});
