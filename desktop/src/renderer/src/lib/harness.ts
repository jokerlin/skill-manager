import type { HarnessApp, HarnessReport } from "@shared/types";

const nums = (v: string): number[] => v.split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
export const cmpVersion = (a: string, b: string): number => {
  const pa = nums(a);
  const pb = nums(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** One agent CLI across hosts: the newest version seen and each host's version. */
export type HarnessAgentView = {
  readonly agent: string;
  readonly newest: string | null;
  readonly versions: readonly string[];
  readonly byHost: Readonly<Record<string, string | null | undefined>>;
};

/** Pure. `undefined` in byHost = not checked (or host unreachable); null = CLI not installed. */
export const harnessView = (r: HarnessReport | null, agents: readonly string[]): readonly HarnessAgentView[] =>
  agents.map((agent) => {
    const byHost = Object.fromEntries((r?.hosts ?? []).map((h) => [h.host, h.error !== null ? undefined : h.versions[agent]]));
    const versions = [...new Set(Object.values(byHost).filter((v): v is string => typeof v === "string"))].sort(cmpVersion);
    return { agent, newest: versions[versions.length - 1] ?? null, versions, byHost };
  });

export const isBehind = (v: HarnessAgentView, host: string): boolean => {
  const x = v.byHost[host];
  return typeof x === "string" && v.newest !== null && cmpVersion(x, v.newest) < 0;
};

/** One desktop app across hosts: installed version per host (null = not installed, undefined = unknown) and the feed's newest. */
export type HarnessAppView = {
  readonly app: HarnessApp;
  readonly latest: string | null;
  readonly byHost: Readonly<Record<string, string | null | undefined>>;
  /** hosts where the app is installed and older than its feed's newest version */
  readonly behind: readonly string[];
};

/** Pure. */
export const harnessApps = (r: HarnessReport | null): readonly HarnessAppView[] =>
  (r?.apps ?? []).map((app) => {
    const byHost = Object.fromEntries((r?.hosts ?? []).map((h) => [h.host, h.error !== null ? undefined : h.versions[app.id]]));
    const latests = (r?.hosts ?? []).flatMap((h) => (h.latest?.[app.id] ? [h.latest[app.id] as string] : [])).sort(cmpVersion);
    const latest = latests[latests.length - 1] ?? null;
    const behind = Object.entries(byHost).flatMap(([h, v]) => (typeof v === "string" && latest !== null && cmpVersion(v, latest) < 0 ? [h] : []));
    return { app, latest, byHost, behind };
  });

/** The app that writes a marketplace, if skm knows one. */
export const appOfMarketplace = (apps: readonly HarnessAppView[], marketplace: string): HarnessAppView | undefined =>
  apps.find((a) => a.app.marketplaces.includes(marketplace));
