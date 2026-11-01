import { useEffect, useState } from "react";
import type { Theme } from "@shared/types";
import { create } from "zustand";

type ThemeState = { readonly theme: Theme; readonly setTheme: (t: Theme) => void };
export const useThemePref = create<ThemeState>()((set) => ({ theme: "system", setTheme: (theme) => set({ theme }) }));

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

/** "light" | "dark" after resolving "system" against the OS; follows OS changes live. */
export const useResolvedTheme = (): "light" | "dark" => {
  const theme = useThemePref((s) => s.theme);
  const [osDark, setOsDark] = useState(() => media().matches);
  useEffect(() => {
    const m = media();
    const h = (e: MediaQueryListEvent) => setOsDark(e.matches);
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, []);
  return theme === "system" ? (osDark ? "dark" : "light") : theme;
};

/** Mirror the resolved theme onto <html class="dark">. */
export const useApplyTheme = (): void => {
  const resolved = useResolvedTheme();
  useEffect(() => { document.documentElement.classList.toggle("dark", resolved === "dark"); }, [resolved]);
};
