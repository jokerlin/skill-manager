import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
// Electron's patched fs treats every app.asar as a directory, so a recursive rm of an
// extracted .app fails with ENOTEMPTY. original-fs is the unpatched Node fs.
import { promises as rawFs } from "original-fs";
import { app, net } from "electron";
import type { UpdateState } from "../shared/types";
import { MANIFEST, MANIFEST_SIG, type Release, type Signer, bundleOf, compareVersions, parseManifest, parseRelease, parseSigner, pickManifestFile, swapRefusal, swapScript, verifyManifest } from "./update-core";

/** Run a command; exit code and stdout + stderr. A spawn failure counts as exit 127. */
const run = (cmd: string, args: readonly string[]): Promise<{ readonly code: number; readonly out: string }> =>
  new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = "";
    p.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    p.stderr.on("data", (c: Buffer) => { out += c.toString(); });
    p.on("error", () => resolve({ code: 127, out }));
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
  });

const signerOf = async (bundle: string): Promise<Signer> => {
  const r = await run("/usr/bin/codesign", ["-dv", "--verbose=2", bundle]);
  return parseSigner(r.out, r.code);
};

/**
 * Self-update from GitHub Releases, on the Sparkle / Tauri model: the release workflow signs `latest-mac.json`
 * (version + sha512 of each zip) with an Ed25519 key, the app verifies it with the public key in package.json,
 * downloads the zip, checks its sha512, unpacks it with ditto, and (when this app has a Developer ID signature)
 * requires the new bundle to verify and carry the same Team ID. A detached shell script swaps it in after quit.
 */
/** How long a download may receive nothing before it is abandoned. */
const STALL_MS = 60_000;

export const createUpdater = (o: { readonly repo: string | null; readonly api: string; readonly publicKey: string | null; readonly onChange: (s: UpdateState) => void }) => {
  let state: UpdateState = { kind: "idle" };
  let release: Release | null = null;
  let expected: { readonly name: string; readonly url: string; readonly sha512: string; readonly size: number } | null = null;
  let staged: string | null = null;
  const set = (s: UpdateState): UpdateState => { state = s; o.onChange(s); return s; };
  const dir = () => join(app.getPath("userData"), "updates");
  const headers = { Accept: "application/vnd.github+json", "User-Agent": `${app.getName()}/${app.getVersion()}` };
  const text = async (url: string): Promise<string | null> => {
    const res = await net.fetch(url, { headers: { "User-Agent": headers["User-Agent"] } });
    return res.ok ? res.text() : null;
  };
  const key = o.publicKey === null ? null : createPublicKey(o.publicKey);

  const check = async (): Promise<UpdateState> => {
    if (state.kind === "checking" || state.kind === "downloading") return state;
    if (o.repo === null) return set({ kind: "error", message: "no repository configured in package.json" });
    set({ kind: "checking" });
    try {
      const res = await net.fetch(`${o.api.replace(/\/$/, "")}/repos/${o.repo}/releases/latest`, { headers });
      if (res.status === 404) return set({ kind: "error", message: `${o.repo} has no public release` });
      if (!res.ok) return set({ kind: "error", message: `GitHub answered ${res.status}` });
      const r = parseRelease(await res.json());
      if (r === null) return set({ kind: "error", message: "unexpected release format" });
      release = r;
      expected = null;
      if (compareVersions(r.version, app.getVersion()) <= 0) return set({ kind: "current", checkedAt: new Date().toISOString() });
      const base = { kind: "available" as const, version: r.version, notes: r.notes, url: r.url };
      if (key === null) return set({ ...base, asset: null, manual: "no-key" });
      // trust comes from the signed manifest, never from the release listing alone
      const mAsset = r.assets.find((a) => a.name === MANIFEST);
      const sAsset = r.assets.find((a) => a.name === MANIFEST_SIG);
      if (mAsset === undefined || sAsset === undefined) return set({ ...base, asset: null, manual: "unsigned" });
      const [mText, sText] = await Promise.all([text(mAsset.url), text(sAsset.url)]);
      if (mText === null || sText === null) return set({ kind: "error", message: "cannot download the update manifest" });
      if (!verifyManifest((data, sig) => verify(null, data, key, sig), mText, sText)) return set({ kind: "error", message: "the update manifest signature does not verify; not installing" });
      const m = parseManifest(mText);
      if (m === null || m.version !== r.version) return set({ kind: "error", message: `the signed manifest is for ${m?.version ?? "an unknown version"}, the release is ${r.version}` });
      const file = pickManifestFile(m, process.arch);
      const asset = file === null ? undefined : r.assets.find((a) => a.name === file.name);
      if (file === null || asset === undefined) return set({ ...base, asset: null, manual: "no-asset" });
      expected = { name: file.name, url: asset.url, sha512: file.sha512, size: file.size };
      return set({ ...base, asset: file.name });
    } catch (e) {
      return set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const download = async (): Promise<UpdateState> => {
    if (state.kind !== "available" || release === null) return state;
    if (expected === null) return set({ kind: "error", message: `release ${release.version} has no verified ${process.arch} build` });
    if (!app.isPackaged) return set({ kind: "error", message: "development build: install updates from a packaged app" });
    const version = release.version;
    const want = expected;
    try {
      const base = join(dir(), version);
      await rawFs.rm(base, { recursive: true, force: true });
      await mkdir(base, { recursive: true });
      const zip = join(base, want.name);
      // A dropped connection can leave the body stream open with no data and no error, so the download would
      // sit at "downloading" forever. Abort when nothing arrives for STALL_MS.
      const abort = new AbortController();
      let stalled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => { stalled = true; abort.abort(); }, STALL_MS);
      };
      arm();
      const res = await net.fetch(want.url, { signal: abort.signal }).catch((e: unknown) => {
        clearTimeout(timer);
        throw e;
      });
      if (!res.ok || res.body === null) {
        clearTimeout(timer);
        return set({ kind: "error", message: `download failed: ${res.status}` });
      }
      const total = want.size;
      let got = 0;
      let lastPct = -1;
      const hash = createHash("sha512");
      const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      abort.signal.addEventListener("abort", () => body.destroy(new Error("aborted")));
      body.on("data", (c: Buffer) => {
        arm();
        got += c.length;
        hash.update(c);
        const pct = total > 0 ? Math.min(100, Math.floor((got / total) * 100)) : 0;
        if (pct !== lastPct) { lastPct = pct; set({ kind: "downloading", version, percent: pct }); }
      });
      set({ kind: "downloading", version, percent: 0 });
      try {
        await pipeline(body, createWriteStream(zip));
      } catch (e) {
        await rawFs.rm(base, { recursive: true, force: true });
        if (stalled) return set({ kind: "error", message: `the download stalled (no data for ${STALL_MS / 1000} s); deleted it. Check for updates to try again` });
        throw e;
      } finally {
        clearTimeout(timer);
      }
      if (hash.digest("base64") !== want.sha512) {
        await rawFs.rm(base, { recursive: true, force: true });
        return set({ kind: "error", message: "the download does not match the signed checksum; deleted it" });
      }
      const out = join(base, "app");
      await new Promise<void>((resolve, reject) => {
        const p = spawn("ditto", ["-x", "-k", zip, out]);
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ditto exited ${code}`))));
      });
      const bundle = (await readdir(out)).find((n) => n.endsWith(".app"));
      if (bundle === undefined) return set({ kind: "error", message: "the zip has no .app inside" });
      const next = join(out, bundle);
      const current = bundleOf(process.execPath);
      if (current !== null) {
        const verifies = (await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", next])).code === 0;
        const refusal = swapRefusal(await signerOf(current), await signerOf(next), verifies);
        if (refusal !== null) {
          await rawFs.rm(base, { recursive: true, force: true });
          return set({ kind: "error", message: `${refusal}; not installing` });
        }
      }
      staged = next;
      return set({ kind: "ready", version });
    } catch (e) {
      return set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const install = async (): Promise<void> => {
    const current = bundleOf(process.execPath);
    if (state.kind !== "ready" || staged === null || current === null) return;
    const script = join(dir(), "swap.sh");
    await writeFile(script, swapScript({ pid: process.pid, current, next: staged, backup: join(dir(), "previous.app") }));
    spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
    app.quit();
  };

  return { state: () => state, check, download, install };
};
