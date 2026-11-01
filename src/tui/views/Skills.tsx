import React from "react";
import { Box, Text } from "ink";
import { isDesired } from "../../core/scope";
import { descriptionOf } from "../../core/skill";
import type { CoverageSummary } from "../../core/coverage";
import { agentById } from "../../core/agents";
import { agentsOn } from "../../shell/hosts";
import { type StateKind, originText, stateHint, stateLabel } from "../../core/upstream";
import { type Option, none, some } from "../../lib/result";
import { type State, type UpstreamOf, cellGlyph, selectedSkill, skillCoverage, sortText, upstreamFailures, upstreamOf, upstreamUpdatable, visibleSkills } from "../state";

const agentName = (id: string): string => { const a = agentById(id); return a.some ? a.value.name : id; };

/** The desktop app's coverage phrase in English, fitted to `width`: names when they fit, else a count; never wrapped. Pure. */
export const coverageText = (c: CoverageSummary, width: number): string => {
  const phrase = (prefix: string, xs: readonly string[], noun: string): string => {
    const named = `${prefix}${xs.join(", ")}`;
    return xs.length <= 2 && named.length <= width ? named : `${prefix}${xs.length} ${noun}`;
  };
  const text = ((): string => {
    switch (c.kind) {
      case "everywhere": return "Everywhere";
      case "nowhere": return "Nowhere";
      case "only-hosts": return phrase("Only ", c.hosts, "hosts");
      case "except-hosts": return phrase("All but ", c.hosts, "hosts");
      case "only-agents": return phrase("Only ", c.agents.map(agentName), "agents");
      case "except-agents": return phrase("All but ", c.agents.map(agentName), "agents");
      case "partial": return `${c.on} of ${c.total}`;
    }
  })();
  return text.slice(0, width);
};

type Tone = "green" | "cyan" | "yellow" | "red" | "gray";

/** The one-column mark a skills row carries for its upstream state; current shows nothing. Pure. */
export const upstreamMark = (k: StateKind): { readonly glyph: string; readonly color: Tone } => {
  switch (k) {
    case "current": return { glyph: " ", color: "gray" };
    case "behind": return { glyph: "↑", color: "cyan" };
    case "absent": return { glyph: "+", color: "cyan" };
    case "modified": return { glyph: "✎", color: "yellow" };
    case "unbased": return { glyph: "≠", color: "yellow" };
    case "gone": return { glyph: "✗", color: "red" };
  }
};

const stateTone = (k: StateKind): Tone => (k === "current" ? "green" : upstreamMark(k).color);

/** The list's first line: count, the upstream summary, filter and sort. Pure. */
export const listTitle = (s: State, count: number): string => {
  const updates = upstreamUpdatable(s).length;
  const failed = upstreamFailures(s);
  const upstream = s.config.upstreams.length === 0 ? ""
    : s.upstream.checking ? " · checking upstream…"
    : `${updates > 0 ? ` · ${updates} upstream update${updates === 1 ? "" : "s"} (U)` : ""}${failed.length > 0 ? ` · upstream check failed: ${failed.join(", ")}` : ""}`;
  return `${count} skills${upstream}${s.filter ? ` · filter "${s.filter}"` : ""} · sort ${sortText(s.sort)} (o/O)`;
};

/** The y/n prompt of a pending upstream update, worded like the plugin update's; none when nothing asks. Pure. */
export const upstreamPrompt = (s: State): Option<string> => {
  const c = s.confirm;
  if (c.kind !== "upstream-update") return none;
  const backup = `y = yes (backup first: ${s.config.backupBeforeApply ? "on" : "off"}), any other key = cancel`;
  const [one] = c.skills;
  const up = one !== undefined && c.skills.length === 1 ? upstreamOf(s, one) : none;
  const to = up.some ? ` with ${up.value.report.policy.name} ${up.value.skill.target.label}` : " with the upstream version";
  if (c.force) return some(`overwrite the edits in ${c.skills.join(", ")}${to}? ${backup}`);
  if (one !== undefined && c.skills.length === 1) return some(`update ${one}${up.some ? ` to ${up.value.skill.target.label} from ${up.value.report.policy.name}` : " from upstream"}? ${backup}`);
  return some(`update ${c.skills.length} skills from upstream (${c.skills.join(", ")})? ${backup}`);
};

const fmtK = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const SkillsView = ({ s, width, height }: { s: State; width: number; height: number }): React.ReactElement => {
  const list = visibleSkills(s);
  const sel = selectedSkill(s);
  const listWidth = Math.max(34, Math.floor(width * 0.5));
  // a row is "▸ " + name [+ " " + upstream mark] + " " + listing (7) + " " + body (7) [+ " " + coverage]; the border and paddingX take 4 more columns
  const marks = s.config.upstreams.length > 0;
  const LIST_CHROME = 4 + 2 + (marks ? 2 : 0) + 1 + 7 + 1 + 7;
  const COVERAGE_MIN = 10;
  const withCoverage = listWidth - LIST_CHROME - 1 - COVERAGE_MIN >= 10;
  const visibleRows = Math.max(3, height - 3);
  const start = Math.max(0, Math.min(s.selected - Math.floor(visibleRows / 2), list.length - visibleRows));
  const window = list.slice(start, start + visibleRows);
  const nameWidth = Math.min(28, listWidth - LIST_CHROME - (withCoverage ? 1 + COVERAGE_MIN : 0), Math.max(10, ...list.map((k) => k.name.length)));
  const coverageWidth = withCoverage ? Math.min(24, listWidth - LIST_CHROME - 1 - nameWidth) : 0;
  const title = listTitle(s, list.length);
  const prompt = upstreamPrompt(s);

  return (
    <Box flexDirection="row" flexGrow={1}>
      {/* flexShrink 0: Box defaults to flexShrink 1, and the detail panel's longest line would squeeze the list until its rows wrap */}
      <Box flexDirection="column" width={listWidth} flexShrink={0} borderStyle="single" borderColor={s.focus === "list" ? "cyan" : "gray"} paddingX={1}>
        <Text color="gray" wrap="truncate">{title}</Text>
        <Text color="gray">{`  ${"skill".padEnd(nameWidth)}${marks ? "  " : ""} ${"listing".padStart(7)} ${"body".padStart(7)}${withCoverage ? " enabled on" : ""}`}</Text>
        {window.map((k, i) => {
          const idx = start + i;
          const active = idx === s.selected;
          const warn = k.violations.length > 0;
          return (
            <Text key={k.name} inverse={active}>
              {`${active ? "▸" : " "} `}
              <Text {...(warn ? { color: "red" } : {})}>{k.name.padEnd(nameWidth).slice(0, nameWidth)}</Text>
              {marks ? <MarkCell s={s} skill={k.name} /> : null}
              <Text color="gray">{` ${String(k.cost.descTokens).padStart(6)}t ${fmtK(k.cost.bodyTokens).padStart(6)}t`}</Text>
              {withCoverage ? <CoverageCell s={s} skill={k.name} width={coverageWidth} /> : null}
            </Text>
          );
        })}
      </Box>
      {/* overflow hidden: a detail taller than the panel is cut at the border instead of drawing past it */}
      <Box flexDirection="column" flexGrow={1} overflow="hidden" borderStyle="single" borderColor={s.focus === "grid" ? "cyan" : "gray"} paddingX={1}>
        {prompt.some ? <Box flexShrink={0} marginBottom={1}><Text color="yellow" wrap="wrap">{prompt.value}</Text></Box> : null}
        {sel ? <Detail s={s} skill={sel} /> : <Text color="gray">no skill matches</Text>}
      </Box>
    </Box>
  );
};

const CoverageCell = ({ s, skill, width }: { s: State; skill: string; width: number }): React.ReactElement => {
  const c = skillCoverage(s, skill);
  return <Text {...(c.kind === "everywhere" ? { color: "green" } : c.kind === "nowhere" ? { color: "gray" } : {})}>{` ${coverageText(c, width)}`}</Text>;
};

const MarkCell = ({ s, skill }: { s: State; skill: string }): React.ReactElement => {
  const up = upstreamOf(s, skill);
  const m = up.some ? upstreamMark(up.value.skill.state.kind) : { glyph: " ", color: "gray" as const };
  return <Text color={m.color}>{` ${m.glyph}`}</Text>;
};

const CHANGES_SHOWN = 5;

/** The desktop app's upstream section: repo, store version → target, the commits in between, and what `u` does. */
const UpstreamBlock = ({ up }: { up: UpstreamOf }): React.ReactElement => {
  const { report, skill } = up;
  const k = skill.state.kind;
  const from = skill.base.some ? skill.base.value.label : "unknown version";
  const version = k === "current" || from === skill.target.label ? skill.target.label : `${from} → ${skill.target.label}`;
  // what the state means (when it needs saying), then what `u` does
  const notes = ((): readonly string[] => {
    switch (k) {
      case "behind":
      case "absent":
        return ["u  update from upstream (backup first)"];
      case "modified":
        return ["edited since skm wrote it", "u  overwrite the edits with the upstream version (backup first)"];
      case "unbased":
        return [
          report.policy.kind === "git" ? "skm does not know which version this copy is; `skm upstream adopt` finds it" : "skm does not know which version this copy is",
          "u  overwrite it with the upstream version (backup first)",
        ];
      case "current":
        return [];
      case "gone":
        return [stateHint.gone];
    }
  })();
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text> </Text>
      <Text wrap="truncate"><Text bold>upstream </Text>{report.policy.name} <Text color="gray">{originText(report.policy)}</Text></Text>
      <Text wrap="truncate">
        {`  ${version}  `}<Text color={stateTone(k)}>{stateLabel[k]}</Text>
        {skill.changes.length > 0 ? <Text color="gray">{` · ${skill.changes.length} commit${skill.changes.length === 1 ? "" : "s"}`}</Text> : null}
      </Text>
      {skill.changes.slice(0, CHANGES_SHOWN).map((c) => (
        <Text key={c.commit} wrap="truncate"><Text color="gray">{`  ${c.commit} ${c.date} `}</Text>{c.subject}</Text>
      ))}
      {skill.changes.length > CHANGES_SHOWN ? <Text color="gray">{`  … ${skill.changes.length - CHANGES_SHOWN} more (skm upstream --log)`}</Text> : null}
      {notes.map((n) => (
        <Box key={n} paddingLeft={2} flexShrink={0}><Text color="gray" wrap="wrap">{n}</Text></Box>
      ))}
    </Box>
  );
};

const Detail = ({ s, skill }: { s: State; skill: NonNullable<ReturnType<typeof selectedSkill>> }): React.ReactElement => {
  const agents = s.config.agents;
  const up = upstreamOf(s, skill.name);
  // flexShrink 0: when the detail is taller than its panel, Yoga would otherwise shrink each Text's height and draw the
  // next one over its last lines (a blank line overwrote the first letter of a wrapped description)
  return (
    <Box flexDirection="column" flexShrink={0}>
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
      {up.some ? <UpstreamBlock up={up.value} /> : null}
      <Text> </Text>
      <Text bold>targets <Text color="gray">{s.focus === "grid" ? "(space toggles the highlighted cell)" : "(m to edit)"}</Text></Text>
      {/* grid rows are cut, not wrapped, when the panel is narrower than the grid: a wrapped row breaks the columns */}
      <Text wrap="truncate">{"".padEnd(11)}{agents.map((a, i) => (i < agents.length - 1 ? a.padEnd(9) : a)).join("")}</Text>
      {s.config.hosts.map((h, hi) => (
        <Text key={h.id} wrap="truncate">
          {h.id.padEnd(11)}
          {agents.map((a, ai) => {
            const enabled = agentsOn(s.config, h).some((x) => x.id === a);
            const desired = enabled && isDesired(s.config, skill.name, h.id, a);
            const g = enabled ? cellGlyph(s, skill.name, h.id, a, desired) : { glyph: "–", color: "gray" as const };
            const cursor = s.focus === "grid" && hi === s.grid.host && ai === s.grid.agent;
            return (
              <Text key={a} inverse={cursor} color={g.color}>{ai < agents.length - 1 ? g.glyph.padEnd(9) : g.glyph}</Text>
            );
          })}
        </Text>
      ))}
      <Text color="gray">✓ loaded  ◌ pending  ○ off  ✗ broken  ? unreachable · green on target · yellow pending/outside target</Text>
    </Box>
  );
};
