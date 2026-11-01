import React from "react";
import { Box, Text } from "ink";
import type { HostConfig } from "../../core/config";
import { isMutation } from "../../core/plan";
import { activePluginsText } from "../../core/view";
import { agentsOn } from "../../shell/hosts";
import { hostErrorText } from "../../shell/probe";
import { type Finding, findingText } from "../../core/effective";
import { type ToolVersions, behindHosts, newestOf, toolVersions } from "../../core/harness";
import { type HarnessToolRow, type HostStatus, type State, harnessRuns, harnessTools } from "../state";

/** One terminal row. Every entry renders exactly one line, so the view can be windowed by `height` instead of letting Yoga shrink (and overlap) rows. */
type Line = React.ReactElement;
type Ready = Extract<HostStatus, { kind: "ready" }>;

const LEGEND = "● managed link  ▣ real dir (unmanaged — `skm adopt` / `skm pull`)  ↗ link elsewhere  ✗ broken  ·  H update agent CLIs  ·  r to re-probe";

type Tone = "green" | "yellow" | "red" | "gray" | "magenta";

/** The summary of one tool across hosts, in the desktop app's words. Pure. */
export const toolStatus = (row: HarnessToolRow, t: ToolVersions, checking: boolean): { readonly text: string; readonly color: Tone } => {
  const behind = behindHosts(t);
  const known = t.byHost.filter((x) => x.v.kind !== "unknown");
  if (known.length === 0) return { text: checking ? "checking…" : "not checked", color: "gray" };
  if (t.versions.length === 0) return { text: "not installed", color: "gray" };
  if (behind.length > 0) {
    const at = behind.map((h) => { const v = t.byHost.find((x) => x.host === h)?.v; return v?.kind === "version" ? `${h} ${v.version}` : h; }).join(", ");
    switch (row.kind) {
      case "app": return { text: `can update to ${newestOf(t)} on ${at} (skm harness update --agent ${row.id})`, color: "yellow" };
      case "cli": return { text: `${t.versions.length} versions · older on ${at}`, color: "red" };
    }
  }
  return { text: row.kind === "app" && t.latest !== "" ? "up to date" : known.length > 1 ? "same version everywhere" : "", color: "gray" };
};

/** The agent CLIs section above the hosts: newest version of each tool and where it differs, or the y/n prompt of an update. */
const harnessLines = (s: State): Line[] => {
  const runs = harnessRuns(s);
  const rows = harnessTools(s.config).map((row) => ({ row, t: toolVersions(runs, row.id) }));
  const nameWidth = Math.max(8, ...rows.map((r) => r.row.name.length));
  const versionWidth = Math.max(1, ...rows.map((r) => newestOf(r.t).length));
  const ready = s.config.hosts.filter((h) => s.hosts[h.id]?.kind === "ready").map((h) => h.id);
  const title = s.confirm.kind === "harness-update"
    ? <Text key="harness/title" color="yellow" wrap="truncate-end">{`update every agent CLI on ${ready.join(", ")}? y = yes, any other key = cancel`}</Text>
    : <Text key="harness/title" wrap="truncate-end"><Text bold>agent CLIs</Text><Text color="gray">{`  H update every CLI on every reachable host${s.harness.checking ? " · checking versions…" : ""}`}</Text></Text>;
  return [
    title,
    ...rows.map(({ row, t }) => {
      const st = toolStatus(row, t, s.harness.checking);
      return (
        <Text key={`harness/${row.id}`} wrap="truncate-end">
          {`  ${row.name.padEnd(nameWidth)} `}
          <Text {...(st.color === "red" ? { color: "red" } : {})}>{(newestOf(t) || "–").padEnd(versionWidth)}</Text>
          <Text color={st.color}>{st.text === "" ? "" : `  ${st.text}`}</Text>
        </Text>
      );
    }),
    <Text key="harness/gap"> </Text>,
  ];
};

const findingTone = (f: Finding): Tone => (f.kind === "same-name" ? "yellow" : f.kind === "same-content" ? "magenta" : "gray");

/** How many findings of each kind, most first: "stale-cache 15 · shadowed 2". Pure. */
export const findingSummary = (fs: readonly Finding[]): string =>
  Object.entries(fs.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {}))
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");

/** A finding's text without the host prefix the hosts view already shows. Pure. */
export const findingLine = (host: string, f: Finding): string => {
  const t = findingText(f);
  return t.startsWith(`${host}/`) ? t.slice(host.length + 1) : t.startsWith(`${host}: `) ? t.slice(host.length + 2) : t;
};

/** Largest offset that still fills the window; `height` includes the footer row. */
export const clampOffset = (offset: number, total: number, height: number): number =>
  Math.min(Math.max(0, offset), Math.max(0, total - Math.max(1, height - 1)));

const readyLines = (s: State, h: HostConfig, st: Ready): Line[] => {
  const pending = st.ops.filter(isMutation);
  const conflicts = st.ops.filter((o) => o.op === "conflict");
  const blocked = st.ops.filter((o) => o.op === "blocked");
  const tools = Object.keys(st.inventory.tools);
  const remoteOnly = st.ops.flatMap((o) => (o.op === "remote-only" ? [o.skill] : []));
  const header = (
    <Text key={`${h.id}/header`} wrap="truncate-end">
      <Text bold>{h.id}</Text> <Text color="gray">{st.inventory.home}</Text>
      {`  store ${st.inventory.storeSkills.length}  `}
      <Text color={pending.length === 0 ? "green" : "yellow"}>{pending.length === 0 ? "in sync" : `${pending.length} pending`}</Text>
      {conflicts.length > 0 ? <Text color="red">{`  ${conflicts.length} conflicts`}</Text> : null}
      {blocked.length > 0 ? <Text color="yellow">{`  ${blocked.length} blocked`}</Text> : null}
      {remoteOnly.length > 0 ? <Text color="magenta">{`  ${remoteOnly.length} remote-only`}</Text> : null}
      {tools.length > 0 ? <Text color="gray">{`  tools: ${tools.join(" ")}`}</Text> : null}
    </Text>
  );
  const runs = harnessRuns(s);
  const versions = Object.fromEntries(agentsOn(s.config, h).map((a) => [a.id, toolVersions(runs, a.id)]));
  const verText = (id: string): { text: string; color: Tone } => {
    const t = versions[id];
    const v = t?.byHost.find((x) => x.host === h.id)?.v;
    if (!t || !v) return { text: "", color: "gray" };
    switch (v.kind) {
      case "unknown": return { text: "", color: "gray" };
      case "missing": return { text: "–", color: "gray" };
      case "version": return { text: v.version, color: behindHosts(t).includes(h.id) ? "red" : "gray" };
    }
  };
  const verWidth = Math.max(0, ...agentsOn(s.config, h).map((a) => verText(a.id).text.length));
  const agents = agentsOn(s.config, h).flatMap((a): Line[] => {
    const d = st.inventory.agentDirs[a.id];
    const entries = (d?.entries ?? []).filter((e) => e.kind !== "file");
    const counts = entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});
    const legacy = (st.inventory.alsoReads[a.id] ?? []).filter((e) => e.kind !== "file");
    const c = st.view?.counts[a.id];
    const b = st.view?.budget[a.id];
    const plugins = activePluginsText(st.view?.states[a.id] ?? [], 3);
    const budget = b === undefined ? "" : !Number.isFinite(b.budgetTokens) ? `${b.usedTokens}t` : b.overBy > 0 ? `${b.usedTokens}t/${b.budgetTokens}t over by ${b.overBy}t` : `${b.usedTokens}t/${b.budgetTokens}t fits`;
    const row = (
      <Text key={`${h.id}/${a.id}`} wrap="truncate-end">
        {`  ${a.id.padEnd(8)} `}
        {verWidth > 0 ? <Text color={verText(a.id).color}>{`${verText(a.id).text.padEnd(verWidth)} `}</Text> : null}
        {d?.exists ? (
          <Text>
            <Text color="green">{`● ${counts["managed"] ?? 0}`}</Text>
            {counts["dir"] ? <Text color="yellow">{`  ▣ ${counts["dir"]}`}</Text> : null}
            {counts["foreign-link"] ? <Text color="magenta">{`  ↗ ${counts["foreign-link"]}`}</Text> : null}
            {counts["broken-link"] ? <Text color="red">{`  ✗ ${counts["broken-link"]}`}</Text> : null}
            {legacy.length > 0 ? <Text color="gray">{`  legacy dir: ${legacy.length}`}</Text> : null}
            <Text color="gray">{`   ${a.userDir(st.inventory.home)}`}</Text>
          </Text>
        ) : (
          <Text color="gray">absent</Text>
        )}
      </Text>
    );
    const loads = c
      ? [
          <Text key={`${h.id}/${a.id}/loads`} wrap="truncate-end">
            {"           "}
            <Text color="gray">{`loads ${c.user + c.legacy + c.builtin + c.plugin}: user ${c.user}${c.legacy ? ` · legacy ${c.legacy}` : ""}${c.builtin ? ` · builtin ${c.builtin}` : ""}${c.plugin ? ` · plugin ${c.plugin}${plugins ? ` (${plugins})` : ""}` : ""}  `}</Text>
            <Text color={b && b.overBy > 0 ? "red" : "green"}>{budget}</Text>
          </Text>,
        ]
      : [];
    return [row, ...loads];
  });
  const extra = remoteOnly.length > 0 ? [<Text key={`${h.id}/remote-only`} color="magenta" wrap="truncate-end">{`  remote-only: ${remoteOnly.join(" ")}`}</Text>] : [];
  const fs = st.view?.findings ?? [];
  const findings = fs.length === 0 ? [] : [
    <Text key={`${h.id}/findings`} wrap="truncate-end">
      <Text bold>{"  findings "}</Text>
      <Text color="gray">{s.allFindings ? `${fs.length}  (f to collapse)` : `${fs.length}: ${findingSummary(fs)}  (f to list)`}</Text>
    </Text>,
    ...(s.allFindings ? fs : []).map((f, i) => (
      <Text key={`${h.id}/finding/${i}`} wrap="truncate-end">
        {"    "}<Text color={findingTone(f)}>{f.kind.padEnd(16)}</Text>{findingLine(h.id, f)}
      </Text>
    )),
  ];
  return [header, ...agents, ...extra, ...findings, <Text key={`${h.id}/gap`}> </Text>];
};

/** Every row of the hosts view, one element per terminal line. */
export const hostLines = (s: State): Line[] => [
  ...harnessLines(s),
  ...s.config.hosts.flatMap((h): Line[] => {
    const st = s.hosts[h.id];
    if (!st || st.kind === "probing") return [<Text key={h.id}><Text bold>{h.id}</Text> <Text color="gray">probing…</Text></Text>];
    if (st.kind === "error") return [<Text key={h.id}><Text bold>{h.id}</Text> <Text color="red">{hostErrorText(st.error)}</Text></Text>];
    return readyLines(s, h, st);
  }),
];

export const HostsView = ({ s, height, offset }: { s: State; height: number; offset: number }): React.ReactElement => {
  const lines = hostLines(s);
  const body = Math.max(1, height - 1);
  const start = clampOffset(offset, lines.length, height);
  const shown = lines.slice(start, start + body);
  const footer = lines.length > body ? `lines ${start + 1}–${start + shown.length} of ${lines.length}  j/k scroll  ·  ${LEGEND}` : LEGEND;
  return (
    <Box flexDirection="column" paddingX={1} height={height} overflow="hidden">
      {shown}
      <Text color="gray" wrap="truncate-end">{footer}</Text>
    </Box>
  );
};
