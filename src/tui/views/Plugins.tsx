import React from "react";
import { Box, Text } from "ink";
import type { PluginRow } from "../../core/pluginUpdate";
import { newestVersion } from "../../core/version";
import { type CellPlan, type PluginGridCell, type State, cellPlan, pluginGrid, pluginRowsOf, pluginUpdatable } from "../state";

/** What the list shows after the name: the version, or how many versions are active when they differ. */
const versionText = (row: PluginRow): string =>
  row.drift ? `${row.versions.length} versions` : (newestVersion(row.versions) ?? row.versions[0] ?? "off");

/** The desktop app's Plugins view: every plugin with its version on each host × agent; drift in red; `u` updates everywhere. */
export const PluginsView = ({ s, width, height }: { s: State; width: number; height: number }): React.ReactElement => {
  const rows = pluginRowsOf(s);
  const probing = s.config.hosts.some((h) => s.hosts[h.id]?.kind === "probing");
  const listWidth = Math.max(34, Math.floor(width * 0.42));
  // a row is "▸ " + name + " " + version; the border and paddingX take 4 more columns. The version column is as wide as
  // the longest version (Codex app plugins are 26.1027.51404) so none loses digits; the name keeps at least 10 columns.
  const ROW_CHROME = 4 + 2 + 1;
  const versionWidth = Math.min(listWidth - ROW_CHROME - 10, Math.max(8, ...rows.map((r) => versionText(r).length)));
  const nameWidth = Math.min(28, listWidth - ROW_CHROME - versionWidth, Math.max(10, ...rows.map((r) => r.name.length)));
  const visibleRows = Math.max(3, height - 3);
  const start = Math.max(0, Math.min(s.pluginSel - Math.floor(visibleRows / 2), rows.length - visibleRows));
  const sel = rows[s.pluginSel];
  const drifting = rows.filter((r) => r.drift).length;
  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box flexDirection="column" width={listWidth} flexShrink={0} borderStyle="single" borderColor={s.pluginFocus === "list" ? "cyan" : "gray"} paddingX={1}>
        <Text color="gray" wrap="truncate">{`${rows.length} plugins${drifting > 0 ? ` · ${drifting} drifting` : ""}${probing ? " · probing…" : ""}`}</Text>
        {rows.slice(start, start + visibleRows).map((r, i) => {
          const active = start + i === s.pluginSel;
          return (
            <Text key={r.name} inverse={active}>
              {`${active ? "▸" : " "} `}
              <Text {...(r.drift ? { color: "red" } : {})}>{r.name.padEnd(nameWidth).slice(0, nameWidth)}</Text>
              <Text color={r.drift ? "red" : "gray"}>{` ${versionText(r).slice(0, versionWidth).padStart(versionWidth)}`}</Text>
            </Text>
          );
        })}
        {rows.length === 0 ? <Text color="gray">{probing ? "probing hosts…" : "no plugins on the reachable hosts"}</Text> : null}
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden" borderStyle="single" borderColor={s.pluginFocus === "grid" ? "cyan" : "gray"} paddingX={1}>
        {sel ? <Detail s={s} row={sel} /> : <Text color="gray">no plugin selected</Text>}
      </Box>
    </Box>
  );
};

const PLAN_TEXT: Readonly<Record<CellPlan, string>> = { on: "✓ on", off: "○ off", absent: "· not installed", "will-enable": "◌ will enable", "will-disable": "◌ will disable" };
const PLAN_WIDTH = Math.max(...Object.values(PLAN_TEXT).map((t) => t.length)) + 2;
const PLAN_TONE: Readonly<Record<CellPlan, "green" | "gray" | "yellow">> = { on: "green", off: "gray", absent: "gray", "will-enable": "yellow", "will-disable": "yellow" };

const Detail = ({ s, row }: { s: State; row: PluginRow }): React.ReactElement => {
  const newest = newestVersion(row.versions);
  const updatable = pluginUpdatable(row);
  const asking = s.confirm.kind === "plugin-update" && s.confirm.plugin === row.name;
  const hosts = [...new Set(row.cells.filter((c) => c.enabled === "on").map((c) => c.host))];
  const grid: readonly PluginGridCell[] = pluginGrid(s, row);
  const cellW = Math.max(12, ...grid.map((c) => `${c.host}/${c.agent}`.length)) + 2;
  const versionColor = (v: string | null): "red" | "green" | "gray" => (v === null ? "gray" : row.drift && newest !== null && v !== newest ? "red" : "green");
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text bold>{row.name} <Text color="gray">{row.ids.join(", ")}</Text></Text>
      <Text>
        <Text color="gray">versions </Text>
        {row.versions.map((v, i) => (
          <Text key={v} color={versionColor(v)}>{`${i > 0 ? "  " : ""}${v}${v === newest && row.drift ? " (newest)" : ""}`}</Text>
        ))}
        {row.versions.length === 0 ? <Text color="gray">none enabled</Text> : null}
      </Text>
      <Text> </Text>
      {asking
        ? <Text color="yellow">{`update ${row.name} on ${hosts.join(", ")}? y = yes (backup first: ${s.config.backupBeforeApply ? "on" : "off"}), any other key = cancel`}</Text>
        : row.cells.length === 0
          ? <Text color="gray">not installed on any host yet: switch a cell on, then apply</Text>
          : updatable
            ? <Text color="gray">u  update on every host: refresh the marketplaces, then update the plugin</Text>
            : <Text color="gray">ships with an app (local marketplace): update the app with skm harness update, then reinstall</Text>}
      <Text> </Text>
      <Text bold>hosts × agents <Text color="gray">{s.pluginFocus === "grid" ? "(space toggles the highlighted cell · saved to config.yaml, runs on apply)" : "(m to switch cells)"}</Text></Text>
      {grid.map((c, i) => {
        const plan = cellPlan(c);
        const live = c.live.some ? c.live.value : undefined;
        const version = live?.version ?? null;
        const cursor = s.pluginFocus === "grid" && i === s.pluginCell;
        return (
          <Text key={`${c.host}/${c.agent}`} wrap="truncate">
            <Text inverse={cursor}>{`${c.host}/${c.agent}`.padEnd(cellW)}</Text>
            <Text color={PLAN_TONE[plan]}>{PLAN_TEXT[plan].padEnd(PLAN_WIDTH)}</Text>
            {version !== null ? <Text color={plan === "on" ? versionColor(version) : "gray"}>{version}</Text> : null}
            <Text color="gray">{live && live.skills.length > 0 ? `  ${live.skills.length} skill${live.skills.length === 1 ? "" : "s"}` : ""}</Text>
          </Text>
        );
      })}
      {grid.length === 0 ? <Text color="gray">no enabled host runs Claude or Codex</Text> : null}
    </Box>
  );
};
