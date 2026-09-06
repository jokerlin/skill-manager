import React from "react";
import { Box, Text } from "ink";

const rows: readonly (readonly [string, string])[] = [
  ["1-5 / Tab", "switch view (skills · hosts · sync · insights · help)"],
  ["j k ↑ ↓ g G", "move in the skill list (PgUp/PgDn ±10)"],
  ["/", "filter by name or description (Enter/Esc to finish, Esc again clears)"],
  ["o", "sort key: name → listing tokens → body tokens (costs start descending)"],
  ["O", "flip the sort direction"],
  ["m", "edit targets grid: h j k l move, space toggles host×agent for the skill (saved to config.yaml)"],
  ["s", "plan → confirm → backup → rsync → link on every reachable host"],
  ["c (in confirm)", "toggle replace-conflicts: move real dirs / foreign links into the backup and link the store"],
  ["b", "backup only (store + agent dirs on every reachable host; prints the restore command)"],
  ["e", "LLM evaluation of the visible skills via claude -p / codex exec (config: eval.agent)"],
  ["r", "re-probe all hosts"],
  ["q", "quit"],
];

export const HelpView = (): React.ReactElement => (
  <Box flexDirection="column" paddingX={1}>
    {rows.map(([k, v]) => (
      <Text key={k}><Text bold color="cyan">{k.padEnd(16)}</Text>{v}</Text>
    ))}
    <Text> </Text>
    <Text color="gray">store: one skill per directory under ~/.skm/skills. Agent dirs hold only symlinks into it. Remote hosts get an rsync mirror of the store, then the same symlinks.</Text>
    <Text color="gray">cost columns: listing = description chars (loaded every turn); body = SKILL.md tokens (loaded when the skill activates).</Text>
  </Box>
);
