/** Minimal glob: `*` matches any run, `?` one char, everything else literal. Anchored. */
const escapeRegExp = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

export const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    "^" +
      glob
        .split(/([*?])/)
        .map((part) => (part === "*" ? ".*" : part === "?" ? "." : escapeRegExp(part)))
        .join("") +
      "$",
  );

export const matchesAny = (globs: readonly string[], name: string): boolean =>
  globs.some((g) => globToRegExp(g).test(name));
