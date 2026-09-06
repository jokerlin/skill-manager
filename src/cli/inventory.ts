import pc from "picocolors";
import { trimText, unitSuffix } from "../core/budget";
import { findingText } from "../core/effective";
import { sourceText, storageText } from "../core/sources";
import { agentsOn } from "../shell/hosts";
import { hostErrorText } from "../shell/probe";
import { out, table, withApp } from "./common";
import { budgetJson, effectiveJson, pluginJson, snapshotHosts } from "./status";

export type InventoryOpts = { host?: string; agent?: string; json: boolean };

const ownerColor = (o: string): string => (o === "skm" ? pc.green(o) : o === "manual" ? pc.yellow(o) : pc.cyan(o));

/** Consumption-first listing: for every (host, agent) the skills the agent will actually load, whatever their source. */
export const runInventory = async (o: InventoryOpts): Promise<void> =>
  withApp(async (app) => {
    const snaps = await snapshotHosts(app, o.host);
    const cells = snaps.flatMap((snap) =>
      agentsOn(app.config, snap.host)
        .filter((a) => o.agent === undefined || a.id === o.agent)
        .map((a) => ({ snap, agent: a })),
    );
    if (o.json) {
      return out(JSON.stringify(cells.map(({ snap, agent }) => {
        if (!snap.result.ok) return { host: snap.host.id, agent: agent.id, reachable: false, error: hostErrorText(snap.result.error) };
        const v = snap.result.view;
        return {
          host: snap.host.id, agent: agent.id, reachable: true,
          entries: (v.effective[agent.id] ?? []).map(effectiveJson),
          counts: v.counts[agent.id], budget: budgetJson(v.budget[agent.id]),
          plugins: (v.states[agent.id] ?? []).map(pluginJson),
          findings: v.findings.filter((f) => f.kind !== "version-drift" && f.agent === agent.id).map((f) => ({ kind: f.kind, text: findingText(f) })),
        };
      }), null, 2));
    }
    cells.forEach(({ snap, agent }) => {
      if (!snap.result.ok) return out(`${pc.bold(`${snap.host.id}/${agent.id}`)}  ${pc.red("unreachable")}  ${pc.dim(hostErrorText(snap.result.error))}\n`);
      const v = snap.result.view;
      const es = v.effective[agent.id] ?? [];
      const b = v.budget[agent.id];
      const flagged = new Set(v.findings.flatMap((f) => (f.kind === "same-name" && f.agent === agent.id ? [f.name] : [])));
      const dupHashes = new Set(v.findings.flatMap((f) => (f.kind === "same-content" && f.agent === agent.id ? [f.hash] : [])));
      const u = b === undefined ? "c" : unitSuffix(b);
      const budget = b === undefined ? "" : !Number.isFinite(b.budgetChars) ? pc.dim(`listing ${b.usedChars}${u} (no documented budget)`) : b.overBy > 0 ? pc.red(`listing ${b.usedChars}${u} / budget ${b.budgetChars}${u} — over by ${b.overBy}${u}, ${trimText(b)}`) : pc.green(`listing ${b.usedChars}${u} / budget ${b.budgetChars}${u} — fits`);
      out(`${pc.bold(`${snap.host.id}/${agent.id}`)}  ${es.length} skills  ${budget}`);
      const rows = es.map((e) => [
        `${flagged.has(e.name) ? pc.yellow("≡") : dupHashes.has(e.hash) ? pc.magenta("=") : " "}${e.name}${e.promptVisible ? "" : pc.dim(" (hidden)")}`,
        e.source.kind === "plugin" ? `${e.source.plugin}@${e.source.marketplace}` : e.source.kind === "legacy" ? pc.dim(`legacy ${e.source.dir}`) : e.source.kind,
        storageText(e.storage),
        ownerColor(e.owner),
        e.version.some ? e.version.value : pc.dim("–"),
        `${e.listingChars}c`,
        `${e.bodyTokens}t`,
      ]);
      out(table(["skill", "source", "storage", "owner", "version", "listing", "body"], rows));
      const local = v.findings.filter((f) => f.kind !== "version-drift" && f.agent === agent.id);
      local.forEach((f) => out(`  ${f.kind === "same-name" ? pc.yellow(f.kind) : f.kind === "same-content" ? pc.magenta(f.kind) : pc.dim(f.kind)}  ${findingText(f)}`));
      out("");
    });
    out(pc.dim("≡ same name from several sources  = identical SKILL.md in several places  ·  listing = description chars paid every turn  ·  body = tokens paid on activation  ·  Codex plugins cached without a config.toml entry are not loaded and not listed  ·  (hidden) = agents/openai.yaml allow_implicit_invocation: false, loaded but not in Codex's catalog, costs nothing  ·  " + pc.dim("sources: user dir · legacy dir · builtin · plugin cache")));
    void sourceText;
  });
