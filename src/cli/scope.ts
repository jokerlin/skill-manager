import { hubOf } from "../core/config";
import pc from "picocolors";
import { readFileSync } from "node:fs";
import { cellText, parseCell } from "../core/config";
import { parsePatch, patchConfig, patchErrorText } from "../core/patch";
import { isDesired, setScope } from "../core/scope";
import { extensionsDir } from "../shell/extensions";
import { die, out, saveConfig, withApp } from "./common";
import { runPluginScope } from "./plugins";

/** `skm scope <skill> <host>/<agent> on|off` — one grid cell, saved to config.yaml. `--plugin`: the same for a plugin. */
export const runScope = async (name: string, cellArg: string, state: string, o: { plugin?: boolean } = {}): Promise<void> => {
  const cell = parseCell(cellArg);
  if (!cell.some) return die("cell must look like host/agent, e.g. mini/claude");
  if (state !== "on" && state !== "off") return die("state must be on or off");
  if (o.plugin) return runPluginScope(name, cell.value, state === "on");
  return withApp(async (app) => {
    if (!app.skills.some((s) => s.name === name) && !app.config.owned.some((x) => x.skill === name)) return die(`no skill named ${name}`);
    const next = setScope(app.config, name, cell.value.host, cell.value.agent, state === "on");
    if (next !== app.config) await saveConfig(app.configPath, next);
    out(`${pc.green("ok")} ${name} ${cellText(cell.value)} → ${isDesired(next, name, cell.value.host, cell.value.agent) ? "on" : "off"}`);
  });
};

/** `skm config --json`: what the desktop settings page edits, plus where the file lives. */
export const runConfigShow = async (json: boolean): Promise<void> =>
  withApp(async (app) => {
    if (json) {
      return out(JSON.stringify({
        hosts: app.config.hosts.map((h) => h.id),
        hostDetails: app.config.hosts.map((h) => ({ id: h.id, ssh: h.ssh.some ? h.ssh.value : null, agents: h.agents.some ? [...h.agents.value] : null, skm: h.skm })),
        agents: [...app.config.agents],
        store: app.storeDir,
        configPath: app.configPath,
        backupBeforeApply: app.config.backupBeforeApply,
        contextTokens: app.config.contextTokens,
        plugins: app.config.plugins.map((p) => p.name),
        owned: app.config.owned.map((x) => x.skill),
        storeRaw: app.config.store,
        hub: hubOf(app.config).id,
        // every agent skm knows, with built-in defaults and the user's overrides, so settings can show both
        agentCatalog: app.config.registry.agents.map((a) => {
          const o = app.config.agentOverrides[a.id];
          return {
            id: a.id, name: a.name, enabled: app.config.agents.includes(a.id), extension: a.extension ?? null,
            defaultDir: a.userDir("~"), defaultUpdate: a.cli.update, bin: a.cli.bin,
            dir: o?.dir.some ? o.dir.value : null, update: o?.update.some ? o.update.value : null,
          };
        }),
        extensions: app.config.registry.extensions,
        extensionsDir: extensionsDir(app.skmHome),
        disabledExtensions: [...app.config.disabledExtensions],
      }, null, 2));
    }
    out(await Bun.file(app.configPath).text());
  });

/** `skm config patch` — read a JSON patch (hosts / agents / backupBeforeApply / contextTokens) on stdin, validate, save. */
export const runConfigPatch = async (): Promise<void> =>
  withApp(async (app) => {
    const p = parsePatch(readFileSync(0, "utf8"));
    if (!p.ok) return die(patchErrorText(p.error));
    const next = patchConfig(app.config, p.value);
    if (!next.ok) return die(patchErrorText(next.error));
    await saveConfig(app.configPath, next.value);
    out(`${pc.green("ok")} saved ${app.configPath}`);
  });

/** `skm extensions`: what each extension adds (agents, desktop apps), what in it skm ignored, and why one did not load. */
export const runExtensions = async (json: boolean): Promise<void> =>
  withApp(async (app) => {
    const r = app.config.registry;
    if (json) return out(JSON.stringify({ dir: extensionsDir(app.skmHome), extensions: r.extensions }, null, 2));
    out(pc.dim(`extensions dir: ${extensionsDir(app.skmHome)}`));
    if (r.extensions.length === 0) return out("no extensions");
    r.extensions.forEach((e) => {
      const what = [
        e.agents.length > 0 ? `agents: ${e.agents.join(", ")}` : "",
        e.apps.length > 0 ? `apps: ${e.apps.join(", ")}` : "",
      ].filter((x) => x !== "").join(" · ");
      const state = e.error !== null ? pc.red(`error: ${e.error}`) : e.enabled ? pc.green("on") : pc.dim("off (disabledExtensions)");
      out(`${pc.bold(e.name)}  ${state}`);
      out(pc.dim(`  ${e.source}`));
      if (what !== "") out(`  ${what}`);
      e.warnings.forEach((w) => out(pc.yellow(`  warning: ${w}`)));
    });
  });
