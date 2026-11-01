import React from "react";
import { Box, Text } from "ink";
import type { PluginRow } from "../../core/pluginUpdate";
import { newestVersion } from "../../core/version";
import { type State, pluginRowsOf, pluginUpdatable } from "../state";

/** What the list shows after the name: the version, or how many versions are active when they differ. */
const versionText = (row: PluginRow): string =>
  row.drift ? `${row.versions.length} versions` : (newestVersion(row.versions) ?? row.versions[0] ?? "off");

const VERSION_W = 12;

/** The desktop app's Plugins view: every plugin with its version on each host × agent; drift in red; `u` updates everywhere. */
export const PluginsView = ({ s, width, height }: { s: State; width: number; height: number }): React.ReactElement => {
  const rows = pluginRowsOf(s);
  const probing = s.config.hosts.some((h) => s.hosts[h.id]?.kind === "probing");
  const listWidth = Math.max(34, Math.floor(width * 0.42));
  // a row is "▸ " + name + " " + version (12); the border and paddingX take 4 more columns
  const nameWidth = Math.min(28, listWidth - (4 + 2 + 1 + VERSION_W), Math.max(10, ...rows.map((r) => r.name.length)));
  const visibleRows = Math.max(3, height - 3);
  const start = Math.max(0, Math.min(s.pluginSel - Math.floor(visibleRows / 2), rows.length - visibleRows));
  const sel = rows[s.pluginSel];
  const drifting = rows.filter((r) => r.drift).length;
  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box flexDirection="column" width={listWidth} flexShrink={0} borderStyle="single" borderColor="cyan" paddingX={1}>
        <Text color="gray" wrap="truncate">{`${rows.length} plugins${drifting > 0 ? ` · ${drifting} drifting` : ""}${probing ? " · probing…" : ""}`}</Text>
        {rows.slice(start, start + visibleRows).map((r, i) => {
          const active = start + i === s.pluginSel;
          return (
            <Text key={r.name} inverse={active}>
              {`${active ? "▸" : " "} `}
              <Text {...(r.drift ? { color: "red" } : {})}>{r.name.padEnd(nameWidth).slice(0, nameWidth)}</Text>
              <Text color={r.drift ? "red" : "gray"}>{` ${versionText(r).padStart(VERSION_W).slice(-VERSION_W)}`}</Text>
            </Text>
          );
        })}
        {rows.length === 0 ? <Text color="gray">{probing ? "probing hosts…" : "no plugins on the reachable hosts"}</Text> : null}
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden" borderStyle="single" borderColor="gray" paddingX={1}>
        {sel ? <Detail s={s} row={sel} /> : <Text color="gray">no plugin selected</Text>}
      </Box>
    </Box>
  );
};

const Detail = ({ s, row }: { s: State; row: PluginRow }): React.ReactElement => {
  const newest = newestVersion(row.versions);
  const updatable = pluginUpdatable(row);
  const asking = s.confirm.kind === "plugin-update" && s.confirm.plugin === row.name;
  const hosts = [...new Set(row.cells.filter((c) => c.enabled === "on").map((c) => c.host))];
  const cellW = Math.max(12, ...row.cells.map((c) => `${c.host}/${c.agent}`.length)) + 2;
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
        : updatable
          ? <Text color="gray">u  update on every host: refresh the marketplaces, then update the plugin</Text>
          : <Text color="gray">ships with an app (local marketplace): update the app with skm harness update, then reinstall</Text>}
      <Text> </Text>
      <Text bold>hosts × agents</Text>
      {row.cells.map((c) => (
        <Text key={`${c.host}/${c.agent}`} wrap="truncate">
          {`${c.host}/${c.agent}`.padEnd(cellW)}
          {c.enabled === "off"
            ? <Text color="gray">{`off${c.version === null ? "" : ` ${c.version}`}`}</Text>
            : <Text color={versionColor(c.version)}>{c.version ?? "not installed"}</Text>}
          <Text color="gray">{c.skills.length > 0 ? `  ${c.skills.length} skill${c.skills.length === 1 ? "" : "s"}` : ""}</Text>
        </Text>
      ))}
    </Box>
  );
};
