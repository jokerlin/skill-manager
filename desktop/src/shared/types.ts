// Mirrors of the skm CLI's --json output. The CLI is the engine; the app only renders and asks it to act.

export type SkillRow = {
  readonly name: string;
  readonly description: string;
  readonly descChars: number;
  readonly descTokens: number;
  readonly bodyTokens: number;
  readonly bodyLines: number;
  readonly files: number;
  readonly bytes: number;
  readonly violations: readonly string[];
  readonly hash: string;
  /** host → agent → wanted by config rules */
  readonly targets: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
};

export type ConsumedEntry = { readonly name: string; readonly kind: "managed" | "dir" | "foreign-link" | "broken-link"; readonly target?: string };

export type EffectiveEntry = {
  readonly name: string;
  readonly source: "user" | "legacy" | "builtin" | "plugin";
  readonly sourceText: string;
  readonly storage: string;
  readonly owner: string;
  readonly path: string;
  readonly version: string | null;
  readonly enabled: string;
  readonly promptVisible: boolean;
  readonly listingChars: number;
  readonly listingTokens: number;
  readonly bodyTokens: number;
  readonly hash: string;
  readonly listing: string;
  readonly plugin: string | null;
  readonly marketplace: string | null;
  readonly dir: string | null;
};

export type SourceCounts = { readonly user: number; readonly legacy: number; readonly builtin: number; readonly plugin: number };

export type PluginStatus = {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly enabled: "on" | "off";
  readonly version: string | null;
  readonly dir: string | null;
  readonly skills: readonly string[];
  readonly cachedVersions: readonly string[];
};

export type AgentBudget = {
  readonly usedTokens: number;
  readonly budgetTokens: number | null;
  readonly droppedCount: number;
  readonly overBy: number;
  readonly note: string;
  readonly trim: "dropped" | "shortened" | "omitted" | null;
};

export type AgentStatus = {
  readonly dir: string;
  readonly exists: boolean;
  readonly consumed: readonly ConsumedEntry[];
  readonly desired: readonly string[];
  readonly alsoReads: Readonly<Record<string, readonly string[]>>;
  readonly effective: readonly EffectiveEntry[];
  readonly counts: SourceCounts;
  readonly plugins: readonly PluginStatus[];
  readonly budget: AgentBudget | null;
};

export type HostFinding = { readonly kind: string; readonly text: string };

export type HostStatus = {
  readonly host: string;
  readonly ssh: string | null;
  readonly reachable: boolean;
  readonly error?: string;
  readonly probedAt: string | null;
  readonly lastError?: { readonly at: string; readonly error: string };
  readonly home?: string;
  readonly store?: readonly string[];
  readonly remoteOnly?: readonly string[];
  readonly tools?: Readonly<Record<string, string>>;
  readonly agents?: Readonly<Record<string, AgentStatus>>;
  readonly drift?: readonly string[];
  readonly findings?: readonly HostFinding[];
};

export type PlanOp = {
  readonly op: string;
  readonly text: string;
  readonly agent: string | null;
  readonly skill: string | null;
  readonly plugin: string | null;
  readonly mutation: boolean;
};

export type HostPlan = { readonly host: string; readonly reachable: boolean; readonly error?: string; readonly probedAt?: string | null; readonly ops: readonly PlanOp[] };

export type PluginCell = {
  readonly host: string;
  readonly agent: string;
  readonly enabled: "on" | "off" | null;
  readonly version: string | null;
  readonly scopes: readonly string[];
  readonly skills: readonly string[];
  readonly marketplace: string | null;
  readonly source: "portable" | "local-dir" | "unknown" | null;
  /** config policy says it should be enabled here; null = not declared in config.yaml */
  readonly wanted: boolean | null;
};

export type PluginRow = {
  readonly name: string;
  readonly ids: readonly string[];
  readonly versions: readonly string[];
  readonly drift: boolean;
  readonly policy: { readonly enabled: boolean; readonly marketplace: Readonly<Record<string, string>> } | null;
  readonly cells: readonly PluginCell[];
};

export type PluginsReport = {
  readonly hosts: readonly { readonly host: string; readonly reachable: boolean; readonly probedAt: string | null; readonly error: string | null }[];
  readonly grid: readonly { readonly host: string; readonly agent: string }[];
  readonly plugins: readonly PluginRow[];
};

export type HostDetail = { readonly id: string; readonly ssh: string | null; readonly agents: readonly string[] | null; readonly skm: string };

export type ConfigSummary = {
  readonly hosts: readonly string[];
  readonly hostDetails: readonly HostDetail[];
  readonly agents: readonly string[];
  readonly store: string;
  readonly configPath: string;
  readonly backupBeforeApply: boolean;
  readonly contextTokens: number;
  readonly plugins: readonly string[];
  readonly owned: readonly string[];
  /** store path as written in config.yaml (`~/.skm/skills`); `store` is the expanded path */
  readonly storeRaw: string;
  /** id of the host without an ssh alias: the machine skm runs on */
  readonly hub: string;
  readonly agentCatalog: readonly AgentInfo[];
  readonly extensions: readonly ExtensionInfo[];
  readonly extensionsDir: string;
};

/** One extension (built-in or a YAML file in extensionsDir): what it adds, or why it is not loaded. */
export type ExtensionInfo = {
  readonly name: string;
  /** file path, or "builtin" */
  readonly source: string;
  readonly enabled: boolean;
  readonly agents: readonly string[];
  /** skill sources it defines, for upstreams.<name>.source (absent from skm older than 0.6) */
  readonly sources?: readonly string[];
  /** problems that did not stop the file from loading (e.g. a key skm no longer reads) */
  readonly warnings: readonly string[];
  readonly error: string | null;
};

/** One agent skm knows: built-in defaults plus the user's overrides (null = built-in value). */
export type AgentInfo = {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** the extension that adds this agent; null for the built-in ones */
  readonly extension: string | null;
  readonly bin: string;
  readonly defaultDir: string;
  readonly defaultUpdate: string;
  readonly dir: string | null;
  readonly update: string | null;
};

export type HostPatch = {
  readonly from?: string;
  readonly id: string;
  readonly ssh: string | null;
  readonly agents: readonly string[] | null;
  readonly skm?: string;
};

export type ConfigPatch = {
  readonly hosts?: readonly HostPatch[];
  readonly agents?: readonly string[];
  readonly agentOverrides?: Readonly<Record<string, { readonly dir: string | null; readonly update: string | null }>>;
  readonly store?: string;
  readonly backupBeforeApply?: boolean;
  readonly contextTokens?: number;
};

/** `skm harness --json`: each host's agent CLI versions. */
export type HarnessResult =
  | { readonly kind: "missing"; readonly agent: string }
  | { readonly kind: "checked"; readonly agent: string; readonly version: string; readonly latest?: string }
  | { readonly kind: "updated"; readonly agent: string; readonly before: string; readonly after: string; readonly ok: boolean };

export type HarnessHost = {
  readonly host: string;
  readonly at: string;
  readonly error: string | null;
  readonly results: readonly HarnessResult[];
  /** tool id (agent or app) → short version, null when it is not installed */
  readonly versions: Readonly<Record<string, string | null>>;
  /** app id → the newest version its update feed offers this host */
  readonly latest?: Readonly<Record<string, string>>;
};

/** An agent's desktop app that writes plugin marketplaces of its own (e.g. ChatGPT.app for Codex). */
export type HarnessApp = { readonly id: string; readonly agent: string; readonly name: string; readonly bundle: string; readonly marketplaces: readonly string[] };

export type HarnessReport = {
  readonly agents: readonly { readonly id: string; readonly bin: string; readonly update: string }[];
  readonly apps?: readonly HarnessApp[];
  readonly hosts: readonly HarnessHost[];
};

/** `skm upstream --json`: skills whose store copy comes from a git repo. */
export type UpstreamState = "current" | "behind" | "modified" | "unbased" | "absent" | "gone";
export type UpstreamChange = { readonly commit: string; readonly date: string; readonly subject: string };
export type UpstreamSkill = {
  readonly skill: string;
  readonly state: UpstreamState;
  /** the upstream version skm last wrote (from the lock); null = no record. `rev` is a commit, or a source's version */
  readonly base: { readonly rev: string; readonly label: string } | null;
  /** the version an update writes (a source gives each skill its own; absent from skm older than 0.6) */
  readonly target?: { readonly rev: string; readonly label: string };
  /** upstream commits between base and target that touch this skill, newest first */
  readonly changes: readonly UpstreamChange[];
};
export type Upstream = {
  readonly name: string;
  /** git repo, or a source an extension defines (absent from skm older than 0.6: git) */
  readonly kind?: "git" | "source";
  /** the repo URL, or the source id and its params */
  readonly repo: string;
  readonly source?: string | null;
  readonly ref: string | null;
  /** the one version every skill targets (git); null for a source, where each skill has its own */
  readonly target: { readonly rev: string; readonly label: string } | null;
  readonly warning: string | null;
  readonly error: string | null;
  readonly skills: readonly UpstreamSkill[];
  /** skill dirs the repo has that upstreams.<name>.skills does not list */
  readonly unlisted: readonly string[];
};
export type UpstreamsReport = { readonly upstreams: readonly Upstream[] };

/** `skm upstream update -y --json` */
export type UpstreamUpdateResult = {
  readonly backup: string | null;
  readonly outcomes: readonly { readonly upstream: string; readonly skill: string; readonly from: string | null; readonly to: string; readonly result: "updated" | "skipped" | "refused" | "failed"; readonly reason: string }[];
  readonly errors: readonly string[];
};

/** NDJSON events from `skm sync --events` / `skm plugin update --events`. */
export type ApplyEvent =
  | { readonly type: "host-start"; readonly host: string; readonly ops: number }
  | { readonly type: "backup"; readonly host: string; readonly ts: string; readonly dir: string; readonly hubCopy: string | null }
  | { readonly type: "log"; readonly host: string; readonly line: string }
  | { readonly type: "warn"; readonly host: string; readonly line: string }
  | { readonly type: "host-done"; readonly host: string; readonly ok: boolean; readonly rsynced: number; readonly applied: number; readonly commandsOk: number; readonly commandsFailed: number; readonly failures: readonly string[]; readonly error: string | null }
  | { readonly type: "verified"; readonly pending: readonly string[] };

// ---------- IPC ----------

export type Theme = "system" | "light" | "dark";
export type Locale = "en" | "zh";

/** Per-machine app preferences, kept by the main process in userData/prefs.json. */
export type Prefs = {
  readonly locale: Locale | "system";
  readonly theme: Theme;
  /** argv prefix for the CLI, e.g. "~/.local/bin/skm" or "bun run /repo/bin/skm.ts"; "" = search the usual places */
  readonly skmCommand: string;
  /** check GitHub releases for a newer build once each time the app starts */
  readonly autoUpdate: boolean;
};

export type RunResult = { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly code: number | null; readonly stderr: string; readonly notFound: boolean };

/** One line of a streamed command, or its end. */
export type StreamMessage =
  | { readonly id: string; readonly kind: "line"; readonly line: string }
  | { readonly id: string; readonly kind: "end"; readonly code: number | null; readonly stderr: string };

/** What the app knows about itself, for the About panel. */
export type AppInfo = {
  readonly name: string;
  readonly version: string;
  readonly author: string;
  readonly homepage: string;
  readonly electron: string;
  readonly platform: string;
  readonly arch: string;
};

/** The updater's state machine, owned by the main process. */
export type UpdateState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "current"; readonly checkedAt: string }
  /** `asset` null = install by hand from `url`; `manual` says why (no build for this Mac, an unsigned release, a build without an update key) */
  | { readonly kind: "available"; readonly version: string; readonly notes: string; readonly url: string; readonly asset: string | null; readonly manual?: "no-asset" | "unsigned" | "no-key" }
  | { readonly kind: "downloading"; readonly version: string; readonly percent: number }
  | { readonly kind: "ready"; readonly version: string }
  | { readonly kind: "error"; readonly message: string };

export type SkmApi = {
  readonly run: (args: readonly string[], stdin?: string) => Promise<RunResult>;
  /** Starts a streamed command; lines arrive through onStream with the returned id. */
  readonly stream: (args: readonly string[]) => Promise<string>;
  readonly onStream: (cb: (m: StreamMessage) => void) => () => void;
  readonly getPrefs: () => Promise<Prefs>;
  readonly setPrefs: (p: Partial<Prefs>) => Promise<Prefs>;
  readonly resolvedCommand: () => Promise<string | null>;
  readonly systemLocale: () => Promise<string>;
  readonly openPath: (path: string) => Promise<void>;
  /** create the directory when missing, then open it in Finder */
  readonly openDir: (path: string) => Promise<void>;
  readonly revealPath: (path: string) => Promise<void>;
  /** App-menu commands (⌘, ⌘R ⌘K …) forwarded to the renderer. */
  readonly onMenu: (cb: (command: MenuCommand) => void) => () => void;
  readonly platform: string;
  readonly appInfo: () => Promise<AppInfo>;
  readonly updateState: () => Promise<UpdateState>;
  readonly checkForUpdates: () => Promise<UpdateState>;
  readonly downloadUpdate: () => Promise<UpdateState>;
  /** quit, swap in the downloaded build, relaunch */
  readonly installUpdate: () => Promise<void>;
  readonly onUpdate: (cb: (s: UpdateState) => void) => () => void;
  readonly openExternal: (url: string) => Promise<void>;
};

export type MenuCommand = "about" | "check-updates" | "settings" | "refresh" | "palette" | "review" | "apply" | "view-skills" | "view-plugins" | "view-hosts";
