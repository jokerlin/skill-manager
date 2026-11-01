import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { compareVersions, manifestText, parseManifest, parseSigner, pickManifestFile, repoSlug, swapRefusal, swapScript, verifyManifest } from "../desktop/src/main/update-core";

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
