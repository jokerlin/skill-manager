import React from "react";
import { Box, Text } from "ink";
import { isMutation } from "../../core/plan";
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
      const remoteOnly = st.ops.flatMap((o) => (o.op === "remote-only" ? [o.skill] : []));
      return (
        <Box key={h.id} flexDirection="column" marginBottom={1}>
          <Text>
            <Text bold>{h.id}</Text> <Text color="gray">{st.inventory.home}</Text>
            {`  store ${st.inventory.storeSkills.length}  `}
            <Text color={pending.length === 0 ? "green" : "yellow"}>{pending.length === 0 ? "in sync" : `${pending.length} pending`}</Text>
            {conflicts.length > 0 ? <Text color="red">{`  ${conflicts.length} conflicts`}</Text> : null}
            {remoteOnly.length > 0 ? <Text color="magenta">{`  ${remoteOnly.length} remote-only`}</Text> : null}
          </Text>
          {agentsOn(s.config, h).map((a) => {
            const d = st.inventory.agentDirs[a.id];
            const entries = (d?.entries ?? []).filter((e) => e.kind !== "file");
            const counts = entries.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {});
            const legacy = (st.inventory.alsoReads[a.id] ?? []).filter((e) => e.kind !== "file");
            return (
              <Text key={a.id}>
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
          })}
          {remoteOnly.length > 0 ? <Text color="magenta" wrap="truncate-end">{`  remote-only: ${remoteOnly.join(" ")}`}</Text> : null}
        </Box>
      );
    })}
    <Text color="gray">● managed link  ▣ real dir (unmanaged — `skm adopt` / `skm pull`)  ↗ link elsewhere  ✗ broken  ·  r to re-probe</Text>
  </Box>
);
