import type { Locale } from "@shared/types";
import { create } from "zustand";
import { en } from "./en";
import { zh } from "./zh";

export type Key = keyof typeof en;
export type Dict = Readonly<Record<Key, string>>;

const DICTS: Readonly<Record<Locale, Dict>> = { en, zh };

type I18n = {
  readonly locale: Locale;
  /** names that come from data, not the dictionaries (e.g. `agent.opencode` for an agent an extension adds) */
  readonly extra: Readonly<Record<string, string>>;
  readonly setLocale: (l: Locale) => void;
  readonly setExtra: (extra: Readonly<Record<string, string>>) => void;
};

export const useI18n = create<I18n>()((set) => ({ locale: "en", extra: {}, setLocale: (locale) => set({ locale }), setExtra: (extra) => set({ extra }) }));

/** `{name}` placeholders are replaced from params; a missing param keeps the placeholder visible. */
export const format = (text: string, params: Readonly<Record<string, string | number>> = {}): string =>
  text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));

export const translate = (locale: Locale, key: Key, params?: Readonly<Record<string, string | number>>): string =>
  format(DICTS[locale][key] ?? useI18n.getState().extra[key] ?? key, params);

/** Hook: `const t = useT(); t("skills.title")`. Re-renders on locale change. */
export const useT = () => {
  const locale = useI18n((s) => s.locale);
  useI18n((s) => s.extra);
  return (key: Key, params?: Readonly<Record<string, string | number>>) => translate(locale, key, params);
};

export const resolveLocale = (pref: Locale | "system", system: string): Locale => (pref === "system" ? (system.toLowerCase().startsWith("zh") ? "zh" : "en") : pref);

/** Relative time like "3m ago" / "3 分钟前". */
export const ago = (locale: Locale, iso: string | null | undefined, now: number = Date.now()): string => {
  if (!iso) return translate(locale, "time.never");
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return translate(locale, "time.justNow");
  const m = Math.round(s / 60);
  if (m < 60) return translate(locale, "time.minutes", { n: m });
  const h = Math.round(m / 60);
  if (h < 36) return translate(locale, "time.hours", { n: h });
  return translate(locale, "time.days", { n: Math.round(h / 24) });
};
