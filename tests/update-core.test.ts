import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { compareVersions, manifestText, planChunks, rangeHeader, slowWorkers, splitPoint, staleUpdateDirs, parseManifest, parseSigner, pickManifestFile, repoSlug, swapRefusal, swapScript, verifyManifest } from "../desktop/src/main/update-core";

describe("desktop updater core", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const files = [
    { name: "skill-manager-1.2.0-arm64-mac.zip", sha512: "AAA=", size: 10 },
    { name: "skill-manager-1.2.0-x64-mac.zip", sha512: "BBB=", size: 11 },
  ];
  const text = manifestText("v1.2.0", files);
  const sig = sign(null, Buffer.from(text), privateKey).toString("base64");
  const check = (t: string, s: string) => verifyManifest((d, x) => verify(null, d, publicKey, x), t, s);

  test("a signed manifest verifies and parses", () => {
    expect(check(text, sig)).toBe(true);
    expect(parseManifest(text)).toEqual({ version: "1.2.0", files });
  });

  test("any change to the manifest, or another key, fails verification", () => {
    expect(check(text.replace("AAA=", "ZZZ="), sig)).toBe(false);
    const other = generateKeyPairSync("ed25519");
    expect(verifyManifest((d, x) => verify(null, d, other.publicKey, x), text, sig)).toBe(false);
    expect(check(text, "not base64 at all")).toBe(false);
  });

  test("picks the zip for this CPU", () => {
    const m = parseManifest(text);
    expect(m && pickManifestFile(m, "x64")?.name).toBe("skill-manager-1.2.0-x64-mac.zip");
    expect(m && pickManifestFile(m, "ia32")).toBeNull();
  });

  test("version order, repo slug, swap script", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(repoSlug("https://github.com/jokerlin/skill-manager.git")).toBe("jokerlin/skill-manager");
    const s = swapScript({ pid: 1, current: "/Applications/A b.app", next: "/tmp/n.app", backup: "/tmp/old.app" });
    expect(s.indexOf("mv '/Applications/A b.app' '/tmp/old.app'")).toBeLessThan(s.indexOf("mv '/tmp/n.app' '/Applications/A b.app'"));
  });

  test("rejects a manifest with a malformed file entry", () => {
    expect(parseManifest(JSON.stringify({ version: "1", files: [{ name: "x" }] }))).toBeNull();
  });

  test("codesign -dv output names a Developer ID team, an ad-hoc signature, or nothing", () => {
    const devId = "Signature size=9048\nAuthority=Developer ID Application: Example (2DC432GLL2)\nAuthority=Apple Root CA\nTeamIdentifier=2DC432GLL2\n";
    expect(parseSigner(devId, 0)).toEqual({ kind: "team", team: "2DC432GLL2" });
    expect(parseSigner("Signature=adhoc\nTeamIdentifier=not set\n", 0)).toEqual({ kind: "adhoc" });
    expect(parseSigner("x.app: code object is not signed at all\n", 1)).toEqual({ kind: "unsigned" });
  });

  test("a Developer ID-signed app only swaps in a verifying bundle from its own team", () => {
    const mine = { kind: "team", team: "A5T4ZJ88AT" } as const;
    expect(swapRefusal(mine, mine, true)).toBeNull();
    expect(swapRefusal(mine, mine, false)).toContain("does not verify");
    expect(swapRefusal(mine, { kind: "team", team: "ZZZZZZZZZZ" }, true)).toContain("team ZZZZZZZZZZ");
    expect(swapRefusal(mine, { kind: "adhoc" }, true)).toContain("not signed with a Developer ID");
    expect(swapRefusal(mine, { kind: "unsigned" }, true)).toContain("not signed with a Developer ID");
    // an unsigned or ad-hoc build has nothing to pin: the signed manifest is the check (and lets it move to a signed build)
    expect(swapRefusal({ kind: "adhoc" }, mine, true)).toBeNull();
    expect(swapRefusal({ kind: "unsigned" }, { kind: "adhoc" }, false)).toBeNull();
  });
});

describe("parallel update download (pure parts)", () => {
  test("planChunks covers [0, size) with no gap and no overlap; the last chunk is shorter", () => {
    const cs = planChunks(20, 8);
    expect(cs).toEqual([{ start: 0, end: 8 }, { start: 8, end: 16 }, { start: 16, end: 20 }]);
    expect(planChunks(16, 8)).toEqual([{ start: 0, end: 8 }, { start: 8, end: 16 }]);
    expect(planChunks(0, 8)).toEqual([]);
    expect(rangeHeader({ start: 8, end: 16 })).toBe("bytes=8-15"); // HTTP ranges are inclusive
  });

  const opts = { minAgeMs: 5000, ratio: 0.25, minRemaining: 1024 };
  test("slowWorkers: a connection under a quarter of the fastest is restarted (measured: 2106 vs 23 KB/s in one round)", () => {
    const paces = [
      { id: 0, rate: 2_106_000, ageMs: 9000, remaining: 5_000_000 },
      { id: 1, rate: 23_000, ageMs: 9000, remaining: 5_000_000 },
      { id: 2, rate: 1_742_000, ageMs: 9000, remaining: 5_000_000 },
    ];
    expect(slowWorkers(paces, 0, opts)).toEqual([1]);
  });
  test("slowWorkers leaves young connections, nearly finished chunks, and an evenly slow line alone", () => {
    expect(slowWorkers([{ id: 0, rate: 2_000_000, ageMs: 9000, remaining: 9e6 }, { id: 1, rate: 1000, ageMs: 2000, remaining: 9e6 }], 0, opts)).toEqual([]);
    expect(slowWorkers([{ id: 0, rate: 2_000_000, ageMs: 9000, remaining: 9e6 }, { id: 1, rate: 1000, ageMs: 9000, remaining: 500 }], 0, opts)).toEqual([]);
    expect(slowWorkers([{ id: 0, rate: 200_000, ageMs: 9000, remaining: 9e6 }, { id: 1, rate: 180_000, ageMs: 9000, remaining: 9e6 }], 0, opts)).toEqual([]);
    expect(slowWorkers([{ id: 0, rate: 0, ageMs: 9000, remaining: 9e6 }], 0, opts)).toEqual([]); // nothing to compare with: the stall timeout handles it
  });
  test("slowWorkers does not reopen anything when the whole line slows down together", () => {
    // all four fell to 0-9 KB/s at once in a trace; reopening them only added ~2 s of connection setup each
    expect(slowWorkers([{ id: 0, rate: 8000, ageMs: 9000, remaining: 9e6 }, { id: 1, rate: 9000, ageMs: 9000, remaining: 9e6 }, { id: 2, rate: 3000, ageMs: 9000, remaining: 9e6 }], 0, opts)).toEqual([]);
  });

  test("slowWorkers: at the end, with the others idle, the last connection is compared with the chunks just finished", () => {
    expect(slowWorkers([{ id: 3, rate: 30_000, ageMs: 9000, remaining: 1.5e6 }], 2_000_000, opts)).toEqual([3]);
  });

  test("splitPoint halves the open range with the most bytes left; small ranges and no open ranges are not split", () => {
    const open = [{ id: 0, pos: 100, limit: 200 }, { id: 1, pos: 1000, limit: 9000 }, { id: 2, pos: 50, limit: 60 }];
    expect(splitPoint(open, 1000)).toEqual({ id: 1, mid: 5000 });
    expect(splitPoint(open, 4000)).toBeNull(); // 8000 left is not more than 2 × 4000
    expect(splitPoint([], 10)).toBeNull();
  });

  test("staleUpdateDirs: version folders up to the running version; never previous.app, swap.sh or a newer download", () => {
    const names = ["0.3.1", "0.4.0", "0.5.0", "0.5.1", "0.5.2", "previous.app", "swap.sh", ".DS_Store"];
    expect(staleUpdateDirs(names, "0.5.1")).toEqual(["0.3.1", "0.4.0", "0.5.0", "0.5.1"]);
    expect(staleUpdateDirs(["previous.app", "swap.sh"], "0.5.1")).toEqual([]);
  });
});
