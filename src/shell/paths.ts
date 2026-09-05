import { homedir } from "node:os";

export const homeDir = (): string => process.env["HOME"] ?? homedir();

/** Hub-side skm home: $SKM_HOME or ~/.skm */
export const skmHome = (): string => process.env["SKM_HOME"] ?? `${homeDir()}/.skm`;

export const expandHome = (p: string, home: string = homeDir()): string =>
  p === "~" ? home : p.startsWith("~/") ? `${home}/${p.slice(2)}` : p;

/** Compact timestamp for backup directory names: 20260906-031500 */
export const nowStamp = (d: Date = new Date()): string => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
