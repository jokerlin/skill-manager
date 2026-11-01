import React from "react";
import { Box, Text } from "ink";
import { isMutation, opText } from "../../core/plan";
import type { State } from "../state";

/** Pending changes per host, the same list the desktop app's review drawer shows, plus the log of what ran. */
export const ChangesView = ({ s, height }: { s: State; height: number }): React.ReactElement => {
  const ready = s.config.hosts.flatMap((h) => { const st = s.hosts[h.id]; return st?.kind === "ready" ? [{ h, ops: st.ops }] : []; });
  const lines = ready.flatMap(({ h, ops }) => {
    const muts = ops.filter(isMutation);
    const conflicts = ops.filter((o) => o.op === "conflict");
    return [
      { text: `${h.id}: ${muts.length === 0 ? "in sync" : `${muts.length} change${muts.length === 1 ? "" : "s"}`}${conflicts.length > 0 ? `, ${conflicts.length} conflicts` : ""}`, color: muts.length > 0 ? "yellow" : "green", bold: true },
      ...ops.filter((o) => o.op !== "remote-only").map((o) => ({ text: `  ${opText(o)}`, color: o.op === "conflict" ? "red" : undefined, bold: false })),
    ];
  });
  const planRows = Math.max(4, Math.floor((height - 4) / 2));
  const logRows = Math.max(3, height - 4 - planRows);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        pending changes {s.confirm.kind === "apply" ? <Text color="yellow">{`— apply now? y = yes (backup first: ${s.config.backupBeforeApply ? "on" : "off"}), c = toggle replace-conflicts (${s.replaceConflicts ? "ON: real dirs are moved into the backup and replaced by links" : "off: conflicts are left alone"}), any other key = cancel`}</Text> : <Text color="gray">{`(Enter or s to apply · replace-conflicts ${s.replaceConflicts ? "ON" : "off"})`}</Text>}
      </Text>
      {lines.slice(0, planRows).map((l, i) => (
        <Text key={i} {...(l.color ? { color: l.color } : {})} bold={l.bold} wrap="truncate-end">{l.text}</Text>
      ))}
      {lines.length > planRows ? <Text color="gray">{`… ${lines.length - planRows} more (see skm plan)`}</Text> : null}
      <Text> </Text>
      <Text bold>log</Text>
      {s.log.slice(-logRows).map((l, i) => (
        <Text key={i} color="gray" wrap="truncate-end">{l}</Text>
      ))}
    </Box>
  );
};
