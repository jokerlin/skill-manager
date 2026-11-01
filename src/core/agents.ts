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
  /**
   * Settings file whose `skills` array can switch off a skill the agent auto-discovers (`fileId` = the probe file id).
   * Lets a shared dir (~/.agents/skills) feed one agent and not another: skm writes `excludePattern(name)` there.
   */
  readonly excludes?: { readonly fileId: string; readonly file: (home: string) => string };
  /** The agent's own CLI: `--version` prints its version, `update` is the self-update command (it detects native / npm / brew installs). */
  readonly cli: { readonly bin: string; readonly update: string };
  /**
   * The agent's desktop app (built-in agents only), when it writes plugin marketplaces of its own (local dirs skm cannot refresh).
   * skm reads its version from the bundle and updates it from its Sparkle appcast; the app rewrites `marketplaces` on its next launch.
   */
  readonly app?: AgentApp;
  /** the extension that defined this agent; absent for the built-in ones */
  readonly extension?: string;
};

/** A macOS desktop app that ships plugins: bundle path, Sparkle feed, the marketplaces it writes, and a file it rewrites after an update. */
export type AgentApp = {
  readonly id: string;
  readonly name: string;
  readonly bundle: string;
  readonly feed: string;
  readonly marketplaces: readonly string[];
  /** `~/`-relative file whose content names the app version once the app has rewritten its marketplaces */
  readonly marker: string;
  /**
   * A follow-up download the app may start after launch: `file` (`~/`-relative) changes content when it is done,
   * `busy` (`~/`-relative glob) exists while it runs. skm keeps the app open until then.
   */
  readonly settle?: { readonly file: string; readonly busy: string };
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
    cli: { bin: "claude", update: "claude update" },
  },
  {
    id: "codex",
    name: "Codex",
    userDir: under(".agents/skills"), // Codex ≥0.9x scans $HOME/.agents/skills and follows symlinks
    listing: { kind: "codex", budgetFraction: 0.02, fallbackChars: 8000, maxConfiguredTokens: 10_000, bytesPerToken: 4, maxDescChars: 1024 },
    alsoReads: [under(".codex/skills")], // legacy dir; copies here load twice
    plugins: { cache: under(".codex/plugins/cache") }, // switched in ~/.codex/config.toml [plugins."name@mk"] enabled (default true)
    builtinDir: under(".codex/skills/.system"),
    cli: { bin: "codex", update: "codex update" },
    // the Codex desktop app ships as ChatGPT.app (bundle id com.openai.codex); it materializes openai-bundled
    // and installs the runtime that holds openai-primary-runtime. A host without the bundle reports "not installed".
    app: {
      id: "chatgpt",
      name: "ChatGPT",
      bundle: "/Applications/ChatGPT.app",
      feed: "https://persistent.oaistatic.com/codex-app-prod/appcast.xml",
      marketplaces: ["openai-bundled", "openai-primary-runtime"],
      marker: ".codex/.tmp/bundled-marketplaces/openai-bundled/.materialization-key",
      settle: { file: ".cache/codex-runtimes/codex-primary-runtime/runtime.json", busy: ".cache/codex-runtimes/codex-runtime-install-*" },
    },
  },
  {
    id: "pi",
    name: "Pi",
    userDir: under(".pi/agent/skills"), // pi docs/skills.md: ~/.pi/agent/skills, ~/.agents/skills, project .pi/skills and .agents/skills
    listing: { kind: "plain" },
    alsoReads: [under(".agents/skills")], // pi ≥0.8x also scans the shared Codex dir; nested SKILL.md only, root .md files ignored there
    duplicates: "user-dir-first", // loadSkills() keeps the first copy by name (user dir loads first) and reports the other as a "collision" at startup
    // pi ≥0.87 package-manager isEnabledByOverrides: a `-path` entry force-excludes an exact path, relative to ~/.agents for that dir and ~/.pi/agent for the user dir
    excludes: { fileId: "pi-settings", file: under(".pi/agent/settings.json") },
    cli: { bin: "pi", update: "pi update --all" }, // --all also updates installed extensions
  },
];

/** The `skills` entry that force-excludes one skill by name; `skills/<name>` matches in ~/.agents/skills and ~/.pi/agent/skills alike, on any $HOME. */
export const excludePattern = (name: string): string => `-skills/${name}`;

export const agentById = (id: string): Option<Agent> => {
  const a = AGENTS.find((x) => x.id === id);
  return a ? some(a) : none;
};

export const agentIds = (): readonly string[] => AGENTS.map((a) => a.id);

/** Per-agent settings from config.yaml `agentOverrides:`; each field replaces the built-in value. */
export type AgentOverride = { readonly dir: Option<string>; readonly update: Option<string> };

/** A `~/`-relative or absolute directory as a function of a host's $HOME. */
export const dirFn = (dir: string) => (home: string): string => (dir === "~" ? home : dir.startsWith("~/") ? `${home}/${dir.slice(2)}` : dir);

/** The registry entry with the user's overrides applied. Pure. */
export const withOverride = (a: Agent, o: AgentOverride | undefined): Agent =>
  o === undefined
    ? a
    : {
        ...a,
        ...(o.dir.some ? { userDir: dirFn(o.dir.value) } : {}),
        ...(o.update.some ? { cli: { ...a.cli, update: o.update.value } } : {}),
      };

/** Registry lookup with config overrides applied. `registry` = built-in agents plus extensions (defaults to the built-in ones). */
export const resolveAgent = (id: string, overrides: Readonly<Record<string, AgentOverride>>, registry: readonly Agent[] = AGENTS): Option<Agent> => {
  const a = registry.find((x) => x.id === id);
  return a !== undefined ? some(withOverride(a, overrides[id])) : none;
};
