/** Pure helpers for the updater: version order, release parsing, asset choice. No Electron imports, so they test under plain bun. */

export type Release = { readonly version: string; readonly notes: string; readonly url: string; readonly assets: readonly { readonly name: string; readonly url: string; readonly size: number }[] };

const parts = (v: string): number[] => v.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);

/** > 0 when a is newer than b (major.minor.patch, a leading v and pre-release tags are ignored). */
export const compareVersions = (a: string, b: string): number => {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** GitHub `releases/latest` JSON → Release, or null when the shape is not a release. */
export const parseRelease = (raw: unknown): Release | null => {
  if (!isRecord(raw) || typeof raw["tag_name"] !== "string") return null;
  const assets = Array.isArray(raw["assets"]) ? raw["assets"] : [];
  return {
    version: raw["tag_name"].replace(/^v/, ""),
    notes: typeof raw["body"] === "string" ? raw["body"] : "",
    url: typeof raw["html_url"] === "string" ? raw["html_url"] : "",
    assets: assets.flatMap((a) =>
      isRecord(a) && typeof a["name"] === "string" && typeof a["browser_download_url"] === "string"
        ? [{ name: a["name"], url: a["browser_download_url"], size: typeof a["size"] === "number" ? a["size"] : 0 }]
        : []),
  };
};

/** `https://github.com/owner/repo(.git)` or `owner/repo` → `owner/repo`. */
export const repoSlug = (repository: string): string | null => {
  const m = /(?:github\.com[/:])?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(repository.trim());
  return m && m[1] && m[2] ? `${m[1]}/${m[2]}` : null;
};

/** The .app bundle that contains the running executable (…/X.app/Contents/MacOS/X → …/X.app). */
export const bundleOf = (execPath: string): string | null => {
  const i = execPath.indexOf(".app/Contents/MacOS/");
  return i < 0 ? null : execPath.slice(0, i + 4);
};

const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Shell script that waits for the running app to exit, keeps the old bundle as a backup,
 * moves the new bundle into place, clears quarantine and reopens it.
 */
export const swapScript = (o: { readonly pid: number; readonly current: string; readonly next: string; readonly backup: string }): string => [
  "#!/bin/sh",
  `while kill -0 ${o.pid} 2>/dev/null; do sleep 0.3; done`,
  `rm -rf ${q(o.backup)}`,
  `mv ${q(o.current)} ${q(o.backup)} || exit 1`,
  `if ! mv ${q(o.next)} ${q(o.current)}; then mv ${q(o.backup)} ${q(o.current)}; open ${q(o.current)}; exit 1; fi`,
  `xattr -dr com.apple.quarantine ${q(o.current)} 2>/dev/null || true`,
  `open ${q(o.current)}`,
].join("\n") + "\n";

/**
 * `latest-mac.json`, written and signed by the release workflow: the version and the sha512 of every zip.
 * The app trusts a release only when this file verifies against the Ed25519 public key built into it.
 */
export type Manifest = { readonly version: string; readonly files: readonly { readonly name: string; readonly sha512: string; readonly size: number }[] };

export const MANIFEST = "latest-mac.json";
export const MANIFEST_SIG = "latest-mac.json.sig";

/** Manifest JSON → Manifest, or null when the shape is wrong. */
export const parseManifest = (text: string): Manifest | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw["version"] !== "string" || !Array.isArray(raw["files"])) return null;
  const files = raw["files"].flatMap((f) =>
    isRecord(f) && typeof f["name"] === "string" && typeof f["sha512"] === "string" && typeof f["size"] === "number" ? [{ name: f["name"], sha512: f["sha512"], size: f["size"] }] : []);
  return files.length === raw["files"].length ? { version: raw["version"].replace(/^v/, ""), files } : null;
};

/** Ed25519 check of the manifest bytes against a base64 signature. Never throws. */
export const verifyManifest = (verify: (data: Buffer, sig: Buffer) => boolean, text: string, sigBase64: string): boolean => {
  try {
    return verify(Buffer.from(text, "utf8"), Buffer.from(sigBase64.trim(), "base64"));
  } catch {
    return false;
  }
};

/** The manifest entry for this CPU (or a universal build). */
export const pickManifestFile = (m: Manifest, arch: string): Manifest["files"][number] | null =>
  m.files.find((f) => f.name.endsWith(`-${arch}-mac.zip`)) ?? m.files.find((f) => f.name.endsWith("-universal-mac.zip")) ?? null;

/** The manifest text the release workflow signs: stable key order, one trailing newline. Pure. */
export const manifestText = (version: string, files: Manifest["files"]): string =>
  `${JSON.stringify({ version: version.replace(/^v/, ""), files: files.map((f) => ({ name: f.name, sha512: f.sha512, size: f.size })) }, null, 2)}\n`;

/** Who signed a bundle, from `codesign -dv` (it prints to stderr). */
export type Signer = { readonly kind: "team"; readonly team: string } | { readonly kind: "adhoc" } | { readonly kind: "unsigned" };

export const parseSigner = (codesignDv: string, exitCode: number): Signer => {
  if (exitCode !== 0) return { kind: "unsigned" };
  const team = /^TeamIdentifier=(\S+)$/m.exec(codesignDv)?.[1];
  return team !== undefined && team !== "not" && /^[A-Z0-9]{10}$/.test(team) ? { kind: "team", team } : { kind: "adhoc" };
};

/**
 * A Developer ID-signed app replaces itself only with a bundle whose signature verifies and whose team is the same,
 * on top of the signed manifest. An unsigned or ad-hoc build (a fork, a local build) has no team to pin, so the
 * signed manifest and checksum stay the only checks. Returns why the swap is refused, or null.
 */
export const swapRefusal = (current: Signer, next: Signer, nextVerifies: boolean): string | null => {
  switch (current.kind) {
    case "unsigned":
    case "adhoc":
      return null;
    case "team":
      if (!nextVerifies) return "the downloaded app's code signature does not verify";
      switch (next.kind) {
        case "team":
          return next.team === current.team ? null : `the downloaded app is signed by team ${next.team}, not ${current.team}`;
        case "adhoc":
        case "unsigned":
          return "the downloaded app is not signed with a Developer ID";
      }
  }
};

/** A byte range of the update zip, [start, end). */
export type Chunk = { readonly start: number; readonly end: number };

/** Split [0, size) into chunks of `chunk` bytes; the last one is shorter. Pure. */
export const planChunks = (size: number, chunk: number): Chunk[] =>
  Array.from({ length: Math.ceil(size / chunk) }, (_, i) => ({ start: i * chunk, end: Math.min(size, (i + 1) * chunk) }));

/** The HTTP Range header for a chunk (HTTP ranges include their last byte). */
export const rangeHeader = (c: Chunk): string => `bytes=${c.start}-${c.end - 1}`;

/** One download connection: bytes/s over the last window, how long it has been open, bytes left in its chunk. */
export type Pace = { readonly id: number; readonly rate: number; readonly ageMs: number; readonly remaining: number };

/**
 * Connections to give up and reopen. Through a proxy, the speed of a connection is luck: in one measured round four
 * parallel connections ran at 2106, 24, 23 and 1742 KB/s. A connection open for at least `minAgeMs` with more than
 * `minRemaining` bytes left is slow when it runs under `ratio` × the fastest connection open now, or, while some
 * connections sit idle at the end, × `idleBest`: the best speed of the chunks finished in the last few seconds.
 * Earlier speeds do not count: when the whole line slows down (all four fell to 0-9 KB/s for 20 s in one trace),
 * comparing with them reopened every connection again and again, and each reopen waits about 2 s for its first byte.
 * When nothing moves there is nothing to compare with; the stall timeout handles that. Pure.
 */
export const slowWorkers = (paces: readonly Pace[], idleBest: number, o: { readonly minAgeMs: number; readonly ratio: number; readonly minRemaining: number }): number[] => {
  const best = Math.max(idleBest, ...paces.map((p) => p.rate));
  if (best <= 0) return [];
  return paces.filter((p) => p.ageMs >= o.minAgeMs && p.remaining > o.minRemaining && p.rate < best * o.ratio).map((p) => p.id);
};

/**
 * Folders in the updates directory that can go: one per downloaded version, for versions up to the running one (the
 * update was installed, or is older). previous.app is the rollback copy and stays; a newer version's folder may be a
 * download in progress. Pure.
 */
export const staleUpdateDirs = (names: readonly string[], running: string): string[] =>
  names.filter((n) => /^\d+\.\d+\.\d+$/.test(n) && compareVersions(n, running) <= 0);

/**
 * When the queue is empty, an idle connection takes the second half of the open chunk with the most bytes left, so
 * every connection keeps working to the end instead of waiting for the slowest one. Measured before this: the last
 * 2 to 9 MB took 15 s on one slow connection while three sat idle. Only a range of more than 2 × `min` bytes is split.
 * Returns the connection to shorten and where its range now ends, or null. Pure.
 */
export const splitPoint = (open: readonly { readonly id: number; readonly pos: number; readonly limit: number }[], min: number): { readonly id: number; readonly mid: number } | null => {
  const best = open.reduce<(typeof open)[number] | null>((a, w) => (a === null || w.limit - w.pos > a.limit - a.pos ? w : a), null);
  if (best === null || best.limit - best.pos <= 2 * min) return null;
  return { id: best.id, mid: best.pos + Math.floor((best.limit - best.pos) / 2) };
};
