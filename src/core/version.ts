/**
 * Version ordering shared by the desktop app and the TUI. No imports, so the app can bundle it as is.
 */

const numeric = (v: string): readonly number[] | undefined => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : undefined);

const cmpNum = (a: readonly number[], b: readonly number[]): number =>
  Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) - (b[i] ?? 0)).find((d) => d !== 0) ?? 0;

/** The newest version when every version is dotted-numeric; null for commit hashes and mixed schemes (no order to trust). Pure. */
export const newestVersion = (versions: readonly string[]): string | null => {
  const parsed = versions.map((v) => ({ v, n: numeric(v) }));
  if (parsed.length === 0 || parsed.some((p) => p.n === undefined)) return null;
  return parsed.reduce((best, p) => (cmpNum(p.n ?? [], best.n ?? []) > 0 ? p : best)).v;
};
