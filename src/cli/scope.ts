import pc from "picocolors";
import { parseCell } from "../core/config";
import { isDesired, setScope } from "../core/scope";
import { die, out, saveConfig, withApp } from "./common";

/** `skm scope <skill> <host>/<agent> on|off` — one grid cell, saved to config.yaml. */
export const runScope = async (skill: string, cellText: string, state: string): Promise<void> =>
  withApp(async (app) => {
    if (!app.skills.some((s) => s.name === skill)) return die(`no skill named ${skill}`);
    const cell = parseCell(cellText);
    if (!cell.some) return die("cell must look like host/agent, e.g. mini/claude");
    if (state !== "on" && state !== "off") return die("state must be on or off");
    const next = setScope(app.config, skill, cell.value.host, cell.value.agent, state === "on");
    await saveConfig(app.configPath, next);
    out(`${pc.green("ok")} ${skill} ${cellText} → ${isDesired(next, skill, cell.value.host, cell.value.agent) ? "on" : "off"}`);
  });

export const runConfigShow = async (json: boolean): Promise<void> =>
  withApp(async (app) => {
    if (json) return out(JSON.stringify({ hosts: app.config.hosts.map((h) => h.id), agents: [...app.config.agents], store: app.storeDir, configPath: app.configPath }, null, 2));
    out(await Bun.file(app.configPath).text());
  });
