import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeHarness } from "../src/shell/harness";
import { harnessScript, parseHarnessLine, shortVersion } from "../src/core/harness";

describe("harness", () => {
  test("parses result lines and ignores tool output", () => {
    expect(parseHarnessLine("@@harness\tclaude\tmissing")).toEqual({ kind: "missing", agent: "claude" });
    expect(parseHarnessLine("@@harness\tpi\tchecked\t1.4.0")).toEqual({ kind: "checked", agent: "pi", version: "1.4.0", latest: "" });
    expect(parseHarnessLine("@@harness\tchatgpt\tchecked\t26.1013.40934\t26.1027.51404")).toEqual({ kind: "checked", agent: "chatgpt", version: "26.1013.40934", latest: "26.1027.51404" });
    expect(parseHarnessLine("@@harness\tcodex\tok\tcodex-cli 0.164.0\tcodex-cli 0.166.0")).toEqual({ kind: "updated", agent: "codex", before: "codex-cli 0.164.0", after: "codex-cli 0.166.0", ok: true });
    expect(parseHarnessLine("@@harness\tcodex\tfail\tx\tx")?.kind).toBe("updated");
    expect(parseHarnessLine("Updating to 2.1.316...")).toBeNull();
  });

  test("short version keeps the dotted number", () => {
    expect(shortVersion("2.1.316 (Claude Code)")).toBe("2.1.316");
    expect(shortVersion("codex-cli 0.166.0")).toBe("0.166.0");
    expect(shortVersion("dev build")).toBe("dev build");
  });

  test("check scripts never run the update command", () => {
    const tools = [{ kind: "cli" as const, id: "claude", bin: "claude", update: "claude update" }];
    expect(harnessScript(tools, "check")).not.toContain("claude update");
    expect(harnessScript(tools, "update")).toContain("claude update");
  });

  test("the script runs and reports a missing tool", async () => {
    const script = harnessScript([{ kind: "cli", id: "nope", bin: "skm-no-such-bin-xyz", update: "true" }, { kind: "cli", id: "sh", bin: "sh", update: "true" }], "check");
    const p = Bun.spawn(["sh", "-s"], { stdin: new Blob([script]), stdout: "pipe" });
    const lines = (await new Response(p.stdout).text()).split("\n").map(parseHarnessLine).filter((x) => x !== null);
    expect(lines[0]).toEqual({ kind: "missing", agent: "nope" });
    expect(lines[1]?.kind).toBe("checked");
  });

  test("an app check reads the bundle version and the newest feed item for this CPU", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skm-app-"));
    const bundle = join(dir, "Fake.app");
    await mkdir(join(bundle, "Contents"), { recursive: true });
    await writeFile(join(bundle, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>1.0.0</string><key>CFBundleVersion</key><string>10</string></dict></plist>`);
    const arch = (await new Response(Bun.spawn(["uname", "-m"], { stdout: "pipe" }).stdout).text()).trim();
    const other = arch === "arm64" ? "x86_64" : "arm64";
    await writeFile(join(dir, "appcast.xml"), `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
<item><sparkle:version>30</sparkle:version><sparkle:shortVersionString>3.0.0</sparkle:shortVersionString><sparkle:hardwareRequirements>${other}</sparkle:hardwareRequirements>
<enclosure url="https://example.invalid/other.zip" length="1" /></item>
<item><sparkle:version>20</sparkle:version><sparkle:shortVersionString>2.0.0</sparkle:shortVersionString><sparkle:hardwareRequirements>${arch}</sparkle:hardwareRequirements>
<enclosure url="https://example.invalid/mine.zip" length="1" />
<sparkle:deltas><enclosure url="https://example.invalid/d.delta" sparkle:deltaFrom="10" /></sparkle:deltas></item>
</channel></rss>`);
    const script = harnessScript([
      { kind: "app", id: "fake", bundle, feed: `file://${join(dir, "appcast.xml")}`, marker: ".nope" },
      { kind: "app", id: "gone", bundle: join(dir, "Gone.app"), feed: "file:///dev/null", marker: ".nope" },
    ], "check");
    const p = Bun.spawn(["sh", "-s"], { stdin: new Blob([script]), stdout: "pipe" });
    const lines = (await new Response(p.stdout).text()).split("\n").map(parseHarnessLine).filter((x) => x !== null);
    if (process.platform === "darwin") expect(lines[0]).toEqual({ kind: "checked", agent: "fake", version: "1.0.0", latest: "2.0.0" });
    else expect(lines[0]).toEqual({ kind: "missing", agent: "fake" });
    expect(lines[1]).toEqual({ kind: "missing", agent: "gone" });
  });

  test("an app update script never touches the bundle before the signature and Team ID checks", () => {
    const s = harnessScript([{ kind: "app", id: "x", bundle: "/Applications/X.app", feed: "https://e.invalid/a.xml", marker: ".m" }], "update");
    const at = (needle: string) => s.indexOf(needle);
    expect(at("codesign --verify")).toBeGreaterThan(0);
    expect(at("codesign --verify")).toBeLessThan(at('mv "$APP" "$dest"'));
    expect(at("Team ID differs")).toBeLessThan(at('mv "$APP" "$dest"'));
    expect(harnessScript([{ kind: "app", id: "x", bundle: "/Applications/X.app", feed: "https://e.invalid/a.xml", marker: ".m" }], "check")).not.toContain("mv ");
  });

  test("a partial run replaces only its own tools in the cached host", () => {
    const prev = { host: "mini", at: "t0", error: null, results: [
      { kind: "checked" as const, agent: "claude", version: "1", latest: "" },
      { kind: "checked" as const, agent: "codex", version: "1", latest: "" },
    ] };
    const next = { host: "mini", at: "t1", error: null, results: [{ kind: "updated" as const, agent: "codex", before: "1", after: "2", ok: true }] };
    expect(mergeHarness(prev, next).results.map((r) => r.agent)).toEqual(["claude", "codex"]);
    expect(mergeHarness(prev, next).results[1]?.kind).toBe("updated");
    expect(mergeHarness(prev, { ...next, error: "ssh failed", results: [] }).results).toHaveLength(2);
  });
});
