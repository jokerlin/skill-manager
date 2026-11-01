import type { Prefs } from "@shared/types";
import { create } from "zustand";
import { resolveLocale, useI18n } from "@/i18n";
import { useThemePref } from "@/lib/theme";

type PrefsState = {
  readonly prefs: Prefs | null;
  readonly systemLocale: string;
  readonly resolved: string | null;
  readonly load: () => Promise<void>;
  readonly update: (p: Partial<Prefs>) => Promise<Prefs>;
};

/** Push prefs into the i18n and theme stores. */
const mirror = (p: Prefs, system: string): void => {
  useI18n.getState().setLocale(resolveLocale(p.locale, system));
  useThemePref.getState().setTheme(p.theme);
};

export const usePrefs = create<PrefsState>()((set, get) => ({
  prefs: null,
  systemLocale: "en",
  resolved: null,
  load: async () => {
    const [prefs, systemLocale, resolved] = await Promise.all([window.skm.getPrefs(), window.skm.systemLocale(), window.skm.resolvedCommand()]);
    mirror(prefs, systemLocale);
    set({ prefs, systemLocale, resolved });
  },
  update: async (p) => {
    const prefs = await window.skm.setPrefs(p);
    mirror(prefs, get().systemLocale);
    const resolved = p.skmCommand !== undefined ? await window.skm.resolvedCommand() : get().resolved;
    set({ prefs, resolved });
    return prefs;
  },
}));
