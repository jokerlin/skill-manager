import pc from "picocolors";
import { mkdir, readFile, readdir, lstat } from "node:fs/promises";
import { AGENTS } from "../core/agents";
import { defaultConfig, parseConfig } from "../core/config";
import { configPathFor } from "../shell/app";
import { expandHome, homeDir, skmHome } from "../shell/paths";
import { out, saveConfig } from "./common";

/** Real (non-symlink) skill dirs currently living inside an agent's user dir. */
const realSkillDirs = async (dir: string): Promise<string[]> => {
  const names = await readdir(dir).catch(() => [] as string[]);
  const checks = await Promise.all(
    names.map(async (n) => {
      const st = await lstat(`${dir}/${n}`).catch(() => undefined);
      const hasMd = st?.isDirectory() ? await lstat(`${dir}/${n}/SKILL.md`).then(() => true).catch(() => false) : false;
      return st && st.isDirectory() && !st.isSymbolicLink() && hasMd ? [n] : [];
    }),
  );
  return checks.flat();
};

export const runInit = async (): Promise<void> => {
  const skm = skmHome();
  const path = configPathFor(skm);
  await mkdir(`${skm}/skills`, { recursive: true });
  const existing = await readFile(path, "utf8").catch(() => undefined);
  if (existing === undefined) {
    await saveConfig(path, defaultConfig());
    out(`${pc.green("created")} ${path}`);
  } else {
    const parsed = parseConfig(existing);
    out(`${pc.dim("exists")} ${path}${parsed.ok ? "" : pc.red(" (invalid — fix it before continuing)")}`);
  }
  out(`store: ${skm}/skills`);
  const home = homeDir();
  const found = await Promise.all(
    AGENTS.map(async (a) => ({ agent: a, dir: a.userDir(home), skills: await realSkillDirs(expandHome(a.userDir(home))) })),
  );
  const nonEmpty = found.filter((f) => f.skills.length > 0);
  if (nonEmpty.length === 0) return out(pc.dim("no unmanaged skills found in agent directories"));
  out("");
  out(pc.bold("unmanaged skills found (real directories inside agent dirs):"));
  nonEmpty.forEach((f) => out(`  ${f.agent.id.padEnd(12)} ${f.dir}  ${pc.dim(`${f.skills.length} skills`)}`));
  out("");
  out(`move them into the store and leave symlinks behind:  ${pc.cyan(`skm adopt --from ${nonEmpty.map((f) => f.agent.id).join(" --from ")}`)}`);
};
