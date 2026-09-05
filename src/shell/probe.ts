import type { Agent } from "../core/agents";
import type { HostConfig } from "../core/config";
import { type Inventory, parseProbeOutput } from "../core/inventory";
import { probeScript } from "../core/scripts";
import { type Result, err, mapErr } from "../lib/result";
import { agentDirsRel, alsoReadsRel } from "./hosts";
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
  const out = await runner.sh(probeScript({ skm: h.skm, agentDirs: agentDirsRel(agents), alsoReads: alsoReadsRel(agents) }), { timeoutMs: 40_000 });
  if (!out.ok) return err(asUnreachable(h.id)(out.error));
  return mapErr(parseProbeOutput(out.value.stdout, (home) => expandHome(`${h.skm}/skills`, home)), (e) => ({ kind: "bad-probe", host: h.id, line: e.line }));
};
