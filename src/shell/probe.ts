import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Agent } from "../core/agents";
import { type HostConfig, type OwnedPolicy, ownedProbe } from "../core/config";
import { emptyInventory, type Inventory, parseProbeOutput } from "../core/inventory";
import { PROBE_COMMANDS, PROBE_FILES, PROBE_TOOLS, probeScript } from "../core/scripts";
import { type Result, err, mapErr } from "../lib/result";
import { agentDirsRel, alsoReadsRel, builtinDirsRel, pluginCachesRel } from "./hosts";
import { expandHome } from "./paths";
import { type RunError, type Runner, runError } from "./runner";

export type HostError =
  | { readonly kind: "unreachable"; readonly host: string; readonly detail: string }
  | { readonly kind: "bad-probe"; readonly host: string; readonly line: string }
  | { readonly kind: "step-failed"; readonly host: string; readonly step: string; readonly detail: string };

export const hostErrorText = (e: HostError): string => {
  switch (e.kind) {
    case "unreachable":
      return `${e.host}: unreachable (${e.detail})`;
    case "bad-probe":
      return `${e.host}: unexpected probe output: ${e.line}`;
    case "step-failed":
      return `${e.host}: ${e.step} failed: ${e.detail}`;
  }
};

const asUnreachable = (host: string) => (e: RunError): HostError => ({ kind: "unreachable", host, detail: runError(e) });

export const probeHost = async (h: HostConfig, agents: readonly Agent[], owned: readonly OwnedPolicy[], runner: Runner): Promise<Result<Inventory, HostError>> => {
  const extra = ownedProbe(owned);
  const out = await runner.sh(
    probeScript({ skm: h.skm, agentDirs: agentDirsRel(agents), alsoReads: alsoReadsRel(agents), pluginCaches: pluginCachesRel(agents), builtinDirs: builtinDirsRel(agents), files: { ...PROBE_FILES, ...extra.files }, commands: PROBE_COMMANDS, tools: [...new Set([...PROBE_TOOLS, ...extra.tools])] }),
    { timeoutMs: 90_000 },
  );
  if (!out.ok) return err(asUnreachable(h.id)(out.error));
  return mapErr(parseProbeOutput(out.value.stdout, (home) => expandHome(`${h.skm}/skills`, home)), (e) => ({ kind: "bad-probe", host: h.id, line: e.line }));
};

const cachePath = (skm: string, host: string): string => `${skm}/cache/inventory/${host}.json`;

/** Persist the last successful probe so `doctor --cached` / the Mac app can reuse it without another ssh round-trip. */
export const writeInventoryCache = async (skm: string, host: string, inv: Inventory): Promise<void> => {
  await mkdir(`${skm}/cache/inventory`, { recursive: true }).catch(() => undefined);
  await writeFile(cachePath(skm, host), JSON.stringify({ at: new Date().toISOString(), inventory: inv })).catch(() => undefined);
};

export const readInventoryCache = async (skm: string, host: string): Promise<Inventory | undefined> =>
  (await readInventoryCacheEntry(skm, host))?.inventory;

/** The cached probe with the time it was taken (ISO 8601). */
export const readInventoryCacheEntry = async (skm: string, host: string): Promise<{ readonly inventory: Inventory; readonly at: string } | undefined> => {
  const text = await readFile(cachePath(skm, host), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const j = JSON.parse(text) as { at?: string; inventory?: Inventory };
    // caches written by older probes lack newer fields (e.g. `hidden`): fill them with empties
    return j.inventory && typeof j.inventory.home === "string" ? { inventory: { ...emptyInventory(j.inventory.home), ...j.inventory }, at: typeof j.at === "string" ? j.at : "" } : undefined;
  } catch {
    return undefined;
  }
};

const errorPath = (skm: string, host: string): string => `${skm}/cache/inventory/${host}.error.json`;

/** Remember that the last live probe of a host failed, so cached reads can say the cache is from before an outage. */
export const writeProbeError = async (skm: string, host: string, e: HostError): Promise<void> => {
  await mkdir(`${skm}/cache/inventory`, { recursive: true }).catch(() => undefined);
  await writeFile(errorPath(skm, host), JSON.stringify({ at: new Date().toISOString(), error: hostErrorText(e) })).catch(() => undefined);
};

export const clearProbeError = async (skm: string, host: string): Promise<void> => { await rm(errorPath(skm, host), { force: true }).catch(() => undefined); };

export const readProbeError = async (skm: string, host: string): Promise<{ readonly at: string; readonly error: string } | undefined> => {
  const text = await readFile(errorPath(skm, host), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const j = JSON.parse(text) as { at?: unknown; error?: unknown };
    return typeof j.at === "string" && typeof j.error === "string" ? { at: j.at, error: j.error } : undefined;
  } catch {
    return undefined;
  }
};
