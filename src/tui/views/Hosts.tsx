import React from "react";
import { Box, Text } from "ink";
import { isMutation } from "../../core/plan";
import { activePluginsText } from "../../core/view";
import { agentsOn } from "../../shell/hosts";
import { hostErrorText } from "../../shell/probe";
import type { State } from "../state";

export const HostsView = ({ s }: { s: State }): React.ReactElement => (
  <Box flexDirection="column" paddingX={1}>
    {s.config.hosts.map((h) => {
      const st = s.hosts[h.id];
      if (!st || st.kind === "probing") return <Text key={h.id}><Text bold>{h.id}</Text> <Text color="gray">probing…</Text></Text>;
      if (st.kind === "error") return <Text key={h.id}><Text bold>{h.id}</Text> <Text color="red">{hostErrorText(st.error)}</Text></Text>;
      const pending = st.ops.filter(isMutation);
      const conflicts = st.ops.filter((o) => o.op === "conflict");
      const blocked = st.ops.filter((o) => o.op === "blocked");
      const tools = Object.keys(st.inventory.tools);
      const remoteOnly = st.ops.flatMap((o) => (o.op === "remote-only" ? [o.skill] : []));
      return (
        <Box key={h.id} flexDirection="column" marginBottom={1}>
          <Text>
            <Text bold>{h.id}</Text> <Text color="gray">{st.inventory.home}</Text>
            {`  store ${st.inventory.storeSkills.length}  `}
            <Text color={pending.length === 0 ? "green" : "yellow"}>{pending.length === 0 ? "in sync" : `${pending.length} pending`}</Text>
            {conflicts.length > 0 ? <Text color="red">{`  ${conflicts.length} conflicts`}</Text> : null}
            {blocked.length > 0 ? <Text color="yellow">{`  ${blocked.length} blocked`}</Text> : null}
            {remoteOnly.length > 0 ? <Text color="magenta">{`  ${remoteOnly.length} remote-only`}</Text> : null}
            {tools.length > 0 ? <Text color="gray">{`  tools: ${tools.join(" ")}`}</Text> : null}
          </Text>
          {agentsOn(s.config, h).map((a) => {
            const d = st.inventory.agentDirs[a.id];
            const entries = (d?.entries ?? []).filter((e) => e.kind !== "file");
            const counts = entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});
            const legacy = (st.inventory.alsoReads[a.id] ?? []).filter((e) => e.kind !== "file");
            const c = st.view?.counts[a.id];
            const b = st.view?.budget[a.id];
            const plugins = activePluginsText(st.view?.states[a.id] ?? [], 3);
            const budget = b === undefined ? "" : !Number.isFinite(b.budgetChars) ? `${b.usedChars}c` : b.overBy > 0 ? `${b.usedChars}c/${b.budgetChars}c over by ${b.overBy}c` : `${b.usedChars}c/${b.budgetChars}c fits`;
            return (
              <Box key={a.id} flexDirection="column">
              <Text>
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
              {c ? (
                <Text wrap="truncate-end">
                  {"           "}
                  <Text color="gray">{`loads ${c.user + c.legacy + c.builtin + c.plugin}: user ${c.user}${c.legacy ? ` · legacy ${c.legacy}` : ""}${c.builtin ? ` · builtin ${c.builtin}` : ""}${c.plugin ? ` · plugin ${c.plugin}${plugins ? ` (${plugins})` : ""}` : ""}  `}</Text>
                  <Text color={b && b.overBy > 0 ? "red" : "green"}>{budget}</Text>
                </Text>
              ) : null}
              </Box>
            );
          })}
          {remoteOnly.length > 0 ? <Text color="magenta" wrap="truncate-end">{`  remote-only: ${remoteOnly.join(" ")}`}</Text> : null}
        </Box>
      );
    })}
    <Text color="gray">● managed link  ▣ real dir (unmanaged — `skm adopt` / `skm pull`)  ↗ link elsewhere  ✗ broken  ·  r to re-probe</Text>
  </Box>
);
