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
  readonly pluginCaches?: Readonly<Record<string, string>>;      // agent → ~/.claude/plugins/cache
  readonly builtinDirs?: Readonly<Record<string, string>>;       // agent → ~/.codex/skills/.system
  readonly files?: Readonly<Record<string, string>>;             // id → ~/path, shipped back base64
  readonly tools?: readonly string[];                            // commands to locate on the host
};

/** Extra PATH entries so `claude`/`codex`/`acme` resolve under a non-login `sh -s`. Also used by the command phase of sync. */
export const HOST_PATH = `PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH`;

/** Files every probe brings back (home-relative). */
export const PROBE_FILES: Readonly<Record<string, string>> = {
  "claude-settings": "~/.claude/settings.json",
  "claude-installed": "~/.claude/plugins/installed_plugins.json",
  "claude-marketplaces": "~/.claude/plugins/known_marketplaces.json",
  "codex-config": "~/.codex/config.toml",
  "codex-models": "~/.codex/models_cache.json",
  "acme-lock": "~/.local/share/acme/data/skill-lock.json",
  "agents-lock": "~/.agents/.skill-lock.json",
};

export const PROBE_TOOLS: readonly string[] = ["claude", "codex", "acme"];

/**
 * Emits TSV (see inventory.parseProbeOutput):
 *   meta/store/dir/entry/also (v1, entry/also now end with the SKILL.md hash)
 *   tool/file/pcache/pskill/builtin/md/hidden (v2). `md` carries each distinct SKILL.md once, base64.
 */
export const probeScript = (a: ProbeArgs): string => {
  const store = `${a.skm}/skills`;
  const lines = [
    "#!/bin/sh",
    "set -u",
    HOST_PATH,
    HASH_FN,
    `SEEN=" "; MD_HASH=""`,
    // emit_md FILE: prints the md line once per hash, leaves the hash in MD_HASH ("" when FILE is missing)
    `emit_md() { MD_HASH=""; [ -f "$1" ] || return 0; MD_HASH=$(skm_hash "$1"); case "$SEEN" in *" $MD_HASH "*) ;; *) SEEN="$SEEN$MD_HASH "; printf 'md\\t%s\\t%s\\t%s\\n' "$MD_HASH" "$(wc -c < "$1" | tr -d ' ')" "$(base64 < "$1" | tr -d '\\n')";; esac; return 0; }`,
    `emit_file() { [ -f "$2" ] || return 0; printf 'file\\t%s\\t%s\\n' "$1" "$(base64 < "$2" | tr -d '\\n')"; }`,
    // emit_hidden AGENT SKILL_DIR: Codex keeps a skill out of the model-visible catalog when agents/openai.yaml sets policy.allow_implicit_invocation: false
    `emit_hidden() { [ -f "$2/agents/openai.yaml" ] || return 0; grep -Eqs '^[[:space:]]*allow_implicit_invocation:[[:space:]]*false' "$2/agents/openai.yaml" && printf 'hidden\\t%s\\t%s\\n' "$1" "$2"; return 0; }`,
    `printf 'meta\\thome\\t%s\\n' "$HOME"`,
    `STORE=${shPath(store)}`,
    `if [ -d "$STORE" ]; then printf 'meta\\tstore\\t%s\\n' "$(cd -P "$STORE" && pwd -P)"; fi`,
    `if [ -d "$STORE" ]; then for d in "$STORE"/*/; do [ -d "$d" ] || continue; n=$(basename "$d"); h=""; [ -f "$d/SKILL.md" ] && h=$(skm_hash "$d/SKILL.md"); printf 'store\\t%s\\t%s\\n' "$n" "$h"; done; fi`,
    // probe_dir TAG AGENT DIR  (dot entries skipped: .DS_Store, .system, …)
    `probe_dir() { tag=$1; agent=$2; dir=$3`,
    `  if [ ! -d "$dir" ]; then [ "$tag" = entry ] && printf 'dir\\t%s\\t0\\n' "$agent"; return 0; fi`,
    `  [ "$tag" = entry ] && printf 'dir\\t%s\\t1\\n' "$agent"`,
    `  for p in "$dir"/*; do`,
    `    [ -e "$p" ] || [ -L "$p" ] || continue`,
    `    n=$(basename "$p")`,
    `    if [ -L "$p" ]; then raw=$(readlink "$p"); case "$raw" in /*) ;; *) raw="$dir/$raw";; esac`,
    `      if [ -d "$p" ]; then t=$(cd -P "$p" 2>/dev/null && pwd -P); emit_md "$p/SKILL.md"; emit_hidden "$agent" "$p"; printf '%s\\t%s\\t%s\\tlink\\t%s\\t%s\\t%s\\t%s\\n' "$tag" "$agent" "$n" "$t" "$raw" "$MD_HASH" "$dir"`,
    `      elif [ -e "$p" ]; then printf '%s\\t%s\\t%s\\tlink\\t%s\\t%s\\t\\t%s\\n' "$tag" "$agent" "$n" "$raw" "$raw" "$dir"`,
    `      else printf '%s\\t%s\\t%s\\tbrokenlink\\t%s\\t%s\\t\\t%s\\n' "$tag" "$agent" "$n" "$raw" "$raw" "$dir"; fi`,
    `    elif [ -d "$p" ]; then emit_md "$p/SKILL.md"; emit_hidden "$agent" "$p"; printf '%s\\t%s\\t%s\\tdir\\t\\t\\t%s\\t%s\\n' "$tag" "$agent" "$n" "$MD_HASH" "$dir"`,
    `    else printf '%s\\t%s\\t%s\\tfile\\t\\t\\t\\t%s\\n' "$tag" "$agent" "$n" "$dir"; fi`,
    `  done; return 0; }`,
    // probe_plugins AGENT CACHE_ROOT: every <mk>/<plugin>/<version>/ dir and its skills/*/SKILL.md
    `probe_plugins() { agent=$1; root=$2; [ -d "$root" ] || return 0`,
    `  for mk in "$root"/*/; do [ -d "$mk" ] || continue; m=$(basename "$mk")`,
    `    for pl in "$mk"*/; do [ -d "$pl" ] || continue; pn=$(basename "$pl")`,
    `      for vd in "$pl"*/; do [ -d "$vd" ] || continue; v=$(basename "$vd"); d=\${vd%/}`,
    `        printf 'pcache\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$agent" "$m" "$pn" "$v" "$d"`,
    `        for sk in "$d"/skills/*/; do [ -f "$sk/SKILL.md" ] || continue; sn=$(basename "$sk"); emit_md "$sk/SKILL.md"; emit_hidden "$agent" "\${sk%/}"; printf 'pskill\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$agent" "$m" "$pn" "$v" "$sn" "\${sk%/}" "$MD_HASH"; done`,
    `      done; done; done; return 0; }`,
    `probe_builtins() { agent=$1; dir=$2; [ -d "$dir" ] || return 0; for sk in "$dir"/*/; do [ -f "$sk/SKILL.md" ] || continue; sn=$(basename "$sk"); emit_md "$sk/SKILL.md"; emit_hidden "$agent" "\${sk%/}"; printf 'builtin\\t%s\\t%s\\t%s\\t%s\\n' "$agent" "$sn" "\${sk%/}" "$MD_HASH"; done; return 0; }`,
    ...Object.entries(a.agentDirs).map(([agent, dir]) => `probe_dir entry ${shQuote(agent)} ${shPath(dir)}`),
    ...Object.entries(a.alsoReads).flatMap(([agent, dirs]) => dirs.map((dir) => `probe_dir also ${shQuote(agent)} ${shPath(dir)}`)),
    ...Object.entries(a.pluginCaches ?? {}).map(([agent, dir]) => `probe_plugins ${shQuote(agent)} ${shPath(dir)}`),
    ...Object.entries(a.builtinDirs ?? {}).map(([agent, dir]) => `probe_builtins ${shQuote(agent)} ${shPath(dir)}`),
    ...(a.tools ?? []).map((t) => `p=$(command -v ${shQuote(t)} 2>/dev/null || true); printf 'tool\\t%s\\t%s\\n' ${shQuote(t)} "\${p:--}"`),
    ...Object.entries(a.files ?? {}).map(([id, p]) => `emit_file ${shQuote(id)} ${shPath(p)}`),
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
    case "blocked":
      return [];
    case "marketplace-add":
    case "plugin-install":
    case "plugin-enable":
    case "plugin-disable":
    case "owned-ensure":
      return []; // command ops run in commandsScript, after apply.sh
  }
};

export const applyScript = (a: ApplyArgs): string =>
  ["#!/bin/sh", "set -eu", `STORE=${shPath(`${a.skm}/skills`)}`, `mkdir -p "$STORE"`, ...a.ops.flatMap((o) => opLine(a, o)), "exit 0"].join("\n") + "\n";

/** Label used for a command op in the sync report. */
export const commandLabel = (o: Op): string => {
  switch (o.op) {
    case "marketplace-add":
      return `${o.agent}: marketplace add ${o.marketplace}`;
    case "plugin-install":
      return `${o.agent}: plugin install ${o.plugin}`;
    case "plugin-enable":
      return `${o.agent}: plugin enable ${o.plugin}`;
    case "plugin-disable":
      return `${o.agent}: plugin disable ${o.plugin}`;
    case "owned-ensure":
      return `${o.tool}: ensure ${o.skill}`;
    case "mkdir":
    case "rsync-skill":
    case "link":
    case "unlink":
    case "conflict":
    case "remote-only":
    case "blocked":
      return opTextFallback(o);
  }
};

const opTextFallback = (o: Op): string => o.op;

/** The argv (already sh-quoted) that performs a command op on the host, or undefined for non-command ops. */
const commandArgv = (o: Op): string | undefined => {
  switch (o.op) {
    case "marketplace-add":
      return o.agent === "claude" ? `claude plugin marketplace add ${shQuote(o.source)}` : o.agent === "codex" ? `codex plugin marketplace add ${shQuote(o.source)}` : undefined;
    case "plugin-install":
      return o.agent === "claude" ? `claude plugin install ${shQuote(o.plugin)} --scope user` : o.agent === "codex" ? `codex plugin add ${shQuote(o.plugin)}` : undefined;
    case "plugin-enable":
      return o.agent === "claude" ? `claude plugin enable ${shQuote(o.plugin)}` : o.agent === "codex" ? `codex_set ${shQuote(o.plugin)} true` : undefined;
    case "plugin-disable":
      return o.agent === "claude" ? `claude plugin disable ${shQuote(o.plugin)}` : o.agent === "codex" ? `codex_set ${shQuote(o.plugin)} false` : undefined;
    case "owned-ensure":
      return `sh -c ${shQuote(o.command)}`;
    case "mkdir":
    case "rsync-skill":
    case "link":
    case "unlink":
    case "conflict":
    case "remote-only":
    case "blocked":
      return undefined;
  }
};

/** Shell function that flips `enabled` in ~/.codex/config.toml for one [plugins."id"] table (appends the table when absent). */
export const CODEX_SET_FN = [
  `codex_set() { id=$1; val=$2; f="$HOME/.codex/config.toml"; [ -f "$f" ] || : > "$f"; hdr="[plugins.\\"$id\\"]"`,
  `  if grep -Fxq "$hdr" "$f"; then`,
  `    awk -v hdr="$hdr" -v val="$val" '$0 == hdr { print; intable = 1; done = 0; held = ""; next } intable && /^[ \\t]*$/ { held = held $0 "\\n"; next } intable && /^[ \\t]*\\[/ { if (!done) { print "enabled = " val; done = 1 }; printf "%s", held; held = ""; intable = 0 } intable && /^[ \\t]*enabled[ \\t]*=/ { printf "%s", held; held = ""; if (!done) { print "enabled = " val; done = 1 }; next } intable { printf "%s", held; held = "" } { print } END { if (intable && !done) print "enabled = " val; if (intable) printf "%s", held }' "$f" > "$f.skm.tmp" && mv "$f.skm.tmp" "$f"`,
  `  else printf '\\n%s\\nenabled = %s\\n' "$hdr" "$val" >> "$f"; fi; }`,
].join("\n");

/**
 * Runs every command op through the owning CLI on the host. Each op prints `ok<TAB>label` or
 * `fail<TAB>label<TAB>last lines`; one failure never stops the others. stdin is /dev/null so CLIs cannot eat the script.
 */
export const commandsScript = (ops: readonly Op[]): string =>
  [
    "#!/bin/sh",
    "set -u",
    HOST_PATH,
    CODEX_SET_FN,
    `TMP=$(mktemp)`,
    `run() { label=$1; shift; if "$@" </dev/null >"$TMP" 2>&1; then printf 'ok\\t%s\\n' "$label"; else printf 'fail\\t%s\\t%s\\n' "$label" "$(tail -n 3 "$TMP" | tr '\\n\\t' '  ')"; fi; }`,
    ...ops.flatMap((o) => { const argv = commandArgv(o); return argv === undefined ? [] : [`run ${shQuote(commandLabel(o))} ${argv}`]; }),
    `rm -f "$TMP"`,
    "exit 0",
  ].join("\n") + "\n";

export type CommandResult = { readonly label: string; readonly ok: boolean; readonly detail: string };

/** Parse commandsScript stdout. Pure. */
export const parseCommandOutput = (text: string): CommandResult[] =>
  text.split("\n").filter((l) => l.startsWith("ok\t") || l.startsWith("fail\t")).map((l) => {
    const [status, label = "", detail = ""] = l.split("\t");
    return { label, ok: status === "ok", detail };
  });

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
