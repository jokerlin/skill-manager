import React from "react";
import { Box, Text } from "ink";
import { isDesired } from "../../core/scope";
import { descriptionOf } from "../../core/skill";
import { agentsOn } from "../../shell/hosts";
import { type State, cellGlyph, selectedSkill, sortText, visibleSkills } from "../state";

const fmtK = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const SkillsView = ({ s, width, height }: { s: State; width: number; height: number }): React.ReactElement => {
  const list = visibleSkills(s);
  const sel = selectedSkill(s);
  const listWidth = Math.max(34, Math.floor(width * 0.42));
  const visibleRows = Math.max(3, height - 3);
  const start = Math.max(0, Math.min(s.selected - Math.floor(visibleRows / 2), list.length - visibleRows));
  const window = list.slice(start, start + visibleRows);
  const nameWidth = Math.min(28, Math.max(10, ...list.map((k) => k.name.length)));

  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box flexDirection="column" width={listWidth} borderStyle="single" borderColor={s.focus === "list" ? "cyan" : "gray"} paddingX={1}>
        <Text color="gray">{`${list.length} skills · sort ${sortText(s.sort)} (o/O)${s.filter ? ` · filter "${s.filter}"` : ""}`}</Text>
        <Text color="gray">{`  ${"skill".padEnd(nameWidth)} ${"listing".padStart(6)} ${"body".padStart(6)}`}</Text>
        {window.map((k, i) => {
          const idx = start + i;
          const active = idx === s.selected;
          const warn = k.violations.length > 0;
          return (
            <Text key={k.name} inverse={active}>
              {`${active ? "▸" : " "} `}
              <Text {...(warn ? { color: "red" } : {})}>{k.name.padEnd(nameWidth).slice(0, nameWidth)}</Text>
              <Text color="gray">{` ${String(k.cost.descTokens).padStart(5)}t ${fmtK(k.cost.bodyTokens).padStart(5)}t`}</Text>
            </Text>
          );
        })}
      </Box>
      <Box flexDirection="column" flexGrow={1} borderStyle="single" borderColor={s.focus === "grid" ? "cyan" : "gray"} paddingX={1}>
        {sel ? <Detail s={s} skill={sel} /> : <Text color="gray">no skill matches</Text>}
      </Box>
    </Box>
  );
};

const Detail = ({ s, skill }: { s: State; skill: NonNullable<ReturnType<typeof selectedSkill>> }): React.ReactElement => {
  const agents = s.config.agents;
  return (
    <Box flexDirection="column">
      <Text bold>{skill.name} <Text color="gray">{skill.dir}</Text></Text>
      <Text wrap="wrap">{descriptionOf(skill) || <Text color="red">(no description)</Text>}</Text>
      <Text> </Text>
      <Text>
        <Text color="gray">listing </Text>{`${skill.cost.descTokens}t`}
        <Text color="gray">  body </Text>{`${fmtK(skill.cost.bodyTokens)}t / ${skill.cost.bodyLines}L`}
        <Text color="gray">  files </Text>{`${skill.cost.fileCount}`}
        <Text color="gray">  size </Text>{`${(skill.cost.totalBytes / 1024).toFixed(0)}K`}
        {skill.cost.descChars > 1536 ? <Text color="yellow">{"  ⚠ description over Claude's 1536-char cap"}</Text> : null}
        {skill.cost.bodyTokens > 5000 ? <Text color="yellow">{"  ⚠ body >5k tokens"}</Text> : null}
      </Text>
      {skill.violations.length > 0 ? <Text color="red">{`spec: ${skill.violations.map((v) => `${v.field} ${v.kind}`).join(", ")}`}</Text> : null}
      <Text> </Text>
      <Text bold>targets <Text color="gray">{s.focus === "grid" ? "(space toggles the highlighted cell)" : "(m to edit)"}</Text></Text>
      <Text>{"".padEnd(11)}{agents.map((a) => a.padEnd(9)).join("")}</Text>
      {s.config.hosts.map((h, hi) => (
        <Text key={h.id}>
          {h.id.padEnd(11)}
          {agents.map((a, ai) => {
            const enabled = agentsOn(s.config, h).some((x) => x.id === a);
            const desired = enabled && isDesired(s.config, skill.name, h.id, a);
            const g = enabled ? cellGlyph(s, skill.name, h.id, a, desired) : { glyph: "–", color: "gray" as const };
            const cursor = s.focus === "grid" && hi === s.grid.host && ai === s.grid.agent;
            return (
              <Text key={a} inverse={cursor} color={g.color}>{`${g.glyph}${desired ? "" : ""}`.padEnd(9)}</Text>
            );
          })}
        </Text>
      ))}
      <Text color="gray">✓ loaded  ◌ pending  ○ off  ✗ broken  ? unreachable · green on target · yellow pending/outside target</Text>
    </Box>
  );
};
