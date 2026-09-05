import type { HostConfig } from "../core/config";
import { backupScript, listBackupsScript } from "../core/scripts";
import { shPath } from "../core/scripts";
import { type Result, err, ok } from "../lib/result";
import { type HostError } from "./probe";
import { type Runner, rsyncMirror, runError } from "./runner";
import { nowStamp } from "./paths";

export type BackupInfo = { readonly host: string; readonly ts: string; readonly dir: string /* on host */; readonly hubCopy: string | undefined };

const rel = (p: string): string => (p.startsWith("~/") ? p.slice(2) : p);

/** Snapshot `paths` on the host; for ssh hosts also mirror the snapshot into <hubSkm>/backups/<host>/<ts>. */
export const backupHost = async (
  h: HostConfig,
  runner: Runner,
  paths: readonly string[],
  hubSkm: string,
  ts: string = nowStamp(),
): Promise<Result<BackupInfo, HostError>> => {
  const r = await runner.sh(backupScript({ skm: h.skm, ts, paths }), { timeoutMs: 600_000 });
  if (!r.ok) return err({ kind: "step-failed", host: h.id, step: "backup", detail: runError(r.error) });
  const line = r.value.stdout.split("\n").find((l) => l.startsWith("backup\t"));
  const dir = line?.split("\t")[1] ?? `${h.skm}/backups/${ts}`;
  if (runner.kind === "local") return ok({ host: h.id, ts, dir, hubCopy: undefined });
  const hubCopy = `${hubSkm}/backups/${h.id}/${ts}`;
  const m = await rsyncMirror(runner.rsyncPath(`${rel(h.skm)}/backups/${ts}`), hubCopy);
  return m.ok
    ? ok({ host: h.id, ts, dir, hubCopy })
    : err({ kind: "step-failed", host: h.id, step: "backup copy to hub", detail: runError(m.error) });
};

export const restoreHost = async (h: HostConfig, runner: Runner, ts: string): Promise<Result<string, HostError>> => {
  const r = await runner.sh(`sh ${shPath(`${h.skm}/backups/${ts}/restore.sh`)}\n`, { timeoutMs: 600_000 });
  return r.ok ? ok(r.value.stdout) : err({ kind: "step-failed", host: h.id, step: "restore", detail: runError(r.error) });
};

export const listBackups = async (h: HostConfig, runner: Runner): Promise<Result<{ ts: string; presentCount: number }[], HostError>> => {
  const r = await runner.sh(listBackupsScript(h.skm));
  if (!r.ok) return err({ kind: "unreachable", host: h.id, detail: runError(r.error) });
  return ok(
    r.value.stdout
      .split("\n")
      .filter((l) => l.includes("\t"))
      .map((l) => { const [ts = "", n = "0"] = l.split("\t"); return { ts, presentCount: Number(n) }; }),
  );
};
