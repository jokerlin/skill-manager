import { describe, expect, test } from "bun:test";
import { type CoverageCell, summarize } from "../src/core/coverage";
import { newestVersion } from "../src/core/version";

const grid = (on: (host: string, agent: string) => boolean): CoverageCell[] =>
  ["local", "mini", "devbox"].flatMap((host) => ["claude", "codex", "pi"].map((agent) => ({ host, agent, on: on(host, agent) })));

describe("summarize (shared by the app and the TUI)", () => {
  test("everywhere and nowhere", () => {
    expect(summarize(grid(() => true))).toEqual({ kind: "everywhere" });
    expect(summarize(grid(() => false))).toEqual({ kind: "nowhere" });
  });
  test("picks the shorter of only / all but, hosts before agents", () => {
    expect(summarize(grid((h) => h === "mini"))).toEqual({ kind: "only-hosts", hosts: ["mini"] });
    expect(summarize(grid((h) => h !== "devbox"))).toEqual({ kind: "except-hosts", hosts: ["devbox"] });
    expect(summarize(grid((_, a) => a !== "codex"))).toEqual({ kind: "except-agents", agents: ["codex"] });
  });
  test("a count when neither axis splits cleanly", () => {
    expect(summarize(grid((h, a) => h === "local" || a === "claude"))).toEqual({ kind: "partial", on: 5, total: 9 });
  });
});

describe("newestVersion", () => {
  test("orders dotted numbers numerically, not as text", () => {
    expect(newestVersion(["1.10.0", "1.9.3", "1.2"])).toBe("1.10.0");
    expect(newestVersion(["0.1.2541", "0.1.2529"])).toBe("0.1.2541");
  });
  test("null when any version is not dotted-numeric (commit hashes, tags), or there is none", () => {
    expect(newestVersion(["1.2.0", "a1b2c3d"])).toBeNull();
    expect(newestVersion([])).toBeNull();
  });
});
