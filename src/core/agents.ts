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
   * What happens when a skill name is present in `userDir` and an `alsoReads` dir. Absent (Codex, OpenCode): every copy loads.
   * `"user-dir-first"` (dsh): the registry keeps the first root's copy by name — the user-dir copy — and the alsoReads copy is skipped (shadowed).
   */
  readonly duplicates?: "user-dir-first";
  /** Plugin system, when the agent has one: cache root holding <marketplace>/<plugin>/<version>/skills/*. */
  readonly plugins?: { readonly cache: (home: string) => string };
  /** Directory of vendor-shipped skills the agent always loads (e.g. ~/.codex/skills/.system). */
  readonly builtinDir?: (home: string) => string;
};

const under = (rel: string) => (home: string) => `${home}/${rel}`;

// Directory table follows the Vercel `skills` CLI agent map (user-level) and vendor docs.
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
    userDir: under(".pi/agent/skills"), // pi.dev/docs/skills: only this dir + project .pi/skills unless settings.skills adds more
    listing: { kind: "plain" },
    alsoReads: [],
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    userDir: under(".dsh/skills"), // $DSH_HOME/skills (root rank 400); skill-filesystem also scans $DSH_AGENTS_HOME/skills (~/.agents, rank 500)
    listing: { kind: "plain" },
    alsoReads: [under(".agents/skills")],
    duplicates: "user-dir-first", // dsh-skill registry dedupes by name, first root by rank wins: a name in both dirs loads once, from ~/.dsh/skills
  },
  { id: "cursor", name: "Cursor", userDir: under(".cursor/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "gemini", name: "Gemini CLI", userDir: under(".gemini/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "antigravity", name: "Antigravity", userDir: under(".gemini/antigravity/skills"), listing: { kind: "plain" }, alsoReads: [] },
  {
    id: "opencode",
    name: "OpenCode",
    userDir: under(".config/opencode/skills"),
    listing: { kind: "plain" },
    // opencode.ai/docs/skills: also scans ~/.claude/skills and ~/.agents/skills — linking here would load skills a third time
    alsoReads: [under(".claude/skills"), under(".agents/skills")],
  },
  { id: "copilot", name: "GitHub Copilot", userDir: under(".copilot/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "windsurf", name: "Windsurf", userDir: under(".codeium/windsurf/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "kiro", name: "Kiro CLI", userDir: under(".kiro/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "droid", name: "Droid", userDir: under(".factory/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "goose", name: "Goose", userDir: under(".config/goose/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "crush", name: "Crush", userDir: under(".config/crush/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "qwen", name: "Qwen Code", userDir: under(".qwen/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "trae", name: "Trae", userDir: under(".trae/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "roo", name: "Roo Code", userDir: under(".roo/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "kilo", name: "Kilo Code", userDir: under(".kilocode/skills"), listing: { kind: "plain" }, alsoReads: [] },
];

export const agentById = (id: string): Option<Agent> => {
  const a = AGENTS.find((x) => x.id === id);
  return a ? some(a) : none;
};

export const agentIds = (): readonly string[] => AGENTS.map((a) => a.id);
