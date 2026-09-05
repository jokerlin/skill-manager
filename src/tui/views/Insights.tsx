import React from "react";
import { Box, Text } from "ink";
import type { State } from "../state";

export const InsightsView = ({ s, height }: { s: State; height: number }): React.ReactElement => {
  const evals = Object.values(s.evals)
    .map((e) => e.item)
    .sort((a, b) => a.usefulness - b.usefulness || a.description_quality - b.description_quality);
  const evalRows = Math.min(evals.length, Math.max(4, Math.floor((height - 4) / 2)));
  const heurRows = Math.max(3, height - 4 - evalRows);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>LLM evaluation <Text color="gray">{`(${s.config.eval.agent}; e to evaluate visible skills; cached by content hash)`}</Text></Text>
      {evals.length === 0 ? <Text color="gray">no evaluations yet — press e</Text> : null}
      {evals.slice(0, evalRows).map((e) => (
        <Text key={e.name} wrap="truncate-end">
          {`${e.name.padEnd(28).slice(0, 28)} `}
          <Text color={e.usefulness <= 2 ? "red" : e.usefulness === 3 ? "yellow" : "green"}>{"★".repeat(e.usefulness)}{"☆".repeat(5 - e.usefulness)}</Text>
          {` desc ${e.description_quality} `}
          <Text color={e.verdict === "keep" ? "green" : e.verdict === "drop" ? "red" : e.verdict === "merge" ? "magenta" : "yellow"}>{e.verdict.padEnd(5)}</Text>
          {e.overlaps.length > 0 ? <Text color="magenta">{` ~${e.overlaps.join(",")}`}</Text> : null}
          <Text color="gray">{`  ${e.reason}`}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text bold>heuristics <Text color="gray">{`(${s.insights.length} findings, no LLM needed)`}</Text></Text>
      {s.insights.slice(0, heurRows).map((i, n) => (
        <Text key={n} wrap="truncate-end">
          <Text color={i.kind === "spec-violation" ? "red" : i.kind === "duplicate" ? "magenta" : "yellow"}>{i.kind.padEnd(18)}</Text>
          {`${i.skill.padEnd(28).slice(0, 28)} ${i.detail}`}
        </Text>
      ))}
      {s.insights.length > heurRows ? <Text color="gray">{`… ${s.insights.length - heurRows} more (skm doctor)`}</Text> : null}
    </Box>
  );
};
