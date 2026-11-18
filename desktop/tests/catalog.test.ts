import { describe, expect, test } from "bun:test";
import type { EffectiveEntry, HostStatus, SkillRow } from "../src/shared/types";
import { buildCatalog } from "../src/renderer/src/lib/catalog";

const entry = (name: string, owner: string, storage: string): EffectiveEntry => ({
  name, source: "user", sourceText: "user", storage, owner, path: `/h/.claude/skills/${name}`, version: null, enabled: "on", promptVisible: true,
  listingChars: 10, listingTokens: 3, bodyTokens: 100, hash: "h", listing: `${name} listing`, plugin: null, marketplace: null, dir: null,
});
const host = (effective: readonly EffectiveEntry[]): HostStatus =>
  ({ host: "home-mini", ssh: null, reachable: true, probedAt: null, agents: { claude: { effective } } }) as unknown as HostStatus;
const row = (name: string): SkillRow =>
  ({ name, description: "d", descChars: 1, descTokens: 1, bodyTokens: 1, bodyLines: 1, files: 1, bytes: 1, violations: [], hash: "h", targets: {} });

describe("desktop: catalog groups", () => {
  test("a link into the store the store list does not know yet stays in the store group, never unmanaged", () => {
    const items = buildCatalog([row("hunt")], [host([entry("hunt", "skm", "link→store"), entry("rea", "skm", "link→store"), entry("moshi", "manual", "dir")])]);
    const by = Object.fromEntries(items.map((i) => [i.name, i]));
    expect(items.length).toBe(3);
    expect(by.hunt?.group.kind).toBe("store");
    expect(by.hunt?.store?.name).toBe("hunt");
    expect(by.rea?.group.kind).toBe("store");
    expect(by.rea?.store).toBeNull();
    expect(by.rea?.loads["home-mini"]?.claude?.name).toBe("rea");
    expect(by.moshi?.group).toEqual({ kind: "unmanaged", owner: "manual" });
  });
});
