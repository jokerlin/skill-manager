import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { HostConfig } from "../core/config";
import { type HarnessHost, type HarnessMode, type HarnessTool, harnessScript, mergeHarness, parseHarnessLine } from "../core/harness";
import type { AppState } from "./app";
import { agentsOn, runnerFor } from "./hosts";
import { runError } from "./runner";

/**
 * Agent CLI and desktop app versions on each host, shared by `skm harness` and the TUI:
 * which tools a host has, running the check/update script over ssh, and the per-host result cache.
 */

export type { HarnessHost };
export { mergeHarness };

const cacheDir = (skm: string) => `${skm}/cache/harness`;
const cachePath = (skm: string, host: string) => `${cacheDir(skm)}/${host}.json`;

export const readHarnessCache = async (skm: string, host: string): Promise<HarnessHost | null> => {
  const text = await readFile(cachePath(skm, host), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const h = JSON.parse(text) as HarnessHost;
    // caches written before `latest` existed
    return { ...h, results: h.results.map((r) => (r.kind === "checked" ? { ...r, latest: r.latest ?? "" } : r)) };
  } catch {
    return null;
  }
};

/** Merge a run into the host's cache and return what the cache now holds. */
export const writeHarnessCache = async (skm: string, h: HarnessHost): Promise<HarnessHost> => {
  const merged = mergeHarness(await readHarnessCache(skm, h.host), h);
  await mkdir(cacheDir(skm), { recursive: true });
  await writeFile(cachePath(skm, h.host), JSON.stringify(merged, null, 2));
  return merged;
};

/**
 * Tools of one host: each enabled agent's CLI, plus its desktop app when it has one.
 * `pick` chooses one tool by id (an agent id, or an app id such as `chatgpt`). Without it a check covers everything,
 * while an update covers only the CLIs: an app update downloads the whole app and restarts it, so it is opt-in.
 */
export const toolsOf = (app: AppState, h: HostConfig, pick: string | undefined, mode: HarnessMode): HarnessTool[] =>
  agentsOn(app.config, h)
    .flatMap((a): HarnessTool[] => [
      { kind: "cli", id: a.id, bin: a.cli.bin, update: a.cli.update },
      ...(a.app !== undefined ? [{ kind: "app" as const, id: a.app.id, bundle: a.app.bundle, feed: a.app.feed, marker: a.app.marker, ...(a.app.settle !== undefined ? { settle: a.app.settle } : {}) }] : []),
    ])
    // an agent with no update command (an extension that left it out) is checked, never updated
    .filter((t) => mode === "check" || t.kind === "app" || t.update !== "")
    .filter((t) => (pick === undefined ? mode === "check" || t.kind === "cli" : t.id === pick));

/** Every app the configured agents ship. */
export const appsOf = (app: AppState) =>
  app.agents.flatMap((a) => (a.app !== undefined ? [{ id: a.app.id, agent: a.id, name: a.app.name, bundle: a.app.bundle, marketplaces: a.app.marketplaces }] : []));

/** Run the script on one host; `onLine` receives every output line that is not a result line. */
export const runHarnessHost = async (h: HostConfig, tools: readonly HarnessTool[], mode: HarnessMode, onLine: (line: string) => void): Promise<HarnessHost> => {
  const at = new Date().toISOString();
  if (tools.length === 0) return { host: h.id, at, error: null, results: [] };
  // updates download and install; give them far longer than a version check
  const r = await runnerFor(h).sh(harnessScript(tools, mode), { timeoutMs: mode === "update" ? 900_000 : 60_000 });
  if (!r.ok) return { host: h.id, at, error: runError(r.error), results: [] };
  const lines = r.value.stdout.split("\n").filter((l) => l.trim() !== "");
  lines.filter((l) => parseHarnessLine(l) === null).forEach(onLine);
  return { host: h.id, at, error: null, results: lines.flatMap((l) => { const x = parseHarnessLine(l); return x === null ? [] : [x]; }) };
};
