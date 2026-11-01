import { describe, expect, mock, test, beforeEach } from "bun:test";
import type { RunResult } from "../src/shared/types";

// The renderer imports through the desktop's `@/` alias, which only the desktop tsconfig knows: point it at the real files.
// Paths sit in variables so no typecheck follows them into renderer files under a tsconfig without the alias.
const RENDERER = "../src/renderer/src";
mock.module("@/i18n", () => import(`${RENDERER}/i18n/index.ts`));
mock.module("@/lib/skm", () => import(`${RENDERER}/lib/skm.ts`));

/** A fake `skm` CLI behind window.skm.run: `upstream --json` answers from `upstream`, everything else succeeds empty. */
let upstream: () => RunResult = () => ({ ok: true, stdout: "{}" });
const calls: string[][] = [];
const report = { upstreams: [{ name: "kit", repo: "https://example.com/kit", ref: null, target: { commit: "c2", label: "v2.0.0" }, warning: null, error: null, unlisted: [], skills: [{ skill: "review", state: "current", base: { commit: "c2", label: "v2.0.0" }, changes: [] }] }] };
const ok = (v: unknown): RunResult => ({ ok: true, stdout: JSON.stringify(v) });
const empty = (args: readonly string[]): RunResult =>
  args[0] === "config" ? ok({ hosts: [], agents: [], hostDetails: [], agentCatalog: [] }) : args[0] === "plugins" ? ok({ hosts: [], grid: [], plugins: [] }) : args[0] === "harness" ? ok({ agents: [], hosts: [] }) : ok([]);
(globalThis as { window?: unknown }).window = {
  skm: {
    run: async (args: readonly string[]) => {
      calls.push([...args]);
      return args[0] === "upstream" ? upstream() : empty(args);
    },
  },
};

type Store = {
  readonly upstreams: typeof report | null;
  readonly error: string | null;
  readonly boot: () => Promise<void>;
  readonly refreshLive: (host?: string) => Promise<void>;
};
const { useApp } = (await import(`${RENDERER}/store/app.ts`)) as { useApp: { getState: () => Store; setState: (s: Partial<Store> & { upstreamChecking?: boolean }) => void } };

describe("desktop: upstream check recovers after a failed launch check", () => {
  beforeEach(() => {
    calls.length = 0;
    useApp.setState({ upstreams: null, error: null, upstreamChecking: false });
  });

  test("Refresh re-checks the upstreams that failed at launch, without a toast at launch", async () => {
    // launch with a CLI that predates `skm upstream`
    upstream = () => ({ ok: false, code: 1, stderr: "error: unknown option '--json'", notFound: false });
    await useApp.getState().boot();
    await new Promise((r) => setTimeout(r, 20));
    expect(useApp.getState().upstreams).toBeNull();
    expect(useApp.getState().error).toBeNull();
    // the CLI is upgraded; Refresh (⌘R) must pick the upstreams up
    upstream = () => ok(report);
    await useApp.getState().refreshLive();
    expect(useApp.getState().upstreams?.upstreams[0]?.skills[0]?.skill).toBe("review");
    expect(calls.filter((a) => a[0] === "upstream" && !a.includes("--cached")).length).toBeGreaterThanOrEqual(2);
  });

  test("a user-initiated check that fails says so; refreshing one host does not touch upstreams", async () => {
    upstream = () => ({ ok: false, code: 1, stderr: "error: fetch failed", notFound: false });
    await useApp.getState().refreshLive();
    expect(useApp.getState().error).toContain("fetch failed");
    useApp.setState({ error: null });
    calls.length = 0;
    await useApp.getState().refreshLive("mini");
    expect(calls.some((a) => a[0] === "upstream")).toBe(false);
  });
});
