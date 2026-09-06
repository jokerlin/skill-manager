import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { type Result, err, ok } from "../lib/result";
import { type FileStat, type Skill, buildSkill } from "../core/skill";

export type StoreError = { readonly kind: "store-unreadable"; readonly dir: string; readonly message: string };

const walk = async (root: string, dir: string): Promise<FileStat[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((e) => e.name !== ".DS_Store")
      .map(async (e): Promise<FileStat[]> => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return walk(root, p);
        if (e.isFile() || e.isSymbolicLink()) {
          const s = await stat(p).catch(() => undefined);
          return s && s.isFile() ? [{ rel: relative(root, p), bytes: s.size }] : [];
        }
        return [];
      }),
  );
  return nested.flat();
};

export type StoreScan = { readonly skills: readonly Skill[]; readonly ignored: readonly string[] /* dirs without SKILL.md */ };

/** Read every `<dir>/<name>/SKILL.md` into a Skill. Missing store dir ⇒ empty scan. */
export const loadStore = async (dir: string): Promise<Result<StoreScan, StoreError>> => {
  const list = await readdir(dir, { withFileTypes: true }).catch((e: unknown) =>
    (e as { code?: string }).code === "ENOENT" ? [] : Promise.reject(e),
  ).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  if (!Array.isArray(list)) return err({ kind: "store-unreadable", dir, message: list.error });
  const results = await Promise.all(
    list
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("."))
      .map(async (e) => {
        const skillDir = join(dir, e.name);
        const text = await readFile(join(skillDir, "SKILL.md"), "utf8").catch(() => undefined);
        if (text === undefined) return { ignored: e.name };
        return { skill: buildSkill(e.name, skillDir, text, await walk(skillDir, skillDir)) };
      }),
  );
  return ok({
    skills: results.flatMap((r) => ("skill" in r ? [r.skill] : [])).sort((a, b) => a.name.localeCompare(b.name)),
    ignored: results.flatMap((r) => ("ignored" in r ? [r.ignored] : [])),
  });
};

/** Read one skill directory (any location: plugin cache, real dir, store) into a Skill named `name`. */
export const loadSkillDir = async (dir: string, name: string): Promise<Skill | undefined> => {
  const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  return buildSkill(name, dir, text, await walk(dir, dir).catch(() => []));
};
