/** Quote a string for POSIX sh. Always single-quoted; embedded quotes become '\'' . */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Join argv into one sh command line. */
export const shJoin = (argv: readonly string[]): string => argv.map(shQuote).join(" ");
