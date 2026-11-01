import { shQuote } from "../lib/sh";
import { HOST_PATH } from "./scripts";

/**
 * One thing to check or update on a host:
 * - `cli`: an agent CLI; `--version` prints its version and `update` is its own self-update command.
 * - `app`: a macOS desktop app updated from its Sparkle appcast (download, signature check, swap with a backup, reopen).
 * `id` is the key in results: the agent id for a CLI, the app id for an app.
 */
export type HarnessTool =
  | { readonly kind: "cli"; readonly id: string; readonly bin: string; readonly update: string; readonly onChange?: string }
  | { readonly kind: "app"; readonly id: string; readonly bundle: string; readonly feed: string; readonly marker: string; readonly settle?: { readonly file: string; readonly busy: string } };

/** What happened to one tool on one host. `agent` is the tool id. `latest` is the newest version the app's feed offers ("" = unknown). */
export type HarnessResult =
  | { readonly kind: "missing"; readonly agent: string }
  | { readonly kind: "checked"; readonly agent: string; readonly version: string; readonly latest: string }
  | { readonly kind: "updated"; readonly agent: string; readonly before: string; readonly after: string; readonly ok: boolean };

export type HarnessMode = "check" | "update";

const esc = (s: string): string => s.replace(/["\\$`]/g, "\\$&");

/** Shell for one agent CLI, run inside the user's login shell. */
const cliInner = (t: Extract<HarnessTool, { kind: "cli" }>, mode: HarnessMode): string => [
  // the first line that carries a version number: some tools log to stderr before printing it
  `ver() { v=$("$1" --version 2>/dev/null | grep -m1 -E '[0-9]+\\.[0-9]+'); [ -n "$v" ] || v=$("$1" --version 2>&1 | grep -m1 -E '[0-9]+\\.[0-9]+'); [ -n "$v" ] || v=$("$1" --version 2>&1 | head -n 1); printf '%s' "$v" | tr '\\t' ' '; }`,
  `if ! command -v ${shQuote(t.bin)} >/dev/null 2>&1; then printf '@@harness\\t%s\\tmissing\\n' ${shQuote(t.id)}; exit 0; fi`,
  `before=$(ver ${shQuote(t.bin)})`,
  ...(mode === "check"
    ? [`printf '@@harness\\t%s\\tchecked\\t%s\\n' ${shQuote(t.id)} "$before"`]
    : [
        `echo ">> ${esc(t.update)}"`,
        `if ${t.update} </dev/null 2>&1; then r=ok; else r=fail; fi`,
        `after=$(ver ${shQuote(t.bin)})`,
        ...(t.onChange ? [`if [ "$r" = ok ] && [ "$after" != "$before" ]; then echo ">> ${esc(t.onChange)}"; ${t.onChange} </dev/null 2>&1 || echo "onChange failed"; fi`] : []),
        `printf '@@harness\\t%s\\t%s\\t%s\\t%s\\n' ${shQuote(t.id)} "$r" "$before" "$after"`,
      ]),
].join("\n");

/**
 * awk over a Sparkle appcast: the first <item> this CPU can run (hardwareRequirements absent or naming `uname -m`),
 * printed as `<build>\t<short version>\t<full zip url>`. Delta enclosures are skipped.
 */
const FEED_AWK = `awk -v arch="$(uname -m)" '
/<item>/ {it=1; v=""; s=""; u=""; hw=""; d=0}
it && /<sparkle:deltas>/ {d=1}
it && /<\\/sparkle:deltas>/ {d=0}
it && /<sparkle:version>/ {x=$0; gsub(/.*<sparkle:version>|<\\/sparkle:version>.*/,"",x); v=x}
it && /<sparkle:shortVersionString>/ {x=$0; gsub(/.*<sparkle:shortVersionString>|<\\/sparkle:shortVersionString>.*/,"",x); s=x}
it && /<sparkle:hardwareRequirements>/ {x=$0; gsub(/.*<sparkle:hardwareRequirements>|<\\/sparkle:hardwareRequirements>.*/,"",x); hw=x}
it && !d && /<enclosure / && u=="" {if (match($0,/url="[^"]*"/)) u=substr($0,RSTART+5,RLENGTH-6)}
/<\\/item>/ {if (it && (hw=="" || index(hw,arch)>0) && u!="") {print v "\\t" s "\\t" u; exit} it=0}'`;

/**
 * Shell for one desktop app. Check: installed short version + the feed's newest. Update: when the feed has a newer build,
 * download the zip, require a valid signature from the same Team ID as the installed app, quit the app, move the old bundle
 * to ~/.skm/backups/app/, install the new one, then open it so it rewrites its marketplaces (hidden, and quit again
 * afterwards, when it was not running before).
 */
const appInner = (t: Extract<HarnessTool, { kind: "app" }>, mode: HarnessMode): string => {
  const id = shQuote(t.id);
  const common = [
    `APP=${shQuote(t.bundle)}; FEED=${shQuote(t.feed)}`,
    `plist() { /usr/libexec/PlistBuddy -c "Print :$1" "$APP/Contents/Info.plist" 2>/dev/null; }`,
    `if [ "$(uname)" != Darwin ] || [ ! -d "$APP" ]; then printf '@@harness\\t%s\\tmissing\\n' ${id}; exit 0; fi`,
    `before=$(plist CFBundleShortVersionString); build=$(plist CFBundleVersion)`,
    `item=$(curl -fsSL --max-time 60 "$FEED" 2>/dev/null | ${FEED_AWK})`,
    `newB=$(printf '%s' "$item" | cut -f1); newS=$(printf '%s' "$item" | cut -f2); url=$(printf '%s' "$item" | cut -f3)`,
  ];
  if (mode === "check") return [...common, `printf '@@harness\\t%s\\tchecked\\t%s\\t%s\\n' ${id} "$before" "$newS"`].join("\n");
  return [
    ...common,
    `done_() { printf '@@harness\\t%s\\t%s\\t%s\\t%s\\n' ${id} "$1" "$before" "$(plist CFBundleShortVersionString)"; exit 0; }`,
    `[ -n "$item" ] || { echo "cannot read a release for $(uname -m) from $FEED"; done_ fail; }`,
    `echo "installed $before ($build), latest $newS ($newB)"`,
    `[ "$newB" -gt "$build" ] 2>/dev/null || { echo "already the latest"; done_ ok; }`,
    `work=$(mktemp -d "\${TMPDIR:-/tmp}/skm-app.XXXXXX")`,
    `echo ">> download $url"`,
    `curl -fL --max-time 3600 -sS -o "$work/app.zip" "$url" || { echo "download failed"; done_ fail; }`,
    `ditto -x -k "$work/app.zip" "$work/x" || { echo "unzip failed"; done_ fail; }`,
    `next=$(find "$work/x" -maxdepth 1 -name '*.app' | head -n 1)`,
    `[ -n "$next" ] || { echo "the zip has no .app"; done_ fail; }`,
    `team() { codesign -dv "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p'; }`,
    `codesign --verify --deep --strict "$next" 2>&1 || { echo "signature check failed"; done_ fail; }`,
    `[ -n "$(team "$APP")" ] && [ "$(team "$next")" = "$(team "$APP")" ] || { echo "Team ID differs: $(team "$next") vs $(team "$APP")"; done_ fail; }`,
    `bid=$(plist CFBundleIdentifier); exe="$APP/Contents/MacOS/$(plist CFBundleExecutable)"`,
    `running() { pgrep -f "^$exe" >/dev/null 2>&1; }`,
    `was=0; running && was=1`,
    `if [ $was = 1 ]; then echo ">> quit $bid"; osascript -e "tell application id \\"$bid\\" to quit" >/dev/null 2>&1; for _ in $(seq 1 30); do running || break; sleep 1; done; fi`,
    `running && { echo "the app is still running; quit it and retry"; done_ fail; }`,
    `bak="$HOME/.skm/backups/app"; mkdir -p "$bak"; dest="$bak/$(basename "$APP").bak-$(date +%Y%m%d-%H%M%S)"`,
    `mv "$APP" "$dest" || { echo "cannot move $APP (permissions?)"; done_ fail; }`,
    `if ! mv "$next" "$APP"; then mv "$dest" "$APP"; echo "install failed, old app restored"; done_ fail; fi`,
    `xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true`,
    `rm -rf "$work"`,
    `echo "old app kept at $dest"`,
    `marker="$HOME/"${shQuote(t.marker)}`,
    ...(t.settle !== undefined
      ? [
          `sfile="$HOME/"${shQuote(t.settle.file)}; busy="$HOME/"${shQuote(t.settle.busy)}; bdir=$(dirname "$busy"); bname=$(basename "$busy")`,
          `s0=$(cksum "$sfile" 2>/dev/null); stamp=$(mktemp "\${TMPDIR:-/tmp}/skm-stamp.XXXXXX")`,
        ]
      : []),
    `if [ $was = 1 ]; then open -a "$APP"; else open -g -j -a "$APP"; fi`,
    // the app rewrites its marketplace within seconds of launch
    `echo ">> waiting for $(basename "$APP") to rewrite its plugins"`,
    `for _ in $(seq 1 45); do grep -q "$newS" "$marker" 2>/dev/null && break; sleep 2; done`,
    `grep -q "$newS" "$marker" 2>/dev/null && echo "plugins rewritten" || echo "the app did not rewrite $marker within 90s"`,
    // a follow-up download (archives keep old mtimes, so compare content): wait while it runs, give up after 30s of no sign of one
    ...(t.settle !== undefined
      ? [
          `n=0; while [ $n -lt 300 ]; do`,
          `  if [ "$(cksum "$sfile" 2>/dev/null)" != "$s0" ]; then echo "$(basename "$sfile") updated"; sleep 20; break; fi`,
          `  if [ $n -ge 30 ] && [ -z "$(find "$bdir" -maxdepth 1 -name "$bname" -newer "$stamp" 2>/dev/null)" ]; then break; fi`,
          `  sleep 3; n=$((n+3))`,
          `done`,
          `rm -f "$stamp"`,
        ]
      : []),
    `if [ $was = 0 ]; then osascript -e "tell application id \\"$bid\\" to quit" >/dev/null 2>&1; for _ in $(seq 1 15); do running || break; sleep 1; done; fi`,
    `done_ ok`,
  ].join("\n");
};

/**
 * Shell script for one host. Each tool runs inside the user's login shell ($SHELL -lc) so version managers
 * (mise, asdf, nvm) and npm global bins resolve as they do in a terminal. Every tool ends with one result line:
 *   `@@harness\t<id>\tmissing`
 *   `@@harness\t<id>\tchecked\t<version>[\t<latest>]`
 *   `@@harness\t<id>\tok|fail\t<before>\t<after>`
 * Other lines are the update commands' own output. Pure.
 */
export const harnessScript = (tools: readonly HarnessTool[], mode: HarnessMode): string => {
  const inner = (t: HarnessTool): string => {
    switch (t.kind) {
      case "cli":
        return cliInner(t, mode);
      case "app":
        return appInner(t, mode);
    }
  };
  return [
    "#!/bin/sh",
    HOST_PATH,
    `S="\${SHELL:-/bin/sh}"; [ -x "$S" ] || S=/bin/sh`,
    ...tools.map((t) => `"$S" -lc ${shQuote(inner(t))} </dev/null 2>&1`),
    "exit 0",
  ].join("\n") + "\n";
};

const RESULT = /^@@harness\t([^\t]+)\t(missing|checked|ok|fail)(?:\t([^\t]*))?(?:\t([^\t]*))?$/;

/** One output line → a result, or none for ordinary log lines. Pure. */
export const parseHarnessLine = (line: string): HarnessResult | null => {
  const m = RESULT.exec(line.trimEnd());
  if (!m || !m[1] || !m[2]) return null;
  const agent = m[1];
  switch (m[2]) {
    case "missing":
      return { kind: "missing", agent };
    case "checked":
      return { kind: "checked", agent, version: m[3] ?? "", latest: m[4] ?? "" };
    case "ok":
    case "fail":
      return { kind: "updated", agent, before: m[3] ?? "", after: m[4] ?? "", ok: m[2] === "ok" };
    default:
      return null;
  }
};

/** A short version from a `--version` line: the first dotted number, else the line itself. */
export const shortVersion = (line: string): string => /\d+(?:\.\d+)+(?:[-+][\w.]+)?/.exec(line)?.[0] ?? line.trim();
