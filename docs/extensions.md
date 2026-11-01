# Extensions

English | [简体中文](zh-CN/extensions.md)

An extension adds a coding agent that the built-in skm does not know (skm ships with Claude Code, Codex and Pi). Use extensions for anything personal or company-specific, so the core stays generic.

## Where extensions live

skm loads every `*.yaml` and `*.yml` file in `~/.skm/extensions/` on the hub when a command starts. Each file is one extension.

```sh
skm extensions          # loaded extensions, what each adds, warnings and errors
skm extensions --json
```

In the desktop app, open **Settings → Extensions** to see the same list and open the folder. To turn an extension off, move its file out of the folder.

An extension is data only. skm runs no code when it loads the file. An agent's `cli.update` command runs only when you start an update (`skm harness update`, or the update buttons in the app), on the hosts where that agent is enabled, in a login shell, the same way the built-in agent update commands run.

Warning: an extension's `update` command runs on every host where the agent is enabled, with your user's permissions. Install extension files only from people you trust, and read them first.

## Format

```yaml
name: my-setup              # optional; defaults to the file name. Lowercase letters, digits, dashes.

agents:                     # coding agents beyond claude / codex / pi
  - id: opencode            # used in config.yaml (agents, hosts.<h>.agents, rules)
    name: OpenCode          # display name
    skillsDir: ~/.config/opencode/skills
    alsoReads: [~/.claude/skills]   # other dirs this agent also loads (reported, never managed)
    cli: { bin: opencode, update: opencode upgrade }   # both optional; bin defaults to the id
```

skm rejects a file with an unknown top-level key, so a typo does not go unnoticed.

skm 0.6 removed the `tools:` and `apps:` lists. A file that still has one loads with a warning in `skm extensions` and in the app, and skm ignores that list. Delete it from the file to clear the warning. The Codex desktop app (ChatGPT.app), which 0.5 shipped as the built-in extension `chatgpt-desktop`, is now part of the built-in codex agent.

## Agents

An extension agent behaves like a built-in agent with a plain skill listing:

- Add its id to `agents:` in `config.yaml` (and to `hosts.<host>.agents` if you list agents per host). Then rules, `skm sync`, `skm status` and the app's grids include it.
- skm links store skills into `skillsDir` on every host where the agent is enabled.
- skm counts the listing cost with the o200k tokenizer and no budget limit, because skm does not know how that agent truncates its listing.
- `skm harness` shows `cli.bin --version` on each host, and `skm harness update` runs `cli.update`.

## Conflicts and errors

- If an extension uses an id that a built-in agent or an earlier extension already uses, skm skips the whole extension and reports which ids clash. Files load in name order.
- If a file does not parse, skm skips it and reports the first problem with its path, for example `agents[0].skillsDir: expected a non-empty string`.

Skipped extensions show in `skm extensions` and in the app, with the reason.
