import { shQuote } from "../lib/sh";
import type { Op } from "./plan";

/**
 * Generators for the POSIX sh scripts we pipe into `sh -s` on a host (local or over ssh).
 * Every path is home-relative (`~/...`) so the same script works on any host.
 */

/** `~/x/y` → "$HOME"/'x/y'  (sh-safe, expands on the target host). Absolute paths are quoted verbatim. */
export const shPath = (p: string): string =>
  p === "~" ? `"$HOME"` : p.startsWith("~/") ? `"$HOME"/${shQuote(p.slice(2))}` : shQuote(p);

const HASH_FN = `skm_hash() { if command -v sha1sum >/dev/null 2>&1; then sha1sum "$1" | cut -d' ' -f1; elif command -v shasum >/dev/null 2>&1; then shasum "$1" | cut -d' ' -f1; else cksum "$1" | cut -d' ' -f1; fi; }`;

export type ProbeArgs = {
  readonly skm: string;                                          // e.g. ~/.skm
  readonly agentDirs: Readonly<Record<string, string>>;          // agent → ~/.claude/skills
  readonly alsoReads: Readonly<Record<string, readonly string[]>>; // agent → [~/.codex/skills]
};

/** Emits TSV: meta/store/dir/entry/also lines (see inventory.parseProbeOutput). */
export const probeScript = (a: ProbeArgs): string => {
  const store = `${a.skm}/skills`;
  const lines = [
    "#!/bin/sh",
    "set -u",
    HASH_FN,
    `printf 'meta\\thome\\t%s\\n' "$HOME"`,
    `STORE=${shPath(store)}`,
    `if [ -d "$STORE" ]; then printf 'meta\\tstore\\t%s\\n' "$(cd -P "$STORE" && pwd -P)"; fi`,
    `if [ -d "$STORE" ]; then for d in "$STORE"/*/; do [ -d "$d" ] || continue; n=$(basename "$d"); h=""; [ -f "$d/SKILL.md" ] && h=$(skm_hash "$d/SKILL.md"); printf 'store\\t%s\\t%s\\n' "$n" "$h"; done; fi`,
    // probe_dir TAG AGENT DIR
    `probe_dir() { tag=$1; agent=$2; dir=$3`,
    `  if [ ! -d "$dir" ]; then [ "$tag" = entry ] && printf 'dir\\t%s\\t0\\n' "$agent"; return 0; fi`,
    `  [ "$tag" = entry ] && printf 'dir\\t%s\\t1\\n' "$agent"`,
    `  for p in "$dir"/* "$dir"/.[!.]*; do`,
    `    [ -e "$p" ] || [ -L "$p" ] || continue`,
    `    n=$(basename "$p")`,
    `    if [ -L "$p" ]; then raw=$(readlink "$p"); case "$raw" in /*) ;; *) raw="$dir/$raw";; esac`,
    `      if [ -d "$p" ]; then t=$(cd -P "$p" 2>/dev/null && pwd -P); printf '%s\\t%s\\t%s\\tlink\\t%s\\t%s\\n' "$tag" "$agent" "$n" "$t" "$raw"`,
    `      elif [ -e "$p" ]; then printf '%s\\t%s\\t%s\\tlink\\t%s\\t%s\\n' "$tag" "$agent" "$n" "$raw" "$raw"`,
    `      else printf '%s\\t%s\\t%s\\tbrokenlink\\t%s\\t%s\\n' "$tag" "$agent" "$n" "$raw" "$raw"; fi`,
    `    elif [ -d "$p" ]; then printf '%s\\t%s\\t%s\\tdir\\t\\n' "$tag" "$agent" "$n"`,
    `    else printf '%s\\t%s\\t%s\\tfile\\t\\n' "$tag" "$agent" "$n"; fi`,
    `  done; return 0; }`,
    ...Object.entries(a.agentDirs).map(([agent, dir]) => `probe_dir entry ${shQuote(agent)} ${shPath(dir)}`),
    ...Object.entries(a.alsoReads).flatMap(([agent, dirs]) => dirs.map((dir) => `probe_dir also ${shQuote(agent)} ${shPath(dir)}`)),
    "exit 0",
  ];
  return lines.join("\n") + "\n";
};

export type ApplyArgs = {
  readonly skm: string;
  readonly ops: readonly Op[];
  readonly agentDirs: Readonly<Record<string, string>>;   // agent → ~/.claude/skills
  /** when set, conflicts are moved here (home-relative dir) and then linked */
  readonly replaceConflictsInto: string | undefined;
};

const target = (a: ApplyArgs, agent: string, skill: string): string => `${a.agentDirs[agent] ?? `~/.unknown/${agent}`}/${skill}`;

const opLine = (a: ApplyArgs, o: Op): string[] => {
  switch (o.op) {
    case "mkdir":
      return [`mkdir -p ${shPath(o.path)} && echo ${shQuote(`mkdir ${o.path}`)}`];
    case "rsync-skill":
      return []; // rsync runs from the hub, not inside this script
    case "unlink": {
      const p = shPath(target(a, o.agent, o.skill));
      return [`if [ -L ${p} ]; then rm ${p} && echo ${shQuote(`unlink ${o.agent}/${o.skill}`)}; fi`];
    }
    case "link": {
      const p = shPath(target(a, o.agent, o.skill));
      return [
        `if [ -d ${p} ] && [ ! -L ${p} ]; then echo ${shQuote(`skip ${o.agent}/${o.skill}: real directory`)} >&2; else ln -sfn "$STORE"/${shQuote(o.skill)} ${p} && echo ${shQuote(`link ${o.agent}/${o.skill}`)}; fi`,
      ];
    }
    case "conflict": {
      if (a.replaceConflictsInto === undefined) return [`echo ${shQuote(`conflict ${o.agent}/${o.skill} (${o.entry.kind}) left untouched`)}`];
      const p = shPath(target(a, o.agent, o.skill));
      const dest = shPath(`${a.replaceConflictsInto}/${o.agent}__${o.skill}`);
      return [
        `mkdir -p ${shPath(a.replaceConflictsInto)} && mv ${p} ${dest} && ln -sfn "$STORE"/${shQuote(o.skill)} ${p} && echo ${shQuote(`replace ${o.agent}/${o.skill} (moved to ${a.replaceConflictsInto})`)}`,
      ];
    }
    case "remote-only":
      return [];
  }
};

export const applyScript = (a: ApplyArgs): string =>
  ["#!/bin/sh", "set -eu", `STORE=${shPath(`${a.skm}/skills`)}`, `mkdir -p "$STORE"`, ...a.ops.flatMap((o) => opLine(a, o)), "exit 0"].join("\n") + "\n";

export type BackupArgs = { readonly skm: string; readonly ts: string; readonly paths: readonly string[] /* ~/... */ };

const homeRel = (p: string): string => (p.startsWith("~/") ? p.slice(2) : p);

/** Snapshot the given home-relative paths into <skm>/backups/<ts>/ with a restore.sh. Prints the backup dir. */
export const backupScript = (a: BackupArgs): string => {
  const dir = `${a.skm}/backups/${a.ts}`;
  return [
    "#!/bin/sh",
    "set -eu",
    `B=${shPath(dir)}`,
    `mkdir -p "$B"`,
    `cd "$HOME"`,
    `: > "$B/manifest.txt"`,
    `: > "$B/present.txt"`,
    ...a.paths.map(homeRel).map(
      (p) =>
        `if [ -e ${shQuote(p)} ] || [ -L ${shQuote(p)} ]; then printf 'present\\t%s\\n' ${shQuote(p)} >> "$B/manifest.txt"; printf '%s\\n' ${shQuote(p)} >> "$B/present.txt"; else printf 'absent\\t%s\\n' ${shQuote(p)} >> "$B/manifest.txt"; fi`,
    ),
    `if [ -s "$B/present.txt" ]; then tar czf "$B/snapshot.tar.gz" -T "$B/present.txt"; else tar czf "$B/snapshot.tar.gz" -T /dev/null; fi`,
    `cat > "$B/restore.sh" <<'RESTORE'`,
    restoreScriptText(),
    `RESTORE`,
    `chmod +x "$B/restore.sh"`,
    `printf 'backup\\t%s\\n' "$B"`,
    "exit 0",
  ].join("\n") + "\n";
};

/** Self-contained restore.sh: removes every manifest path (present or absent) then extracts the snapshot. */
export const restoreScriptText = (): string =>
  [
    "#!/bin/sh",
    "# skm restore: return the paths in manifest.txt to the state captured in snapshot.tar.gz",
    "set -eu",
    `B="$(cd "$(dirname "$0")" && pwd)"`,
    `cd "$HOME"`,
    `while IFS="$(printf '\\t')" read -r state p; do [ -n "$p" ] || continue; case "$p" in /*|..*) echo "refusing unsafe path: $p" >&2; exit 1;; esac; rm -rf "$p"; done < "$B/manifest.txt"`,
    `tar xzf "$B/snapshot.tar.gz"`,
    `echo "restored from $B:"; cat "$B/manifest.txt"`,
  ].join("\n");

/** `skm backups` listing helper: prints one line per backup dir with its manifest summary. */
export const listBackupsScript = (skm: string): string =>
  [
    "#!/bin/sh",
    `D=${shPath(`${skm}/backups`)}`,
    `[ -d "$D" ] || exit 0`,
    `for b in "$D"/*/; do [ -f "$b/manifest.txt" ] || continue; printf '%s\\t%s\\n' "$(basename "$b")" "$(grep -c present "$b/manifest.txt" || true)"; done`,
    "exit 0",
  ].join("\n") + "\n";
