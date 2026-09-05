# skm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `skm`, a Bun/TypeScript CLI + Ink TUI that keeps one skill store (`~/.skm/skills`) as the single source of truth, symlinks it into every agent's user-level skills dir on the local machine and on SSH hosts (rsync mirror + remote symlinks), shows per-skill context cost, and evaluates skills with `claude -p` / `codex exec`.

**Architecture:** Pure core (`src/core`, `src/lib`) computes models, desired state, diffs (`Op[]`), shell scripts and budgets with no IO; a thin shell (`src/shell`) does filesystem, ssh/rsync and subprocess IO through a `Runner` interface so remote and local share one executor; `src/cli` and `src/tui` are presentation only.

**Tech Stack:** Bun 1.3, TypeScript, ts-pattern (exhaustive matching), yaml, gpt-tokenizer (o200k estimate), commander, Ink 7 + React 19, bun:test.

**Spec:** `docs/superpowers/specs/2026-09-06-skm-design.md`

## Global Constraints

- Functional style: pure core, `Result<T,E>` / `Option<T>` instead of exceptions or null, discriminated unions with exhaustive `match` (no default branch on sum types), map/filter/reduce over loops.
- Store path default `~/.skm/skills`; config `~/.skm/config.yaml`; backups `~/.skm/backups/<ts>/`; cache `~/.skm/cache/`.
- Remote hosts need only `ssh`, `rsync`, POSIX `sh` (no bash-isms in generated scripts).
- Never delete non-managed entries; never delete remote store dirs that the hub lacks.
- Agent Skills spec: name 1–64 chars `[a-z0-9-]`, no leading/trailing/double hyphen, must equal dir name; description 1–1024 chars.
- Claude listing budget: `contextTokens × skillListingBudgetFraction` (default 0.01) chars, per-skill cap `skillListingMaxDescChars` (default 1536). Codex: `contextTokens × 0.02` chars, 8000 when unknown.

---

## File Structure

```
package.json  tsconfig.json  README.md
bin/skm.ts                 CLI entry (commander) → src/cli/*
src/lib/result.ts          Result/Option ADTs + ok/err/map/andThen/all
src/lib/glob.ts            globToRegExp('kb-*') — pure
src/lib/sh.ts              shQuote() for POSIX sh
src/lib/tokens.ts          estimateTokens(text) via gpt-tokenizer
src/core/agents.ts         AGENTS registry: id, name, userDir(home), listing rule
src/core/frontmatter.ts    parseSkillMd(text) → Result<ParsedSkillMd, FrontmatterError>
src/core/skill.ts          Skill type, computeCost(), buildSkill()
src/core/config.ts         Config types, parseConfig(yamlText) → Result<Config, ConfigError>, defaultConfig()
src/core/scope.ts          desiredFor(config, skills, host, agent) → Set<string>; setScope() rule rewrite
src/core/inventory.ts      Entry/Inventory types, parseProbeOutput(text) → Inventory
src/core/plan.ts           planHost(desired, inventory, skills, hostId) → Op[]
src/core/scripts.ts        probeScript(), applyScript(ops), backupScript(), restoreScript()
src/core/budget.ts         simulateListing(agent, skills, settings) → BudgetReport
src/core/heuristics.ts     lintSkill(), findDuplicates(skills) → Insight[]
src/core/evalPrompt.ts     buildEvalPrompt(skills), EVAL_SCHEMA, parseEvalResponse()
src/shell/paths.ts         skmHome(), expandHome()
src/shell/store.ts         loadStore(dir) → Promise<Result<Skill[], StoreError>>
src/shell/runner.ts        Runner {run(cmd: string[], stdin?)}, localRunner, sshRunner(alias)
src/shell/probe.ts         probeHost(host, runner, config) → Result<Inventory>
src/shell/sync.ts          executePlan(host, ops, runner, opts) → SyncReport
src/shell/backup.ts        backupHost(), restoreHost(), listBackups()
src/shell/evaluators.ts    evalWithClaude(), evalWithCodex()
src/shell/cache.ts         evalCache get/set by content hash
src/shell/app.ts           loadApp() → AppState (config + store + hosts)
src/cli/*.ts               one file per command
src/tui/App.tsx            Ink root: views Skills / Hosts / Sync / Insights / Help
src/tui/views/*.tsx
tests/*.test.ts            bun test
```

---

### Task 1: Scaffold + Result/Option + glob + sh quoting

**Files:** Create `package.json`, `tsconfig.json`, `src/lib/result.ts`, `src/lib/glob.ts`, `src/lib/sh.ts`, `tests/lib.test.ts`

**Produces:**
```ts
type Result<T,E> = { ok: true; value: T } | { ok: false; error: E }
ok(v), err(e), map(r,f), mapErr(r,f), andThen(r,f), all(rs): Result<T[],E>, unwrapOr(r,d)
type Option<T> = { some: true; value: T } | { some: false }
some(v), none, fromNullable(x)
globToRegExp(glob: string): RegExp   // '*' → '.*', '?' → '.', rest escaped, anchored
matchesAny(globs: string[], name: string): boolean
shQuote(s: string): string           // single-quote wrap, embedded ' → '\''
```

- [ ] `bun init -y`; set `"type":"module"`, scripts `test: bun test`, `dev: bun run bin/skm.ts`, `build: bun build --compile bin/skm.ts --outfile dist/skm`; `bun add yaml ts-pattern gpt-tokenizer commander ink react ink-text-input picocolors; bun add -d @types/react @types/bun typescript ink-testing-library`
- [ ] Tests: `all([ok(1),err('x')])` is err; `globToRegExp('kb-*').test('kb-doc')` true, `'kbdoc'` false; `shQuote("a'b")` === `'a'\''b'`
- [ ] Implement; `bun test` green; commit `feat: scaffold + result/glob/sh libs`

### Task 2: Frontmatter parsing + spec validation

**Files:** `src/core/frontmatter.ts`, `tests/frontmatter.test.ts`

**Produces:**
```ts
type Frontmatter = { name: Option<string>; description: Option<string>; whenToUse: Option<string>; extra: Record<string, unknown> }
type FrontmatterError = { kind: 'no-frontmatter' } | { kind: 'yaml'; message: string } | { kind: 'not-object' }
type ParsedSkillMd = { frontmatter: Frontmatter; body: string }
parseSkillMd(text: string): Result<ParsedSkillMd, FrontmatterError>
type SpecViolation = { field: 'name'|'description'; kind: 'missing'|'too-long'|'bad-chars'|'dir-mismatch'|'empty'; detail: string }
validateSpec(fm: Frontmatter, dirName: string): SpecViolation[]
```
- [ ] Tests: parses `---\nname: a\ndescription: b\n---\nbody`; no frontmatter → err; `when_to_use` mapped; name `PDF-x` → bad-chars; name ≠ dir → dir-mismatch; description 1025 chars → too-long
- [ ] Implement with `yaml.parse`; commit `feat: frontmatter parse + spec validation`

### Task 3: Skill model + cost

**Files:** `src/lib/tokens.ts`, `src/core/skill.ts`, `tests/skill.test.ts`

**Produces:**
```ts
type FileStat = { rel: string; bytes: number }
type SkillCost = { descChars: number; descTokens: number; bodyTokens: number; bodyLines: number; bodyChars: number; totalBytes: number; fileCount: number }
type Skill = { name: string; dir: string; parsed: Result<ParsedSkillMd, FrontmatterError>; violations: SpecViolation[]; cost: SkillCost; files: FileStat[]; contentHash: string }
buildSkill(name: string, dir: string, skillMdText: string, files: FileStat[]): Skill
descriptionOf(s: Skill): string   // '' when missing
```
- [ ] Tests: cost.descChars equals description length; bodyLines counts; hash stable for same content
- [ ] Implement (`estimateTokens` = `encode(text).length` from gpt-tokenizer o200k); commit

### Task 4: Config + scope evaluation

**Files:** `src/core/config.ts`, `src/core/scope.ts`, `tests/config.test.ts`, `tests/scope.test.ts`

**Produces:**
```ts
type Selector = { kind: 'all' } | { kind: 'only'; globs: string[] } | { kind: 'except'; globs: string[] }
type HostConfig = { id: string; ssh: Option<string>; agents: Option<string[]>; skm: string }   // skm = '~/.skm' on that host
type Rule = { skills: string[]; hosts: Option<Selector>; agents: Option<Selector> }
type Config = { store: string; hosts: HostConfig[]; agents: string[]; defaults: { hosts: Selector; agents: Selector }; rules: Rule[]; eval: { agent: 'claude'|'codex'; model: Option<string> }; contextTokens: number }
parseConfig(text: string): Result<Config, ConfigError>
serializeConfig(c: Config): string
defaultConfig(): Config          // hosts: [local], agents: ['claude','codex']
scopeOf(config, skillName): { hosts: Selector; agents: Selector }   // defaults ⊕ rules (later wins per-field)
selects(sel: Selector, id: string): boolean
desiredFor(config, skillNames: string[], hostId, agentId): string[]  // sorted; respects host.agents
setScope(config, skillName, host, agent, on: boolean): Config       // rewrites rules: appends/merges an exact rule for that skill
```
- [ ] Tests: YAML from spec §3.2 parses; `kb-doc` excluded on devbox; `corp-x` only mini/devbox; host `devbox` agents [claude,codex] hides cursor; setScope toggles and is idempotent; serialize→parse round-trips
- [ ] Implement; commit

### Task 5: Agents registry + budget simulation

**Files:** `src/core/agents.ts`, `src/core/budget.ts`, `tests/budget.test.ts`

**Produces:**
```ts
type ListingRule = { kind:'claude'; budgetFraction:number; maxDescChars:number } | { kind:'codex'; budgetFraction:number; fallbackChars:number } | { kind:'plain' }
type Agent = { id: string; name: string; userDir: (home: string) => string; listing: ListingRule }
AGENTS: Agent[]  // claude ~/.claude/skills; codex ~/.agents/skills; cursor ~/.cursor/skills; gemini ~/.gemini/skills; opencode ~/.config/opencode/skills; copilot ~/.copilot/skills; windsurf ~/.codeium/windsurf/skills; antigravity ~/.gemini/antigravity/skills; kiro ~/.kiro/skills; universal ~/.agents/skills(alias)
agentById(id): Option<Agent>
type BudgetReport = { agentId; budgetChars: number; usedChars: number; perSkill: { name; chars; cappedChars; kept: boolean }[]; droppedCount: number; overBy: number }
simulateListing(agent: Agent, skills: Skill[], contextTokens: number, overrides?: { fraction?: number; maxDescChars?: number }): BudgetReport
```
- [ ] Tests: claude 200k → budget 2000 chars; 3 skills of 900 chars → 1 dropped (drop largest first as proxy for least-used); desc 2000 chars capped to 1536; codex 200k → 4000
- [ ] Implement; commit

### Task 6: Inventory + plan diff

**Files:** `src/core/inventory.ts`, `src/core/plan.ts`, `tests/plan.test.ts`

**Produces:**
```ts
type Entry = { kind:'managed'; name } | { kind:'foreign-link'; name; target } | { kind:'dir'; name } | { kind:'file'; name } | { kind:'broken-link'; name; target }
type Inventory = { home: string; storeSkills: { name: string; hash: string }[]; agentDirs: Record<string, { exists: boolean; entries: Entry[] }>; reachable: true }
parseProbeOutput(text: string, storePath: string): Result<Inventory, { kind:'bad-probe'; line: string }>
type Op = {op:'mkdir';host;path} | {op:'rsync-skill';host;skill} | {op:'link';host;agent;skill} | {op:'unlink';host;agent;skill} | {op:'conflict';host;agent;skill;entry:Entry} | {op:'remote-only';host;skill}
planHost(args: { hostId; isLocal: boolean; desired: Record<agentId, string[]>; inventory: Inventory; hubSkills: {name;hash}[]; agentDirs: Record<agentId,string> }): Op[]
```
Rules: rsync every skill desired by ≥1 agent whose hash differs or is absent remotely (never for local); link when desired and entry absent/broken-link; unlink when managed and not desired; conflict when desired and entry is dir/foreign-link/file; remote-only for store skills the hub lacks.
- [ ] Tests cover each rule + ordering (mkdir → rsync → unlink → link)
- [ ] Implement; commit

### Task 7: Script generation

**Files:** `src/core/scripts.ts`, `tests/scripts.test.ts`

**Produces:**
```ts
probeScript(args: { skm: string; agentDirs: Record<string,string> }): string
// prints: meta\thome\t$HOME ; store\t<name>\t<sha>  ; dir\t<agent>\t<exists 0|1> ; entry\t<agent>\t<name>\t<kind>\t<target>
applyScript(args: { skm: string; ops: Op[]; agentDirs; conflictBackupDir: Option<string> }): string
backupScript(args: { skm: string; ts: string; paths: string[] }): string     // tar czf + manifest + restore.sh
restoreScriptText(args: { skm: string; ts: string; paths: string[] }): string
```
sha: `sha1sum` or `shasum` fallback of SKILL.md; kinds via `[ -L ]`, `readlink`, `[ -d ]`; managed iff readlink target starts with `<skm>/skills/`.
- [ ] Tests: run `sh -s` against a temp dir (Bun.spawn) with a managed link, a real dir, a foreign link; parseProbeOutput classifies each; applyScript creates links idempotently; backup+restore round-trip restores a deleted link
- [ ] Implement; commit

### Task 8: Shell: store, runner, probe, sync, backup

**Files:** `src/shell/paths.ts`, `src/shell/store.ts`, `src/shell/runner.ts`, `src/shell/probe.ts`, `src/shell/sync.ts`, `src/shell/backup.ts`, `src/shell/app.ts`, `tests/shell.test.ts`

**Produces:**
```ts
type Runner = { id: string; run(cmd: string[], opts?: { stdin?: string; timeoutMs?: number }): Promise<Result<{ stdout: string; stderr: string }, RunError>> }
localRunner(): Runner; sshRunner(alias: string): Runner   // ssh -o BatchMode=yes -o ConnectTimeout=8 alias sh -s
loadStore(dir): Promise<Result<Skill[], StoreError>>
probeHost(host: HostConfig, agents: Agent[], runner: Runner): Promise<Result<Inventory, HostError>>
executePlan(args: { host; ops; runner; hubStore: string; agentDirs; replaceConflicts: boolean; log: (line: string) => void }): Promise<SyncReport>
backupHost(host, runner, paths): Promise<Result<{ ts; remotePath; localCopy: Option<string> }, HostError>>
restoreHost(host, runner, ts): Promise<Result<void, HostError>>
loadApp(configPath?): Promise<Result<AppState, AppError>>
```
rsync: `rsync -a --delete --exclude .DS_Store <src>/ <alias>:<skm>/skills/<name>/` (local host: `cp -R` not needed — no rsync op is planned for local).
- [ ] Integration test with temp HOME + a fake runner that runs `sh -s` locally: full plan→apply creates links; second run yields zero ops; backup then delete then restore recovers
- [ ] Implement; commit

### Task 9: CLI commands

**Files:** `bin/skm.ts`, `src/cli/{init,adopt,ls,show,plan,status,sync,pull,backup,restore,doctor}.ts`, `tests/cli.test.ts`

- `init`: write default config if absent; detect existing skills in `~/.agents/skills` and `~/.claude/skills` (real dirs) and print adopt suggestions.
- `adopt <path>|--from <agent>`: move real dir into store (`mv`), replace with symlink; refuse if name exists in store with different hash.
- `ls [--json] [--host] [--agent]`: table: name, desc chars/tokens, body tokens, lines, files, size, violations.
- `show <skill>`: frontmatter, cost, targets matrix, insights.
- `status [--host] [--json]`: probe all hosts (parallel), print per host×agent: consumed skills (managed / unmanaged dir / foreign link / broken), drift counts, remote-only.
- `plan`, `sync [--dry-run] [--replace-conflicts] [-y] [--no-backup]`.
- `pull <host> <skill>|--all`: rsync remote-only skill into hub store.
- `backup [host]`, `backups [host]`, `restore <host> <ts>`.
- `doctor`: spec violations + budget report per (host, agent).
- [ ] Tests: `ls --json` on temp store; `plan` dry output; commit

### Task 10: Heuristics + LLM eval

**Files:** `src/core/heuristics.ts`, `src/core/evalPrompt.ts`, `src/shell/evaluators.ts`, `src/shell/cache.ts`, `src/cli/eval.ts`, `tests/heuristics.test.ts`, `tests/evalPrompt.test.ts`

**Produces:**
```ts
type Insight = { skill: string; kind: 'duplicate'|'short-description'|'no-trigger'|'oversize-body'|'desc-over-cap'|'spec-violation'; detail: string; related: string[] }
lintSkill(s: Skill): Insight[]; findDuplicates(skills: Skill[], threshold = 0.5): Insight[]   // Jaccard on lowercase word/CJK-bigram sets
type EvalItem = { name; usefulness: 1..5; description_quality: 1..5; overlaps: string[]; verdict: 'keep'|'merge'|'trim'|'drop'; trim_suggestion: string; reason: string }
EVAL_SCHEMA (JSON schema for { items: EvalItem[] }); buildEvalPrompt(skills: Skill[], bodyHeadLines = 40): string; parseEvalResponse(text): Result<EvalItem[], EvalError>
evalWithClaude(prompt, model?) / evalWithCodex(prompt, model?) → Promise<Result<string, EvalError>>
```
claude: `claude -p --bare --output-format json --json-schema '<schema>' --tools "" [--model m]` — stdin prompt; result JSON `.structured_output ?? .result`. codex: write schema file; `codex exec --ephemeral --skip-git-repo-check -s read-only --output-schema f -o out.json -` with prompt on stdin.
- [ ] Tests: duplicates found for two near-identical descriptions; prompt includes all names; parse tolerates fenced JSON
- [ ] Implement; commit

### Task 11: TUI (Ink)

**Files:** `src/tui/App.tsx`, `src/tui/views/{Skills,Hosts,Sync,Insights,Help}.tsx`, `src/tui/state.ts`, `tests/tui.test.tsx`

- State: `{ view; skills; selected; filter; hosts: Record<id, HostStatus>; plan: Op[]; log: string[]; insights; evals }`; reducer with exhaustive action matching.
- Keys: `j/k` move, `/` filter, `Tab` cycle views, `Space` toggle target cell (moves cursor over host×agent grid with `h/l`), `s` plan+confirm+apply, `r` re-probe, `e` eval selected/all, `b` backup, `?` help, `q` quit.
- Skills view: left list sorted by name or cost (`o` toggles), right detail: description, cost, spec warnings, targets grid with live state glyphs (● linked ○ not-desired ◌ desired-but-missing ✗ conflict ? unreachable), insights.
- [ ] Test with ink-testing-library: renders list, filter narrows; commit

### Task 12: README + real-machine verification + inventory report

- [ ] README (中文): install (`bun build --compile`), quick start, config reference, backup/restore, eval.
- [ ] `skm init` on hub; `skm adopt --from claude/agents`; config hosts local/mini/home-mini/devbox with initial rules mirroring current reality (see status).
- [ ] `skm backup` all reachable hosts → verify `restore.sh` exists; `skm status --json` → save `docs/reports/2026-09-06-inventory.md` (per host × agent consumed skills).
- [ ] `skm sync --dry-run` review; apply on devbox; `skm restore devbox <ts>`; probe equals pre-state; re-apply.
- [ ] Final report.
