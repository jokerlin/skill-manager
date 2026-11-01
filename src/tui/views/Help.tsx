import React from "react";
import { Box, Text } from "ink";

const rows: readonly (readonly [string, string])[] = [
  ["1-5 / Tab", "switch view (skills · plugins · hosts · changes · help); the changes tab shows how many are pending"],
  ["j k ↑ ↓ g G", "move in the skill or plugin list (PgUp/PgDn ±10 for skills)"],
  ["/", "filter by name or description (Enter/Esc to finish, Esc again clears)"],
  ["o", "sort key: name → listing tokens → body tokens (costs start descending)"],
  ["O", "flip the sort direction"],
  ["m", "edit targets grid: h j k l move, space toggles host×agent for the skill (saved to config.yaml)"],
  ["u (skills)", "update the selected skill from its upstream repo; an edited copy is overwritten only after its own confirm (backup first)"],
  ["U (skills)", "update every skill whose upstream has a newer version (asks first)"],
  ["m (plugins)", "edit the plugin's hosts × agents: j k move, space switches the cell on or off (saved to config.yaml; apply enables or disables it there)"],
  ["u (plugins)", "update the selected plugin on every host: refresh marketplaces, backup, update (asks first)"],
  ["H (hosts)", "update every agent CLI (claude update, codex update, …) on every reachable host (asks first); desktop apps: skm harness update --agent <app>"],
  ["f (hosts)", "list every finding (same skill twice, shadowed copies, stale plugin caches, …) or one summary line per host"],
  ["s / Enter (changes)", "apply the pending changes: confirm → backup → rsync → link on every reachable host"],
  ["c (in confirm)", "toggle replace-conflicts: move real dirs / foreign links into the backup and link the store"],
  ["b", "backup only (store + agent dirs on every reachable host; prints the restore command)"],
  ["r", "re-probe all hosts, and check agent CLI versions and upstreams again"],
  ["q", "quit"],
];

export const HelpView = (): React.ReactElement => (
  <Box flexDirection="column" paddingX={1}>
    {rows.map(([k, v]) => (
      <Text key={k}><Text bold color="cyan">{k.padEnd(20)}</Text>{v}</Text>
    ))}
    <Text> </Text>
    <Text color="gray">store: one skill per directory under ~/.skm/skills. Agent dirs hold only symlinks into it. Remote hosts get an rsync mirror of the store, then the same symlinks.</Text>
    <Text color="gray">cost columns: listing = description tokens (loaded every turn); body = SKILL.md tokens (loaded when the skill activates).</Text>
    <Text color="gray">upstream marks: ↑ update available  + not in store  ✎ edited locally  ≠ unknown base  ✗ gone upstream (from upstreams: in config.yaml; r re-checks)</Text>
    <Text color="gray">enabled on: where the skill is wanted after the next apply, in the desktop app's words ("Everywhere", "Only mini", "All but Codex", "7 of 12").</Text>
  </Box>
);
