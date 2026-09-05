import pc from "picocolors";
import { lstat, readdir, readlink, realpath, rename, symlink, rm, cp, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { agentById } from "../core/agents";
import { buildSkill } from "../core/skill";
import { readFile } from "node:fs/promises";
import { homeDir } from "../shell/paths";
import { out, die, withApp } from "./common";

type AdoptOutcome =
  | { kind: "moved"; name: string; from: string }
  | { kind: "relinked"; name: string; from: string }
  | { kind: "skipped"; name: string; reason: string };

const moveDir = async (from: string, to: string): Promise<void> => {
  try {
    await rename(from, to);
  } catch (e) {
    if ((e as { code?: string }).code !== "EXDEV") throw e;
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    await rm(from, { recursive: true, force: true });
  }
};

/**
 * Adopt one path: a real skill dir, or a symlink to one outside the store.
 * Result: the skill lives in the store, every touched location is a direct symlink to it.
 */
const adoptPath = async (path: string, storeDir: string, knownHash: Map<string, string>): Promise<AdoptOutcome> => {
  const name = basename(path.replace(/\/$/, ""));
  const st = await lstat(path).catch(() => undefined);
  if (!st) return { kind: "skipped", name, reason: "does not exist" };
  const real = await realpath(path).catch(() => undefined);
  if (!real) return { kind: "skipped", name, reason: "broken symlink" };
  const storeReal = await realpath(storeDir);
  const target = `${storeReal}/${name}`;
  if (real.startsWith(`${storeReal}/`)) {
    if (st.isSymbolicLink() && (await readlink(path)) !== target) {
      await rm(path); await symlink(target, path);
      return { kind: "relinked", name, from: path };
    }
    return { kind: "skipped", name, reason: "already in store" };
  }
  const md = await readFile(`${real}/SKILL.md`, "utf8").catch(() => undefined);
  if (md === undefined) return { kind: "skipped", name, reason: "no SKILL.md" };
  const hash = buildSkill(name, real, md, []).contentHash;
  const existing = knownHash.get(name);
  if (existing !== undefined && existing !== hash) return { kind: "skipped", name, reason: "store has a different version (resolve by hand or `skm pull`)" };
  if (existing === undefined) {
    await moveDir(real, target);
    knownHash.set(name, hash);
  } else {
    await rm(real, { recursive: true, force: true }); // identical content: drop the copy
  }
  // whatever used to be at the real location now points at the store
  if (!st.isSymbolicLink()) {
    await symlink(target, real);
  } else {
    await symlink(target, real).catch(() => undefined);
    await rm(path); await symlink(target, path);
  }
  return { kind: "moved", name, from: real };
};

export const runAdopt = async (paths: string[], fromAgents: string[]): Promise<void> =>
  withApp(async (app) => {
    const home = homeDir();
    const agentPaths = await Promise.all(
      fromAgents.map(async (id) => {
        const a = agentById(id);
        if (!a.some) return die(`unknown agent ${id}`);
        const dir = a.value.userDir(home);
        const names = await readdir(dir).catch(() => [] as string[]);
        return names.filter((n) => !n.startsWith(".")).map((n) => `${dir}/${n}`);
      }),
    );
    const all = [...paths.map((p) => resolve(p)), ...agentPaths.flat()];
    if (all.length === 0) return die("nothing to adopt: pass paths or --from <agent>");
    await mkdir(app.storeDir, { recursive: true });
    const known = new Map(app.skills.map((s) => [s.name, s.contentHash]));
    const results = await all.reduce<Promise<AdoptOutcome[]>>(async (accP, p) => [...(await accP), await adoptPath(p, app.storeDir, known)], Promise.resolve([]));
    results.forEach((r) => {
      switch (r.kind) {
        case "moved": return out(`${pc.green("adopted")}  ${r.name}  ${pc.dim(`← ${r.from}`)}`);
        case "relinked": return out(`${pc.cyan("relinked")} ${r.name}  ${pc.dim(r.from)}`);
        case "skipped": return out(`${pc.dim("skipped")}  ${r.name}  ${pc.dim(r.reason)}`);
      }
    });
    const moved = results.filter((r) => r.kind === "moved").length;
    out(pc.bold(`\n${moved} adopted into ${app.storeDir}`));
    void dirname;
  });
