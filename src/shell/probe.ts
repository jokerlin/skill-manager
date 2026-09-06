import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Agent } from "../core/agents";
import type { HostConfig } from "../core/config";
import { type Inventory, parseProbeOutput } from "../core/inventory";
import { PROBE_FILES, PROBE_TOOLS, probeScript } from "../core/scripts";
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

export const probeHost = async (h: HostConfig, agents: readonly Agent[], runner: Runner): Promise<Result<Inventory, HostError>> => {
  const out = await runner.sh(
    probeScript({ skm: h.skm, agentDirs: agentDirsRel(agents), alsoReads: alsoReadsRel(agents), pluginCaches: pluginCachesRel(agents), builtinDirs: builtinDirsRel(agents), files: PROBE_FILES, tools: PROBE_TOOLS }),
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

export const readInventoryCache = async (skm: string, host: string): Promise<Inventory | undefined> => {
  const text = await readFile(cachePath(skm, host), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const j = JSON.parse(text) as { inventory?: Inventory };
    return j.inventory && typeof j.inventory.home === "string" ? j.inventory : undefined;
  } catch {
    return undefined;
  }
};
