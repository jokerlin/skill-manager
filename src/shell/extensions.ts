import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Config } from "../core/config";
import { type Extension, buildRegistry, parseExtension } from "../core/extensions";

export const extensionsDir = (skm: string): string => join(skm, "extensions");

/** Read every `*.yaml` / `*.yml` in `<skm>/extensions` (sorted, so load order is stable). A missing dir means none. */
export const readExtensions = async (skm: string): Promise<{ readonly ok: readonly Extension[]; readonly failed: readonly { name: string; source: string; error: string }[] }> => {
  const dir = extensionsDir(skm);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /\.ya?ml$/.test(n)).sort();
  const parsed = await Promise.all(names.map(async (n) => {
    const source = join(dir, n);
    const fallback = basename(n).replace(/\.ya?ml$/, "");
    const text = await readFile(source, "utf8").catch((e: unknown) => e instanceof Error ? e : new Error(String(e)));
    if (text instanceof Error) return { kind: "failed" as const, name: fallback, source, error: text.message };
    const r = parseExtension(text, source, fallback);
    return r.ok ? { kind: "ok" as const, value: r.value } : { kind: "failed" as const, name: fallback, source, error: r.error };
  }));
  return {
    ok: parsed.flatMap((p) => (p.kind === "ok" ? [p.value] : [])),
    failed: parsed.flatMap((p) => (p.kind === "failed" ? [{ name: p.name, source: p.source, error: p.error }] : [])),
  };
};

/** The config with its registry rebuilt from the built-in agents plus the user's files. */
export const withExtensions = async (skm: string, c: Config): Promise<Config> => {
  const files = await readExtensions(skm);
  return { ...c, registry: buildRegistry(files.ok, files.failed) };
};
