# How it works

English | [简体中文](zh-CN/how-it-works.md)

## Target state

`desired(skill, host, agent) = hosts selector(host) ∧ agents selector(agent)`, then the `on` / `off` cell overrides in order, and the agent must be enabled on that host.

Rules apply from top to bottom, and a later rule wins. `defaults` applies when no rule matches. `skm scope` and the cell toggles in the app write `on` / `off` overrides. When you toggle a cell back, skm removes the override it added, so `config.yaml` keeps no leftovers.

If the config names an agent that skm does not know, the CLI warns and ignores it. That agent is not shown in the app or the TUI, and skm does not probe, sync or back it up.

## What each agent loads

At startup each agent lists the SKILL.md files from all of these places. skm probes them in this order and merges them into the effective inventory:

| Source | Claude Code | Codex | Pi | Owner |
|---|---|---|---|---|
| User dir | `~/.claude/skills` | `~/.agents/skills` | `~/.pi/agent/skills` | skm (symlinks), owned tools (real dirs), manual |
| Legacy / shared dir | — | `~/.codex/skills` | Pi also reads `~/.agents/skills` (on a name clash `~/.pi/agent/skills` wins and the other copy is shadowed) | same |
| Settings exclusion | — | — | `-skills/<name>` in the `skills` array of `~/.pi/agent/settings.json` makes Pi skip that skill in both dirs | skm (sync keeps it) |
| Built-in | — | `~/.codex/skills/.system` | — | codex-builtin |
| Plugin cache | `~/.claude/plugins/cache/<mk>/<plugin>/<ver>/skills/*`; enabled per `enabledPlugins` in `settings.json`, active version per `installed_plugins.json` | `~/.codex/plugins/cache/...`; enabled per `[plugins."name@mk"] enabled` in `config.toml`. Codex does not load a cached plugin that the config does not name, so skm does not count it | — | claude-plugins / codex-plugins |

Each entry has a storage kind (`link→store`, `real dir`, `link→elsewhere`, `plugin cache`, `builtin`), an owner, a version (plugin version, or the owned skill's lock), listing characters, body tokens and a content hash.

### Pi and `~/.agents/skills`

Pi also reads Codex's `~/.agents/skills`, so a skill meant only for Codex loads in Pi too. Sync handles this: when a store or owned skill will be in `~/.agents/skills` after the sync, but Pi is not a target for it, sync adds `-skills/<name>` to the `skills` array in that host's `~/.pi/agent/settings.json` (`pi: exclude <name>`). When Pi becomes a target again, or the skill leaves that dir, sync removes the entry (`pi: unexclude <name>`).

skm manages only entries in that exact form whose name is a store or owned skill. It keeps every other entry (globs, `!pattern`, other names). The edit runs with node on the host; a host without node shows the change as blocked.

## Findings

- `same-name`: one agent loads two skills with the same name from two sources (for example Codex's built-in `skill-creator` and a plugin copy).
- `linked-twice`: two dirs both link to the store, so the agent loads the same skills twice (Codex's `~/.agents/skills` and `~/.codex/skills`).
- `shadowed`: the agent de-duplicates by name (Pi: `~/.pi/agent/skills` before `~/.agents/skills`), so the copy in the other dir does not load and does not count. This is a note; skm lists it separately if the two copies differ.
- `same-content`: different names, identical SKILL.md.
- `owned-drift`: the dir that an owner CLI writes differs from the store copy linked to other agents. skm suggests refreshing the store copy from the CLI's version.
- `stale-cache` / `disabled-cached` / `unloaded-cache`: an old plugin version in the cache that is not active; a plugin turned off in the config that still takes disk space; a cached plugin the config does not mention at all, which the agent never loads.
- `version-drift`: one plugin has different active versions on different host × agent cells.

## Sync operations

Besides rsync and symlinks, `plan` / `sync` have operations that move no files:

- `marketplace-add`, `plugin-install`, `plugin-enable`, `plugin-disable`: applied with `claude plugin …` / `codex plugin …`. Where Codex has no enable/disable subcommand, skm edits `enabled` in `config.toml`.
- `owned-ensure`: runs the owner CLI's `ensure` command.
- When a host does not have the CLI, the operation is `blocked`. skm never falls back to copying files.

When a host lacks a marketplace, `marketplace-add` uses the source from the hub's config. If that source is only a local dir on the hub (Codex `source_type = "local"`, Claude `directory` / `file`, for example `openai-primary-runtime` written by the ChatGPT desktop app), the operation is `blocked` for other hosts. Add it on that host by hand, or exclude the host with a `hosts` selector.

Backups include the store, every agent user dir, `~/.claude/settings.json`, `~/.claude/plugins/installed_plugins.json` and `~/.codex/config.toml`.

## Context cost

The **listing** (paid every turn) always shows in tokens. Store views (`ls`, `show`, the app's Skills view) estimate `description + when_to_use` with the o200k tokenizer. Each host × agent budget uses that agent's own accounting, converted to tokens. `status`, `inventory` and `doctor` count the effective inventory (plugins, built-ins and legacy dirs included); only when a host is unreachable does skm fall back to the store.

### Claude Code

- Total budget (characters) = model context tokens × characters per token × `skillListingBudgetFraction` (default 1%).
- Characters per token: 4 for Opus/Sonnet 4.6 and earlier and Haiku 4.5; 3 for the rest (Fable, Opus 4.7+, Sonnet 5).
- The context comes from `model` in each host's `~/.claude/settings.json`: Fable, Opus 4.7+ and Sonnet 5 have 1M natively, older models 200K; a `[1m]` suffix raises it to 1M; `env.CLAUDE_CODE_DISABLE_1M_CONTEXT` lowers it to 200K. `autoCompactWindow` does not matter.
- `env.SLASH_COMMAND_TOOL_CHAR_BUDGET` sets the budget directly. Each skill is capped at `skillListingMaxDescChars` (default 1536).
- Examples: Fable 1M × 3 × 1% = 30,000 characters, shown as 10,000 tokens; Opus 4.6 200K × 4 × 1% = 8,000 characters = 2,000 tokens.
- Over budget, Claude Code drops descriptions by how often skills are used; names always stay. Listing characters count `- name: description` lines. Claude Code's own built-in skills are not in skm's inventory; use `/context` in Claude Code for the real number.

### Codex

- Total budget (tokens) = model context window × 2%.
- The window is the `context_window` of the `model` from each host's `~/.codex/config.toml`, looked up in the model catalog. The catalog comes from `codex debug models` during the probe, or `~/.codex/models_cache.json` without the codex CLI. Without a `model` in config.toml, skm picks the visible preset with the lowest priority, as Codex does. `model_context_window` overrides the window, capped at `max_context_window`. The config's `contextTokens` applies only when there is no catalog.
- `[skills] max_context_tokens` sets the budget directly (capped at 10,000). With an unknown window the budget is 8,000 characters (about 2,000 tokens).
- Each `- name: description (file: rN/path)` line counts ⌈bytes / 4⌉ tokens. Paths are shortened through the `### Skill roots` alias table, which also counts. Plugin skill names have a `plugin:` prefix. Only `description` is listed, not `when_to_use`. Each line is at most 1,024 characters.
- Over budget, Codex first shortens all descriptions round-robin (every skill stays), and drops whole lines only when even empty descriptions do not fit.

### Pi

Pi has no published listing budget. skm estimates with o200k and sets no limit.

The **body** (paid when a skill activates) is the token and line count of the SKILL.md body. The spec suggests fewer than 5,000 tokens and 500 lines.

## Upstreams

`skm upstream` compares three digests for each skill under `upstreams:`:

- **base**: what skm last wrote, from `~/.skm/upstreams.lock.json`
- **store**: the store dir now
- **target**: the dir at the target ref in the mirror (`~/.skm/cache/upstreams/<name>.git`)

The digest is a SHA-256 over each file's path and git blob id, so skm hashes the store copy and a repo tree the same way without a checkout. `.DS_Store`, `__pycache__`, `*.pyc` and `.git` do not count. File modes do not count either, but `update` writes them (`100755` files are executable).

`update` writes the skill into `<store>/.upstream-<skill>` first, then swaps it in, then reads it back and checks the digest against the target. Before it writes, it takes a hub backup of the skill dirs it replaces and of the lock file, so `skm restore <hub> <ts>` returns both. Skills that already equal the target get their lock entry moved to the target, so a later edit is measured against the right base.

## Backups and restore

Before each `sync` applies, skm writes on every target host:

```
~/.skm/backups/<ts>/
├── snapshot.tar.gz   # store + every agent user dir (symlinks kept as symlinks)
├── manifest.txt      # each path present / absent
└── restore.sh        # sh restore.sh goes back to the snapshot (removes the current state, then unpacks)
```

skm also copies remote snapshots back to `~/.skm/backups/<host>/<ts>/` on the hub. Restore with `skm restore <host> <ts>`, or run `sh ~/.skm/backups/<ts>/restore.sh` on the host.

Warning: `restore.sh` removes the current state of the dirs in the snapshot before it unpacks. Changes made to those dirs after the snapshot are lost.

## Known issues

On a host where `$HOME` is a symlink (for example `/home/x → /mnt/data/home/x`), older Codex versions recorded the real path as the `openai-bundled` source. Codex 0.166 then hides that marketplace, and `codex plugin add` reports not found. Change that line in `~/.codex/config.toml` back to a path that starts with `$HOME`.
