import React, { useCallback, useEffect, useReducer, useRef } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { match } from "ts-pattern";
import { allInsights } from "../core/heuristics";
import { isMutation } from "../core/plan";
import { isDesired, setScope } from "../core/scope";
import { buildHostView } from "../core/view";
import { agentsOn } from "../shell/hosts";
import type { AppState } from "../shell/app";
import { hostErrorText } from "../shell/probe";
import type { TuiIo } from "./io";
import { type State, initialState, reduce, selectedSkill, visibleSkills } from "./state";
import type { EvalCacheEntry } from "../shell/cache";
import { SkillsView } from "./views/Skills";
import { HostsView } from "./views/Hosts";
import { SyncView } from "./views/Sync";
import { InsightsView } from "./views/Insights";
import { HelpView } from "./views/Help";

export type AppProps = { readonly app: AppState; readonly io: TuiIo; readonly evals: Readonly<Record<string, EvalCacheEntry>>; readonly autoProbe?: boolean };

const EVAL_BATCH = 12;

export const App = ({ app, io, evals, autoProbe = true }: AppProps): React.ReactElement => {
  const [s, dispatch] = useReducer(reduce, undefined, () => initialState(app.config, app.skills, allInsights(app.skills), evals));
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 120;
  const rows = stdout?.rows ?? 36;
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
            ? { kind: "ready", inventory: r.value, ops: io.plan(stateRef.current.config, app.skills, host, r.value), view: buildHostView(host.id, agentsOn(stateRef.current.config, host), r.value, stateRef.current.config.contextTokens, app.claudeOverrides) }
            : { kind: "error", error: r.error },
        }),
      );
    },
    [io, app.skills],
  );
  const probeAll = useCallback(() => stateRef.current.config.hosts.forEach((h) => probe(h.id)), [probe]);
  useEffect(() => { if (autoProbe) probeAll(); }, [autoProbe, probeAll]);

  /** Re-plan every ready host against a new config using the cached inventories (pure). */
  const replan = useCallback(
    (config: State["config"]) => {
      Object.entries(stateRef.current.hosts).forEach(([id, st]) => {
        const host = config.hosts.find((h) => h.id === id);
        if (st.kind === "ready" && host) dispatch({ type: "host", id, status: { ...st, ops: io.plan(config, app.skills, host, st.inventory) } });
      });
    },
    [io, app.skills],
  );

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

  const runSync = useCallback(async () => {
    const st = stateRef.current;
    if (st.busy) return;
    const ts = io.now();
    const targets = st.config.hosts.filter((h) => { const x = st.hosts[h.id]; return x?.kind === "ready" && x.ops.some((o) => isMutation(o) || (st.replaceConflicts && o.op === "conflict")); });
    if (targets.length === 0) { dispatch({ type: "message", text: "nothing to sync" }); dispatch({ type: "confirmSync", on: false }); return; }
    dispatch({ type: "confirmSync", on: false });
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
    dispatch({ type: "view", view: "sync" });
  }, [io]);

  const runEval = useCallback(async () => {
    const st = stateRef.current;
    if (st.busy) return;
    const pending = visibleSkills(st).filter((k) => st.evals[k.name]?.hash !== k.contentHash);
    if (pending.length === 0) { dispatch({ type: "message", text: "all visible skills already evaluated (cache)" }); dispatch({ type: "view", view: "insights" }); return; }
    dispatch({ type: "view", view: "insights" });
    const batches = Array.from({ length: Math.ceil(pending.length / EVAL_BATCH) }, (_, i) => pending.slice(i * EVAL_BATCH, (i + 1) * EVAL_BATCH));
    await batches.reduce(async (p, batch, i) => {
      await p;
      dispatch({ type: "busy", what: `evaluating batch ${i + 1}/${batches.length} with ${st.config.eval.agent}` });
      const r = await io.evaluate(batch, app.skills);
      if (r.ok) dispatch({ type: "evals", evals: r.value });
      else dispatch({ type: "log", line: `eval: ${r.error}` });
    }, Promise.resolve());
    dispatch({ type: "busy", what: undefined });
  }, [io, app.skills]);

  useInput((input, key) => {
    const st = stateRef.current;
    if (st.editingFilter) {
      if (key.return || key.escape) return dispatch({ type: "editFilter", on: false });
      if (key.backspace || key.delete) return dispatch({ type: "filter", text: st.filter.slice(0, -1) });
      if (input && !key.ctrl && !key.meta) return dispatch({ type: "filter", text: st.filter + input });
      return;
    }
    if (st.confirmSync) {
      if (input === "y") return void runSync();
      if (input === "c") return dispatch({ type: "toggleReplace" });
      return dispatch({ type: "confirmSync", on: false });
    }
    if (input === "q") return exit();
    if (key.tab) return dispatch({ type: "nextView" });
    if (input === "?") return dispatch({ type: "view", view: "help" });
    const viewKey = { "1": "skills", "2": "hosts", "3": "sync", "4": "insights", "5": "help" } as const;
    if (input in viewKey) return dispatch({ type: "view", view: viewKey[input as keyof typeof viewKey] });
    if (input === "r") return probeAll();
    if (input === "s") { dispatch({ type: "view", view: "sync" }); return dispatch({ type: "confirmSync", on: true }); }
    if (input === "b") return void runBackup();
    if (input === "e") return void runEval();
    if (st.view === "skills") {
      if (input === "/") return dispatch({ type: "editFilter", on: true });
      if (input === "o") return dispatch({ type: "toggleSort" });
      if (input === "m") return dispatch({ type: "focus", focus: st.focus === "list" ? "grid" : "list" });
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
  });

  const header = (
    <Box justifyContent="space-between">
      <Text>
        <Text bold color="cyan"> skm </Text>
        {(["skills", "hosts", "sync", "insights", "help"] as const).map((v, i) => (
          <Text key={v}>
            {" "}
            <Text inverse={s.view === v} bold={s.view === v}>{` ${i + 1}:${v} `}</Text>
          </Text>
        ))}
      </Text>
      <Text>
        {s.config.hosts.map((h) => {
          const st = s.hosts[h.id];
          const pending = st?.kind === "ready" ? st.ops.filter(isMutation).length : 0;
          const conflicts = st?.kind === "ready" ? st.ops.filter((o) => o.op === "conflict").length : 0;
          return (
            <Text key={h.id}>
              {" "}
              <Text color={!st || st.kind === "probing" ? "gray" : st.kind === "error" ? "red" : pending > 0 ? "yellow" : "green"}>{!st || st.kind === "probing" ? "◌" : st.kind === "error" ? "✗" : pending > 0 ? "●" : "●"}</Text>
              <Text>{h.id}</Text>
              {pending > 0 ? <Text color="yellow">{`+${pending}`}</Text> : null}
              {conflicts > 0 ? <Text color="red">{`!${conflicts}`}</Text> : null}
            </Text>
          );
        })}
        <Text> </Text>
      </Text>
    </Box>
  );

  const footer = (
    <Box justifyContent="space-between">
      <Text color="gray">
        {s.busy ? <Text color="yellow">{`⏳ ${s.busy}  `}</Text> : null}
        {s.editingFilter ? `filter: ${s.filter}▏` : s.view === "skills" && s.focus === "grid" ? "grid: hjkl move  space toggle  m back" : "j/k move  / filter  o sort  m targets  s sync  b backup  e eval  r reprobe  Tab view  q quit"}
      </Text>
      <Text color="gray">{s.message} </Text>
    </Box>
  );

  const body = match(s.view)
    .with("skills", () => <SkillsView s={s} width={cols} height={rows - 3} />)
    .with("hosts", () => <HostsView s={s} />)
    .with("sync", () => <SyncView s={s} height={rows - 3} />)
    .with("insights", () => <InsightsView s={s} height={rows - 3} />)
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
