import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Locale, Prefs, Theme } from "../shared/types";

export const DEFAULT_PREFS: Prefs = { locale: "system", theme: "system", skmCommand: "", autoUpdate: true };

const LOCALES: readonly (Locale | "system")[] = ["system", "en", "zh"];
const THEMES: readonly Theme[] = ["system", "light", "dark"];

/** Keep only known keys with valid values; anything else falls back to the default. */
export const sanitize = (raw: unknown): Prefs => {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const locale = LOCALES.find((l) => l === r["locale"]) ?? DEFAULT_PREFS.locale;
  const theme = THEMES.find((t) => t === r["theme"]) ?? DEFAULT_PREFS.theme;
  const skmCommand = typeof r["skmCommand"] === "string" ? r["skmCommand"] : DEFAULT_PREFS.skmCommand;
  const autoUpdate = typeof r["autoUpdate"] === "boolean" ? r["autoUpdate"] : DEFAULT_PREFS.autoUpdate;
  return { locale, theme, skmCommand, autoUpdate };
};

/** Reads prefs; when the file is missing, falls back to `legacy` (the folder used before the app was renamed from skm). */
export const readPrefs = async (file: string, legacy?: string): Promise<Prefs> => {
  const text = (await readFile(file, "utf8").catch(() => undefined)) ?? (legacy === undefined ? undefined : await readFile(legacy, "utf8").catch(() => undefined));
  if (text === undefined) return DEFAULT_PREFS;
  try { return sanitize(JSON.parse(text)); } catch { return DEFAULT_PREFS; }
};

export const writePrefs = async (file: string, p: Prefs): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(p, null, 2));
};
