import React, { useCallback, useEffect, useReducer, useRef } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { match } from "ts-pattern";
import { isMutation } from "../core/plan";
import { isDesired, setScope } from "../core/scope";
import { buildHostView } from "../core/view";
import { agentsOn } from "../shell/hosts";
import type { AppState } from "../shell/app";
import { hostErrorText } from "../shell/probe";
import type { TuiIo } from "./io";
import { pluginUpdateOps } from "../core/pluginUpdate";
import { stateHint } from "../core/upstream";
import { shortVersion } from "../core/harness";
import { type State, VIEWS, cellWanted, fitCount, initialState, pendingTotal, pluginGrid, pluginRowsOf, pluginUpdatable, reduce, togglePluginCell, selectedSkill, upstreamOf, upstreamUpdatable, visibleSkills } from "./state";
import { SkillsView } from "./views/Skills";
import { PluginsView } from "./views/Plugins";
import { HostsView, clampOffset, hostLines } from "./views/Hosts";
import { ChangesView } from "./views/Changes";
import { HelpView } from "./views/Help";

export type AppProps = { readonly app: AppState; readonly io: TuiIo; readonly autoProbe?: boolean };

export const App = ({ app, io, autoProbe = true }: AppProps): React.ReactElement => {
  const [s, dispatch] = useReducer(reduce, undefined, () => initialState(app.config, app.skills));
  const { exit } = useApp();
  // ink 8 types useStdout().stdout as a plain Writable; useWindowSize reads the size and re-renders on resize
  const { columns: cols, rows } = useWindowSize();
  const stateRef = useRef<State>(s);
  stateRef.current = s;

  const probe = useCallback(
    (hostId: string) => {
      const host = stateRef.current.config.hosts.find((h) => h.id === hostId);
      if (!host) return;
      dispatch({ type: "host", id: hostId, status: { kind: "probing" } });
      void io.probe(host).then((r) =>
        dispatch({
          type: "host",
          id: hostId,
          status: r.ok
            ? { kind: "ready", inventory: r.value, ops: io.plan(stateRef.current.config, stateRef.current.skills, host, r.value), view: buildHostView(host.id, agentsOn(stateRef.current.config, host), r.value, stateRef.current.config.contextTokens, app.claudeOverrides, stateRef.current.config.owned) }
            : { kind: "error", error: r.error },
        }),
      );
    },
    [io, app.claudeOverrides],
  );
  const probeAll = useCallback(() => stateRef.current.config.hosts.forEach((h) => probe(h.id)), [probe]);

  /** Check every upstream: `offline` reads the local mirrors (fast, shown first), otherwise fetch them. */
  const checkUpstream = useCallback(async (offline: boolean) => {
    if (stateRef.current.config.upstreams.length === 0) return;
    dispatch({ type: "upstreamChecking", on: true });
    const r = await io.upstreams(offline);
    dispatch({ type: "upstreamChecking", on: false });
    if (!r.ok) return dispatch({ type: "message", text: `upstream: ${r.error}` });
    dispatch({ type: "upstreams", results: r.value });
    const warned = r.value.flatMap((x) => (x.result.ok && x.result.value.warning.some ? [x.policy.name] : []));
    if (warned.length > 0) dispatch({ type: "message", text: `upstream: fetch failed for ${warned.join(", ")}, showing the cached mirror` });
  }, [io]);

  /** Agent CLI versions per host: `cached` reads the last run's result (instant), otherwise check over ssh. */
  const checkHarness = useCallback(async (cached: boolean) => {
    dispatch({ type: "harnessChecking", on: true });
    const runs = await io.harness(cached);
    dispatch({ type: "harness", runs });
    dispatch({ type: "harnessChecking", on: false });
  }, [io]);

  useEffect(() => {
    if (!autoProbe) return;
    probeAll();
    void checkUpstream(true).then(() => checkUpstream(false));
    void checkHarness(true).then(() => checkHarness(false));
  }, [autoProbe, probeAll, checkUpstream, checkHarness]);

  /** Re-plan every ready host against a new config or store using the cached inventories (pure). */
  const replan = useCallback(
    (config: State["config"], skills: State["skills"] = stateRef.current.skills) => {
      Object.entries(stateRef.current.hosts).forEach(([id, st]) => {
        const host = config.hosts.find((h) => h.id === id);
        if (st.kind === "ready" && host) dispatch({ type: "host", id, status: { ...st, ops: io.plan(config, skills, host, st.inventory) } });
      });
    },
    [io],
  );

  /** The desktop app's "Update agent CLIs": each CLI's own self-update on every reachable host, in parallel. */
  const runHarnessUpdate = useCallback(async () => {
    const st = stateRef.current;
    dispatch({ type: "confirm", confirm: { kind: "none" } });
    if (st.busy) return;
    const hosts = st.config.hosts.filter((h) => st.hosts[h.id]?.kind === "ready");
    if (hosts.length === 0) return dispatch({ type: "message", text: "no reachable host" });
    dispatch({ type: "busy", what: `updating agent CLIs on ${hosts.map((h) => h.id).join(", ")}` });
    await Promise.all(hosts.map(async (h) => {
      const r = await io.harnessUpdate(h, (line) => dispatch({ type: "log", line: `${h.id}: ${line}` }));
      dispatch({ type: "harness", runs: [r] });
      if (r.error !== null) return dispatch({ type: "log", line: `${h.id}: ${r.error}` });
      r.results.forEach((x) => {
        switch (x.kind) {
          case "updated": return dispatch({ type: "log", line: `${h.id}: ${x.agent} ${x.ok ? "ok" : "failed"} ${shortVersion(x.before)} → ${shortVersion(x.after)}` });
          case "missing": return dispatch({ type: "log", line: `${h.id}: ${x.agent} not installed` });
          case "checked": return;
        }
      });
    }));
    dispatch({ type: "busy", what: undefined });
    dispatch({ type: "view", view: "changes" });
  }, [io]);

  /** The desktop app's upstream Update: write skills from the mirror the TUI showed, backup first, then re-read the store so the copies to other hosts show up as pending changes. */
  const runUpstreamUpdate = useCallback(async (skills: readonly string[], force: boolean) => {
    dispatch({ type: "confirm", confirm: { kind: "none" } });
    if (stateRef.current.busy) return;
    dispatch({ type: "busy", what: `updating ${skills.join(", ")} from upstream` });
    const r = await io.upstreamUpdate(skills, force, (e) => {
      switch (e.kind) {
        case "backup": return dispatch({ type: "log", line: `${e.host}: backup ${e.dir}  (restore: skm restore ${e.host} ${e.ts})` });
        case "updated": return dispatch({ type: "log", line: `upstream: updated ${e.skill} → ${e.label}` });
        case "failed": return dispatch({ type: "log", line: `upstream: ${e.skill} failed: ${e.reason}` });
      }
    });
    if (!r.ok) {
      dispatch({ type: "log", line: `upstream: ${r.error}` });
      dispatch({ type: "message", text: `upstream: ${r.error}` });
      return dispatch({ type: "busy", what: undefined });
    }
    r.value.outcomes.filter((x) => x.result === "refused" || x.result === "skipped").forEach((x) => dispatch({ type: "log", line: `upstream: ${x.result} ${x.skill}: ${x.reason}` }));
    const updated = r.value.outcomes.filter((x) => x.result === "updated").length;
    const failed = r.value.outcomes.filter((x) => x.result === "failed").length;
    if (updated > 0) {
      const store = await io.loadSkills();
      if (store.ok) {
        dispatch({ type: "skills", skills: store.value });
        replan(stateRef.current.config, store.value);
      } else dispatch({ type: "log", line: store.error });
    }
    await checkUpstream(true);
    dispatch({ type: "busy", what: undefined });
    dispatch({ type: "message", text: updated === 0 && failed === 0 ? "upstream: nothing written" : `upstream: updated ${updated}${failed > 0 ? `, ${failed} failed (see 4:changes log)` : ""}${updated > 0 ? " · s to copy to every host" : ""}` });
  }, [io, replan, checkUpstream]);

  const toggleCell = useCallback(() => {
    const st = stateRef.current;
    const skill = selectedSkill(st);
    const host = st.config.hosts[st.grid.host];
    const agent = st.config.agents[st.grid.agent];
    if (!skill || !host || !agent) return;
    const next = setScope(st.config, skill.name, host.id, agent, !isDesired(st.config, skill.name, host.id, agent));
    dispatch({ type: "config", config: next });
    replan(next);
    void io.saveConfig(next).then(() => dispatch({ type: "message", text: `saved ${skill.name} ${host.id}/${agent}` }));
  }, [io, replan]);

  /** The desktop app's plugin switch: flip the highlighted cell in config.yaml; the next apply enables or disables the plugin there. */
  const togglePlugin = useCallback(() => {
    const st = stateRef.current;
    const row = pluginRowsOf(st)[st.pluginSel];
    const cell = row ? pluginGrid(st, row)[st.pluginCell] : undefined;
    if (!row || !cell) return;
    const toggled = togglePluginCell(st, row, cell);
    if (!toggled.ok) return dispatch({ type: "message", text: toggled.error });
    const next = toggled.value;
    if (next === st.config) return dispatch({ type: "message", text: `${row.name} ${cell.host}/${cell.agent} unchanged` });
    const on = !cellWanted(cell);
    dispatch({ type: "config", config: next });
    replan(next);
    void io.saveConfig(next).then(() => dispatch({ type: "message", text: `saved plugin ${row.name} ${cell.host}/${cell.agent} → ${on ? "on" : "off"}` }));
  }, [io, replan]);

  const runSync = useCallback(async () => {
    const st = stateRef.current;
    if (st.busy) return;
    const ts = io.now();
    const targets = st.config.hosts.filter((h) => { const x = st.hosts[h.id]; return x?.kind === "ready" && x.ops.some((o) => isMutation(o) || (st.replaceConflicts && o.op === "conflict")); });
    if (targets.length === 0) { dispatch({ type: "message", text: "nothing to apply" }); dispatch({ type: "confirm", confirm: { kind: "none" } }); return; }
    dispatch({ type: "confirm", confirm: { kind: "none" } });
    dispatch({ type: "busy", what: `syncing ${targets.map((h) => h.id).join(", ")}` });
    await Promise.all(
      targets.map(async (host) => {
        const x = st.hosts[host.id];
        if (x?.kind !== "ready") return;
        if (st.config.backupBeforeApply) {
          const b = await io.backup(host, ts);
          if (!b.ok) { dispatch({ type: "log", line: `${host.id}: backup failed: ${hostErrorText(b.error)} — skipped` }); return; }
          dispatch({ type: "log", line: `${host.id}: backup ${b.value}  (restore: skm restore ${host.id} ${ts})` });
        }
        const r = await io.apply(host, x.ops, st.replaceConflicts, ts, (l) => dispatch({ type: "log", line: l }));
        dispatch({ type: "log", line: r.error ? `${host.id}: ${hostErrorText(r.error)}` : `${host.id}: done — rsynced ${r.rsynced.length}, applied ${r.applied.length}${r.skipped.length > 0 ? `, skipped ${r.skipped.length}` : ""}` });
        probe(host.id);
      }),
    );
    dispatch({ type: "busy", what: undefined });
  }, [io, probe]);

  const runBackup = useCallback(async () => {
    const st = stateRef.current;
    if (st.busy) return;
    const ts = io.now();
    dispatch({ type: "busy", what: "backing up" });
    await Promise.all(st.config.hosts.filter((h) => st.hosts[h.id]?.kind === "ready").map(async (h) => {
      const b = await io.backup(h, ts);
      dispatch({ type: "log", line: b.ok ? `${h.id}: backup ${b.value}  (restore: skm restore ${h.id} ${ts})` : `${h.id}: ${hostErrorText(b.error)}` });
    }));
    dispatch({ type: "busy", what: undefined });
    dispatch({ type: "view", view: "changes" });
  }, [io]);

  /** The desktop app's "Update everywhere": refresh marketplaces and update one plugin on every reachable host, backup first. */
  const runPluginUpdate = useCallback(async (plugin: string) => {
    const st = stateRef.current;
    dispatch({ type: "confirm", confirm: { kind: "none" } });
    if (st.busy) return;
    const ts = io.now();
    const jobs = st.config.hosts.flatMap((host) => {
      const x = st.hosts[host.id];
      if (x?.kind !== "ready" || !x.view) return [];
      const ops = pluginUpdateOps(host.id, x.view.states, x.view.facts, x.inventory.tools, { plugins: [plugin], agents: [] });
      return ops.some(isMutation) ? [{ host, ops }] : [];
    });
    if (jobs.length === 0) return dispatch({ type: "message", text: `${plugin}: nothing to update` });
    dispatch({ type: "busy", what: `updating ${plugin} on ${jobs.map((j) => j.host.id).join(", ")}` });
    await Promise.all(jobs.map(async ({ host, ops }) => {
      if (st.config.backupBeforeApply) {
        const b = await io.backup(host, ts);
        if (!b.ok) { dispatch({ type: "log", line: `${host.id}: backup failed: ${hostErrorText(b.error)} — skipped` }); return; }
        dispatch({ type: "log", line: `${host.id}: backup ${b.value}  (restore: skm restore ${host.id} ${ts})` });
      }
      const r = await io.apply(host, ops, false, ts, (l) => dispatch({ type: "log", line: l }));
      dispatch({ type: "log", line: r.error ? `${host.id}: ${hostErrorText(r.error)}` : `${host.id}: ${plugin} — ${r.commands.filter((c) => c.ok).length} commands ok${r.commands.some((c) => !c.ok) ? `, ${r.commands.filter((c) => !c.ok).length} failed` : ""}` });
      probe(host.id);
    }));
    dispatch({ type: "busy", what: undefined });
    dispatch({ type: "view", view: "changes" });
  }, [io, probe]);

  useInput((input, key) => {
    const st = stateRef.current;
    if (st.editingFilter) {
      if (key.return || key.escape) return dispatch({ type: "editFilter", on: false });
      if (key.backspace || key.delete) return dispatch({ type: "filter", text: st.filter.slice(0, -1) });
      if (input && !key.ctrl && !key.meta) return dispatch({ type: "filter", text: st.filter + input });
      return;
    }
    const c = st.confirm;
    switch (c.kind) {
      case "apply":
        if (input === "y") return void runSync();
        if (input === "c") return dispatch({ type: "toggleReplace" });
        return dispatch({ type: "confirm", confirm: { kind: "none" } });
      case "plugin-update":
        if (input === "y") return void runPluginUpdate(c.plugin);
        return dispatch({ type: "confirm", confirm: { kind: "none" } });
      case "upstream-update":
        if (input === "y") return void runUpstreamUpdate(c.skills, c.force);
        return dispatch({ type: "confirm", confirm: { kind: "none" } });
      case "harness-update":
        if (input === "y") return void runHarnessUpdate();
        return dispatch({ type: "confirm", confirm: { kind: "none" } });
      case "none":
        break;
    }
    if (input === "q") return exit();
    if (key.tab) return dispatch({ type: "nextView" });
    if (input === "?") return dispatch({ type: "view", view: "help" });
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= VIEWS.length) return dispatch({ type: "view", view: VIEWS[n - 1] ?? "skills" });
    if (input === "r") { probeAll(); void checkHarness(false); return void checkUpstream(false); }
    const askApply = () => { dispatch({ type: "view", view: "changes" }); dispatch({ type: "confirm", confirm: { kind: "apply" } }); };
    if (input === "s") return askApply();
    if (st.view === "changes" && key.return) return askApply();
    if (st.view === "plugins" && st.pluginFocus === "grid") {
      if (input === "m" || key.escape) return dispatch({ type: "pluginFocus", focus: "list" });
      if (input === "j" || key.downArrow) return dispatch({ type: "movePluginCell", delta: 1 });
      if (input === "k" || key.upArrow) return dispatch({ type: "movePluginCell", delta: -1 });
      if (input === " " || key.return) return togglePlugin();
    }
    if (st.view === "plugins" && st.pluginFocus === "list") {
      if (input === "m") return dispatch({ type: "pluginFocus", focus: "grid" });
      if (input === "j" || key.downArrow) return dispatch({ type: "movePlugin", delta: 1 });
      if (input === "k" || key.upArrow) return dispatch({ type: "movePlugin", delta: -1 });
      if (input === "g") return dispatch({ type: "movePlugin", delta: -1_000_000 });
      if (input === "G") return dispatch({ type: "movePlugin", delta: 1_000_000 });
      if (input === "u") {
        const row = pluginRowsOf(st)[st.pluginSel];
        if (!row) return;
        if (row.cells.length === 0) return dispatch({ type: "message", text: `${row.name} is not installed on any host` });
        if (!pluginUpdatable(row)) return dispatch({ type: "message", text: `${row.name} ships with an app: update the app with skm harness update` });
        return dispatch({ type: "confirm", confirm: { kind: "plugin-update", plugin: row.name } });
      }
    }
    if (input === "b") return void runBackup();
    if (st.view === "skills") {
      if (input === "/") return dispatch({ type: "editFilter", on: true });
      if (input === "o") return dispatch({ type: "cycleSort" });
      if (input === "O") return dispatch({ type: "flipSort" });
      if (input === "m") return dispatch({ type: "focus", focus: st.focus === "list" ? "grid" : "list" });
      if (input === "u" && st.focus === "list") {
        const skill = selectedSkill(st);
        if (!skill) return;
        const up = upstreamOf(st, skill.name);
        if (!up.some) return dispatch({ type: "message", text: st.upstream.checking ? "upstream: still checking" : `${skill.name} has no upstream` });
        const target = up.value.skill.target.label;
        switch (up.value.skill.state.kind) {
          case "behind":
          case "absent":
            return dispatch({ type: "confirm", confirm: { kind: "upstream-update", skills: [skill.name], force: false } });
          case "modified":
          case "unbased":
            return dispatch({ type: "confirm", confirm: { kind: "upstream-update", skills: [skill.name], force: true } });
          case "current":
            return dispatch({ type: "message", text: `${skill.name} is already at ${target}` });
          case "gone":
            return dispatch({ type: "message", text: `${skill.name}: ${stateHint.gone}` });
        }
      }
      if (input === "U" && st.focus === "list") {
        const skills = upstreamUpdatable(st);
        if (skills.length === 0) return dispatch({ type: "message", text: st.upstream.checking ? "upstream: still checking" : "no upstream updates" });
        return dispatch({ type: "confirm", confirm: { kind: "upstream-update", skills, force: false } });
      }
      if (key.escape) { dispatch({ type: "filter", text: "" }); return dispatch({ type: "focus", focus: "list" }); }
      if (st.focus === "grid") {
        if (input === "j" || key.downArrow) return dispatch({ type: "moveGrid", dHost: 1, dAgent: 0 });
        if (input === "k" || key.upArrow) return dispatch({ type: "moveGrid", dHost: -1, dAgent: 0 });
        if (input === "l" || key.rightArrow) return dispatch({ type: "moveGrid", dHost: 0, dAgent: 1 });
        if (input === "h" || key.leftArrow) return dispatch({ type: "moveGrid", dHost: 0, dAgent: -1 });
        if (input === " " || key.return) return toggleCell();
        return;
      }
      if (input === "j" || key.downArrow) return dispatch({ type: "move", delta: 1 });
      if (input === "k" || key.upArrow) return dispatch({ type: "move", delta: -1 });
      if (key.pageDown) return dispatch({ type: "move", delta: 10 });
      if (key.pageUp) return dispatch({ type: "move", delta: -10 });
      if (input === "g") return dispatch({ type: "move", delta: -1_000_000 });
      if (input === "G") return dispatch({ type: "move", delta: 1_000_000 });
    }
    if (st.view === "hosts") {
      if (input === "H") { dispatch({ type: "scrollHosts", offset: 0 }); return dispatch({ type: "confirm", confirm: { kind: "harness-update" } }); }
      if (input === "f") return dispatch({ type: "toggleFindings" });
      const scroll = (delta: number) => dispatch({ type: "scrollHosts", offset: clampOffset(st.hostsOffset + delta, hostLines(st).length, rows - 3) });
      if (input === "j" || key.downArrow) return scroll(1);
      if (input === "k" || key.upArrow) return scroll(-1);
      if (key.pageDown) return scroll(10);
      if (key.pageUp) return scroll(-10);
      if (input === "g") return scroll(-1_000_000);
      if (input === "G") return scroll(1_000_000);
    }
  });

  // Header and footer must stay one line each: a wrapped line pushes the body down by a row. Content is fitted by whole
  // segments (a host, a key hint) instead of letting Yoga shrink the Text, which wraps it.
  const pending = pendingTotal(s);
  const tabs = VIEWS.map((v, i) => ({ v, label: ` ${i + 1}:${v}${v === "changes" && pending > 0 ? ` ${pending}` : ""} ` }));
  const tabsWidth = " skm ".length + tabs.reduce((n, t) => n + 1 + t.label.length, 0);
  const hostSegs = s.config.hosts.map((h) => {
    const st = s.hosts[h.id];
    const pending = st?.kind === "ready" ? st.ops.filter(isMutation).length : 0;
    const conflicts = st?.kind === "ready" ? st.ops.filter((o) => o.op === "conflict").length : 0;
    const width = 2 + h.id.length + (pending > 0 ? `+${pending}`.length : 0) + (conflicts > 0 ? `!${conflicts}`.length : 0);
    return { h, st, pending, conflicts, width };
  });
  const hostRoom = cols - tabsWidth - 1;
  const allHostsFit = fitCount(hostSegs.map((x) => x.width), hostRoom) === hostSegs.length;
  const shownHosts = allHostsFit ? hostSegs.length : fitCount(hostSegs.map((x) => x.width), hostRoom - ` +${hostSegs.length}`.length);
  // flexShrink 0 on header and footer: a tall body would otherwise squeeze them to zero rows
  const header = (
    <Box justifyContent="space-between" flexShrink={0}>
      <Box flexShrink={0}>
        <Text>
          <Text bold color="cyan"> skm </Text>
          {tabs.map(({ v, label }) => (
            <Text key={v}>
              {" "}
              <Text inverse={s.view === v} bold={s.view === v} {...(v === "changes" && pending > 0 ? { color: "yellow" } : {})}>{label}</Text>
            </Text>
          ))}
        </Text>
      </Box>
      <Text>
        {hostSegs.slice(0, shownHosts).map(({ h, st, pending, conflicts }) => (
          <Text key={h.id}>
            {" "}
            <Text color={!st || st.kind === "probing" ? "gray" : st.kind === "error" ? "red" : pending > 0 ? "yellow" : "green"}>{!st || st.kind === "probing" ? "◌" : st.kind === "error" ? "✗" : "●"}</Text>
            <Text>{h.id}</Text>
            {pending > 0 ? <Text color="yellow">{`+${pending}`}</Text> : null}
            {conflicts > 0 ? <Text color="red">{`!${conflicts}`}</Text> : null}
          </Text>
        ))}
        {shownHosts < hostSegs.length ? <Text color="gray">{` +${hostSegs.length - shownHosts}`}</Text> : null}
        <Text> </Text>
      </Text>
    </Box>
  );

  const hints = s.editingFilter ? [`filter: ${s.filter}▏`]
    : s.view === "skills" && s.focus === "grid" ? ["grid: hjkl move", "space toggle", "m back"]
    : s.view === "plugins" && s.pluginFocus === "grid" ? ["cells: j/k move", "space toggle", "m back"]
    : s.view === "plugins" ? ["j/k move", "m cells", "u update everywhere", "s apply changes", "r reprobe", "Tab view", "q quit"]
    : s.view === "hosts" ? ["j/k scroll", "H update agent CLIs", "f findings", "s apply changes", "b backup", "r reprobe", "Tab view", "q quit"]
    : s.view === "changes" ? ["Enter apply", "c replace-conflicts (when asked)", "b backup", "r reprobe", "Tab view", "q quit"]
    : ["j/k move", "/ filter", "o sort", "O flip", "m targets", ...(s.config.upstreams.length > 0 ? ["u/U upstream"] : []), "s apply changes", "b backup", "r reprobe", "Tab view", "q quit"];
  const busyText = s.busy ? `⏳ ${s.busy}  ` : "";
  // ⏳ takes two columns; the message keeps one trailing space
  const hintRoom = cols - (busyText ? busyText.length + 1 : 0) - (s.message.length + 1);
  const shownHints = Math.max(1, fitCount(hints.map((x, i) => x.length + (i > 0 ? 2 : 0)), hintRoom));
  const footer = (
    <Box justifyContent="space-between" flexShrink={0}>
      <Text color="gray" wrap="truncate">
        {busyText ? <Text color="yellow">{busyText}</Text> : null}
        {hints.slice(0, shownHints).join("  ")}
      </Text>
      <Box flexShrink={0}><Text color="gray">{s.message} </Text></Box>
    </Box>
  );

  const body = match(s.view)
    .with("skills", () => <SkillsView s={s} width={cols} height={rows - 3} />)
    .with("plugins", () => <PluginsView s={s} width={cols} height={rows - 3} />)
    .with("hosts", () => <HostsView s={s} height={rows - 3} offset={s.hostsOffset} />)
    .with("changes", () => <ChangesView s={s} height={rows - 3} />)
    .with("help", () => <HelpView />)
    .exhaustive();

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      {header}
      <Box flexGrow={1} flexDirection="column">{body}</Box>
      {footer}
    </Box>
  );
};
