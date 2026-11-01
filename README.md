# Skill Manager (skm)

[![CI](https://github.com/jokerlin/skill-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/jokerlin/skill-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

Manage agent skills and plugins across **many machines × many coding agents × per-cell config**, from one place.

skm keeps one store of skills on your main machine, links it into every agent's skill directory, and mirrors it to your other machines over ssh. It also tracks the plugins, CLI versions and desktop apps each agent loads, so you can see and fix drift on every host at once. It ships as a CLI (with a TUI) and a macOS desktop app.

Supported agents: **Claude Code**, **Codex** and **Pi**. You can add more agents with an [extension](docs/extensions.md).

```
~/.skm/skills/<name>/SKILL.md     ← the store, the single source of truth
~/.claude/skills/<name>    ─┐
~/.agents/skills/<name>    ─┼─→ symlinks into the store (Claude Code / Codex / Pi)
~/.pi/agent/skills/<name>  ─┘
mini:~/.skm/skills  devbox:~/.skm/skills   ← rsync mirrors, linked locally on each host
```

Remote hosts need only `ssh`, `rsync` and a POSIX `sh`. You install nothing on them.

## Why skm

Most skill managers handle one agent on one machine. skm treats your setup as a grid: every skill or plugin has a target state for each **host × agent** cell.

- **One grid for everything.** Rules decide which skills go to which hosts and agents (`only`, `except`, globs). You can flip a single cell, for example "this skill off for Codex on the laptop".
- **What the agent really loads.** skm lists every source each agent reads at startup: user dirs, legacy dirs, built-in skills and plugin caches. It shows who owns each entry and what it costs in the context window.
- **Plugins and harness, too.** skm shows plugin versions on every host × agent and updates the ones that drift. It also checks and updates the agent CLIs (`claude`, `codex`, `pi`) on every host.
- **Safe by default.** Every sync starts with a backup and a `restore.sh` on each host. skm never deletes a real directory unless you ask, and a host that is down does not block the others.

## Features

- Context budget per host × agent, computed the way each agent computes it (listing budget and body size).
- Findings: duplicate names, a skill linked twice, shadowed copies, stale plugin caches, version drift.
- Pending changes bar in the app: every edit queues up, you review it per host, then apply.
- Plugin updates across hosts (`skm plugin update`), including plugins that ship inside a desktop app.
- Harness updates: run each agent CLI's own update command on every host in parallel.
- LLM evaluation of your skills (`skm eval`) with `claude -p` or `codex exec`.
- Extensions: add agents, desktop apps and update tasks with a YAML file, no code.
- English and Simplified Chinese UI. Light and dark themes.

## Install

### Desktop app (macOS)

1. Download `skill-manager-<version>-arm64-mac.zip` (Apple silicon) or `-x64-mac.zip` (Intel) from [Releases](https://github.com/jokerlin/skill-manager/releases).
2. Unzip it and move `Skill Manager.app` to `/Applications`.
3. Open it. From 0.4.1 on, the app is signed with a Developer ID and notarized by Apple, so macOS asks once whether to open an app downloaded from the internet. Click **Open**.

The app contains the `skm` CLI, so you do not need to install it separately. Later versions install from inside the app (see [Updates](#updates)).

### CLI

Download the binary for your platform from [Releases](https://github.com/jokerlin/skill-manager/releases) (`skm-darwin-arm64`, `skm-darwin-x64`, `skm-linux-x64`, `skm-linux-arm64`), then:

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing   # check the download
install -m 755 skm-darwin-arm64 ~/.local/bin/skm
```

Or build from source with [Bun](https://bun.sh) 1.3 or later:

```sh
git clone https://github.com/jokerlin/skill-manager.git
cd skill-manager
bun install
bun run build                # → dist/skm, a single executable
cp dist/skm ~/.local/bin/skm
```

## Quick start

```sh
skm init                         # create ~/.skm/config.yaml and the store; list unmanaged skills
skm adopt --from claude codex pi # move real skill dirs into the store, leave symlinks behind
skm status                       # probe every host: what each agent loads, drift, conflicts
skm pull mini --all              # copy skills that only a remote host has into the store
skm rules infer --write          # write scope rules from what each host has today
skm plan                         # show what sync would do
skm sync                         # backup → rsync → symlinks on every host
skm                              # open the TUI
```

Warning: `skm sync --replace-conflicts` moves real directories on remote hosts into the backup and replaces them with symlinks. Read `skm plan` first.

## Configuration

skm reads `~/.skm/config.yaml`:

```yaml
store: ~/.skm/skills
agents: [claude, codex, pi]            # built-in ids, plus agents from extensions
hosts:
  laptop: {}                           # exactly one host has no ssh: the hub (this machine)
  mini: { ssh: mini }                  # an alias from ~/.ssh/config
  devbox: { ssh: devbox, agents: [claude, codex] }
defaults: { hosts: all, agents: all }  # where a skill goes when no rule matches
rules:                                 # top to bottom; a later rule wins; skills take globs
  - skills: ["docs-*"]
    hosts: { except: [devbox] }
  - skills: ["work-*"]
    hosts: { only: [mini, devbox] }
  - skills: [hatch-pet]
    agents: { only: [codex] }
    off: ["mini/codex"]                # one host/agent cell
plugins:                               # target state for plugins, applied through the claude / codex CLIs
  superpowers: { marketplace: claude-plugins-official, agents: { only: [claude, codex] } }
  humanizer: { marketplace: claude-extras, enabled: false }
owned:                                 # skills that another CLI installs and updates itself
  acme:
    tool: acme                         # the owner CLI
    agents: [claude, codex]            # dirs that CLI writes; skm checks them and does not link there
    ensure: acme skill install acme    # runs when the dir is missing and the host has the CLI
    lock: { file: ~/.local/share/acme/skill-lock.json, version: "skills.{skill}.version" }
    fallback: store                    # host without the CLI: link the store copy (or `none`)
eval: { agent: claude }
agentOverrides:                        # optional: another skill dir or update command for an agent
  pi: { dir: ~/.pi/agent/skills, update: "pi update --all" }
disabledExtensions: []                 # e.g. [chatgpt-desktop]
contextTokens: 1000000                 # fallback context window when skm cannot read the model
backupBeforeApply: true
```

A cell is on when the host selector and the agent selector both match, after the `on` / `off` cell overrides, and only if that agent is enabled on that host. The desktop app edits this file for you (Settings, and the cell toggles in each view).

## Commands

| Command | What it does |
|---|---|
| `skm` | TUI with skills, hosts, sync and help views (`?` lists the keys) |
| `skm init` | Create the config and the store; list unmanaged skills |
| `skm adopt <path…> \| --from <agent…>` | Move real skill dirs into the store and leave symlinks |
| `skm ls` / `skm show <skill>` | Store skills with context cost; one skill's details and grid |
| `skm status` / `skm inventory` | Probe hosts: what each agent loads from every source |
| `skm plan` / `skm sync` | Compute and apply the sync; backs up first, re-probes after |
| `skm plugins` / `skm plugin update` | Plugin versions on every host × agent; update the ones that drift |
| `skm harness` / `skm harness update` | Agent CLI, desktop app and extension tool versions; update them |
| `skm extensions` | Loaded extensions and errors |
| `skm scope <name> <host/agent> on\|off` | Toggle one cell (add `--plugin` for a plugin) |
| `skm config` / `skm config patch` | Print the config; apply a validated JSON patch from stdin |
| `skm pull <host> [skills…]` | Copy remote-only skills into the store |
| `skm rules infer` | Infer host rules from what each host has |
| `skm backup` / `skm backups` / `skm restore <host> <ts>` | Snapshots and one-step restore |
| `skm doctor` | Spec checks, budget simulation, cross-host plugin drift |
| `skm eval [skills…]` | Ask an LLM to rate usefulness, description quality and overlap |

Most commands take `--json`, `--host` and `--cached` (use the last probe, no ssh). Run `skm <command> --help` for all options. [How it works](docs/how-it-works.md) explains sources, findings and the context budget formulas.

## Desktop app

The app is an Electron shell over the CLI. All logic stays in `skm`: the app reads `skm … --json` and writes through `skm scope` and `skm config patch`. Sync and updates stream `--events` NDJSON for progress.

- **Skills**: every skill with a coverage column ("Everywhere", "Only mini", "All but Codex", "7 / 12"). The column keeps its width for any number of hosts and agents. Hover to see the full grid; click cells in the detail panel to toggle them.
- **Plugins**: each plugin's version on every host × agent. Drift is red, with one button to update everything that drifts.
- **Hosts**: host → agent master-detail with the listing budget, sources, every loaded skill, and the agent CLI versions.
- **Pending changes**: edits queue in a bar at the bottom (`⌘↵` applies). Review them per host before you apply.
- **Settings** (`⌘,`): language, theme, hosts (drag to reorder, rename, ssh alias), agents, extensions, store path, backups.
- **Command palette** (`⌘K`): jump to any skill, plugin or host, or run an action.

## Extensions

An extension is a YAML file in `~/.skm/extensions/`. It can add an agent, a desktop app that writes plugin marketplaces, or a tool that `skm harness` checks and updates on each host:

```yaml
# ~/.skm/extensions/my-tools.yaml
name: my-tools
tools:
  - id: magpie
    bin: magpie
    update: magpie update
    onChange: magpie daemon restart   # runs only when the version changed
    hosts: { only: [mini] }
```

Extensions are data. skm runs their commands only when you run `skm harness update` or press update in the app. See [docs/extensions.md](docs/extensions.md) for the full format. The ChatGPT desktop app support ships as the built-in extension `chatgpt-desktop`; turn it off with `disabledExtensions: [chatgpt-desktop]`.

## Updates

The desktop app checks GitHub Releases for a newer version (you can turn this off in Settings → General).

- Each release has a manifest, `latest-mac.json`, with the SHA-512 and size of each zip. The release workflow signs the manifest with an Ed25519 key, and the app checks the signature against the public key in `desktop/package.json`. If the signature does not verify, the app does not install the update.
- The app downloads the zip for its architecture, checks the SHA-512 from the signed manifest, and swaps the app when you restart. The previous version stays in `~/Library/Application Support/Skill Manager/updates/previous.app`.
- The app is signed with a Developer ID. A signed app installs an update only if the new app's code signature verifies and has the same Team ID.
- A release without a signed manifest, or a build without `updatePublicKey`, shows the release page instead of installing. A fork that publishes its own releases sets its own key (see [CONTRIBUTING.md](CONTRIBUTING.md#releases)).
- Release assets have GitHub [build provenance attestations](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations). Check a download with `gh attestation verify <file> --repo jokerlin/skill-manager`.

skm uses its own updater instead of Squirrel.Mac (`electron-updater`), so a fork or a local build without a Developer ID can still update from a signed manifest.

Set `SKM_UPDATE_API` to point the app at another GitHub-compatible API (a mirror, GitHub Enterprise, a local test server).

## Safety

- skm deletes only symlinks that point into the store for a skill the hub knows. It keeps real directories, symlinks to other places and remote-only store skills, unless you pass `--replace-conflicts` (which moves them into the backup first).
- Plugin and owned-skill changes go through the owner's CLI (`claude plugin`, `codex plugin`, the `ensure` command). skm never edits plugin caches. A host without that CLI shows the change as `blocked`.
- Each sync writes `~/.skm/backups/<ts>/` on every target host with `snapshot.tar.gz`, `manifest.txt` and `restore.sh`. Restore with `skm restore <host> <ts>` or `sh ~/.skm/backups/<ts>/restore.sh` on the host.

## Development

```sh
bun install && (cd desktop && bun install)
bun test                 # pure core, integration tests with a temp HOME and real sh/rsync, TUI rendering
bun run typecheck
cd desktop && bun run dev
```

Layout: `src/core` (pure functions) → `src/shell` (file system, ssh, rsync, processes) → `src/cli` and `src/tui`; `desktop/` is the Electron app. See [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request.

## License

[MIT](LICENSE) © 2026 jokerlin
