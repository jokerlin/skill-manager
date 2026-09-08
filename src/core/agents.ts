import { type Option, none, some } from "../lib/result";

/** How an agent turns skill descriptions into startup context, and how it trims them. */
export type ListingRule =
  | { readonly kind: "claude"; readonly budgetFraction: number; readonly maxDescChars: number }
  /** codex-rs/ext/skills/src/render.rs: 2% of the window in tokens, `[skills] max_context_tokens` capped at maxConfiguredTokens, fallbackChars when the window is unknown; ⌈bytes/bytesPerToken⌉ per line; descriptions cut at maxDescChars. */
  | { readonly kind: "codex"; readonly budgetFraction: number; readonly fallbackChars: number; readonly maxConfiguredTokens: number; readonly bytesPerToken: number; readonly maxDescChars: number }
  | { readonly kind: "plain" };

export type Agent = {
  readonly id: string;
  readonly name: string;
  /** User-level skills directory on a host, given that host's $HOME (POSIX path). */
  readonly userDir: (home: string) => string;
  readonly listing: ListingRule;
  /** Other directories this agent also reads (legacy / duplicate sources) — reported, never managed. */
  readonly alsoReads: readonly ((home: string) => string)[];
  /**
   * What happens when a skill name is present in `userDir` and an `alsoReads` dir. Absent (Codex): every copy loads.
   * `"user-dir-first"` (Pi): the registry keeps the first root's copy by name — the user-dir copy — and the alsoReads copy is skipped (shadowed).
   */
  readonly duplicates?: "user-dir-first";
  /** Plugin system, when the agent has one: cache root holding <marketplace>/<plugin>/<version>/skills/*. */
  readonly plugins?: { readonly cache: (home: string) => string };
  /** Directory of vendor-shipped skills the agent always loads (e.g. ~/.codex/skills/.system). */
  readonly builtinDir?: (home: string) => string;
};

const under = (rel: string) => (home: string) => `${home}/${rel}`;

// Supported products and their user-level skill directories.
export const AGENTS: readonly Agent[] = [
  {
    id: "claude",
    name: "Claude Code",
    userDir: under(".claude/skills"),
    listing: { kind: "claude", budgetFraction: 0.01, maxDescChars: 1536 },
    alsoReads: [],
    plugins: { cache: under(".claude/plugins/cache") }, // enabled via ~/.claude/settings.json enabledPlugins; active version in plugins/installed_plugins.json
  },
  {
    id: "codex",
    name: "Codex",
    userDir: under(".agents/skills"), // Codex ≥0.9x scans $HOME/.agents/skills and follows symlinks
    listing: { kind: "codex", budgetFraction: 0.02, fallbackChars: 8000, maxConfiguredTokens: 10_000, bytesPerToken: 4, maxDescChars: 1024 },
    alsoReads: [under(".codex/skills")], // legacy dir; copies here load twice
    plugins: { cache: under(".codex/plugins/cache") }, // switched in ~/.codex/config.toml [plugins."name@mk"] enabled (default true)
    builtinDir: under(".codex/skills/.system"),
  },
  {
    id: "pi",
    name: "Pi",
    userDir: under(".pi/agent/skills"), // pi docs/skills.md: ~/.pi/agent/skills, ~/.agents/skills, project .pi/skills and .agents/skills
    listing: { kind: "plain" },
    alsoReads: [under(".agents/skills")], // pi ≥0.8x also scans the shared Codex dir; nested SKILL.md only, root .md files ignored there
    duplicates: "user-dir-first", // loadSkills() keeps the first copy by name (user dir loads first) and reports the other as a "collision" at startup
  },
];

export const agentById = (id: string): Option<Agent> => {
  const a = AGENTS.find((x) => x.id === id);
  return a ? some(a) : none;
};

export const agentIds = (): readonly string[] => AGENTS.map((a) => a.id);
