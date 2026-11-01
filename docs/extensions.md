# Extensions

English | [简体中文](zh-CN/extensions.md)

An extension adds something that the built-in skm does not know: another coding agent, or a desktop app that writes plugin marketplaces. Use extensions for anything personal or company-specific, so the core stays generic.

## Where extensions live

skm loads every `*.yaml` and `*.yml` file in `~/.skm/extensions/` on the hub when a command starts. Each file is one extension.

```sh
skm extensions          # loaded extensions, what each adds, and errors
skm extensions --json
```

In the desktop app, open **Settings → Extensions** to see the same list, switch an extension on or off, and open the folder.

An extension is data only. skm runs no code when it loads the file. The shell commands in a file run only when you start an update (`skm harness update`, or the update buttons in the app), on the hosts that the file selects, in a login shell, the same way the built-in agent update commands run.

Warning: an extension's `update` commands run on every selected host with your user's permissions. Install extension files only from people you trust, and read them first.

## Format

```yaml
name: my-setup              # optional; defaults to the file name. Lowercase letters, digits, dashes.

agents:                     # coding agents beyond claude / codex / pi
  - id: opencode            # used in config.yaml (agents, hosts.<h>.agents, rules)
    name: OpenCode          # display name
    skillsDir: ~/.config/opencode/skills
    alsoReads: [~/.claude/skills]   # other dirs this agent also loads (reported, never managed)
    cli: { bin: opencode, update: opencode upgrade }   # both optional; bin defaults to the id

apps:                       # an agent's macOS desktop app that installs plugin marketplaces
  - id: myapp
    agent: codex            # the agent this app belongs to
    name: My App
    bundle: /Applications/My App.app
    feed: https://example.com/appcast.xml        # Sparkle appcast, https only
    marketplaces: [my-bundled]                   # marketplaces the app writes
    marker: .myapp/bundled/.ready                # file under $HOME the app rewrites after an update
    settle: { file: .cache/myapp/runtime.json, busy: ".cache/myapp/install-*" }   # optional

```

Both lists are optional. skm rejects a file with an unknown top-level key, so a typo does not go unnoticed.

skm 0.6 removed the `tools:` list. A file that still has it loads with a warning in `skm extensions` and in the app, and skm ignores that list. Delete it from the file to clear the warning.

### Agents

An extension agent behaves like a built-in agent with a plain skill listing:

- Add its id to `agents:` in `config.yaml` (and to `hosts.<host>.agents` if you list agents per host). Then rules, `skm sync`, `skm status` and the app's grids include it.
- skm links store skills into `skillsDir` on every host where the agent is enabled.
- skm counts the listing cost with the o200k tokenizer and no budget limit, because skm does not know how that agent truncates its listing.
- `skm harness` shows `cli.bin --version` on each host, and `skm harness update` runs `cli.update`.

### Apps

An app attaches to its agent. When `skm harness update --agent <app id>` runs on a host, skm:

1. reads the newest version from the Sparkle appcast `feed`;
2. downloads it, then checks the code signature with `codesign --verify --deep --strict`, and checks that the Team ID matches the installed app;
3. moves the old app to `~/.skm/backups/app/` on that host and installs the new one;
4. opens the app hidden and waits until it rewrites `marker` (and, when `settle` is set, until `settle.file` stops changing and no `settle.busy` path is left);
5. quits the app again if it was not running before.

The app's `marketplaces` show in the Plugins view as "ships with the app". Updating such a plugin updates the app first on the hosts where it is behind.

The ChatGPT desktop app (which installs Codex's `openai-bundled` and `openai-primary-runtime` marketplaces) ships as the built-in extension `chatgpt-desktop`.

## Turning extensions off

```yaml
# ~/.skm/config.yaml
disabledExtensions: [chatgpt-desktop, my-setup]
```

The app's switch in **Settings → Extensions** writes the same field.

## Conflicts and errors

- If an extension uses an id that a built-in agent or an earlier extension already uses, skm skips the whole extension and reports which ids clash. Files load in name order.
- If a file does not parse, skm skips it and reports the first problem with its path, for example `agents[0].skillsDir: expected a non-empty string`.
- An app that names an unknown agent is reported and not attached.

Skipped extensions show in `skm extensions` and in the app, with the reason.
