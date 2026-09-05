import { type Option, none, some } from "../lib/result";

/** How an agent turns skill descriptions into startup context, and how it trims them. */
export type ListingRule =
  | { readonly kind: "claude"; readonly budgetFraction: number; readonly maxDescChars: number }
  | { readonly kind: "codex"; readonly budgetFraction: number; readonly fallbackChars: number }
  | { readonly kind: "plain" };

export type Agent = {
  readonly id: string;
  readonly name: string;
  /** User-level skills directory on a host, given that host's $HOME (POSIX path). */
  readonly userDir: (home: string) => string;
  readonly listing: ListingRule;
  /** Other directories this agent also reads (legacy / duplicate sources) — reported, never managed. */
  readonly alsoReads: readonly ((home: string) => string)[];
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
  },
  {
    id: "codex",
    name: "Codex",
    userDir: under(".agents/skills"), // Codex ≥0.9x scans $HOME/.agents/skills and follows symlinks
    listing: { kind: "codex", budgetFraction: 0.02, fallbackChars: 8000 },
    alsoReads: [under(".codex/skills")], // legacy dir; copies here load twice
  },
  { id: "cursor", name: "Cursor", userDir: under(".cursor/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "gemini", name: "Gemini CLI", userDir: under(".gemini/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "antigravity", name: "Antigravity", userDir: under(".gemini/antigravity/skills"), listing: { kind: "plain" }, alsoReads: [] },
  { id: "opencode", name: "OpenCode", userDir: under(".config/opencode/skills"), listing: { kind: "plain" }, alsoReads: [] },
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
