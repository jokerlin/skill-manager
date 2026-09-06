import React from "react";
import { Box, Text } from "ink";
import type { HostConfig } from "../../core/config";
import { isMutation } from "../../core/plan";
import { activePluginsText } from "../../core/view";
import { agentsOn } from "../../shell/hosts";
import { hostErrorText } from "../../shell/probe";
import type { HostStatus, State } from "../state";

/** One terminal row. Every entry renders exactly one line, so the view can be windowed by `height` instead of letting Yoga shrink (and overlap) rows. */
type Line = React.ReactElement;
type Ready = Extract<HostStatus, { kind: "ready" }>;

const LEGEND = "● managed link  ▣ real dir (unmanaged — `skm adopt` / `skm pull`)  ↗ link elsewhere  ✗ broken  ·  r to re-probe";

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
  const agents = agentsOn(s.config, h).flatMap((a): Line[] => {
    const d = st.inventory.agentDirs[a.id];
    const entries = (d?.entries ?? []).filter((e) => e.kind !== "file");
    const counts = entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});
    const legacy = (st.inventory.alsoReads[a.id] ?? []).filter((e) => e.kind !== "file");
    const c = st.view?.counts[a.id];
    const b = st.view?.budget[a.id];
    const plugins = activePluginsText(st.view?.states[a.id] ?? [], 3);
    const budget = b === undefined ? "" : !Number.isFinite(b.budgetChars) ? `${b.usedChars}c` : b.overBy > 0 ? `${b.usedChars}c/${b.budgetChars}c over by ${b.overBy}c` : `${b.usedChars}c/${b.budgetChars}c fits`;
    const row = (
      <Text key={`${h.id}/${a.id}`} wrap="truncate-end">
        {`  ${a.id.padEnd(8)} `}
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
  return [header, ...agents, ...extra, <Text key={`${h.id}/gap`}> </Text>];
};

/** Every row of the hosts view, one element per terminal line. */
export const hostLines = (s: State): Line[] =>
  s.config.hosts.flatMap((h): Line[] => {
    const st = s.hosts[h.id];
    if (!st || st.kind === "probing") return [<Text key={h.id}><Text bold>{h.id}</Text> <Text color="gray">probing…</Text></Text>];
    if (st.kind === "error") return [<Text key={h.id}><Text bold>{h.id}</Text> <Text color="red">{hostErrorText(st.error)}</Text></Text>];
    return readyLines(s, h, st);
  });

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
