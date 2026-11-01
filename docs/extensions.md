# Extensions

English | [简体中文](zh-CN/extensions.md)

An extension adds what the built-in skm does not know: a coding agent that loads skills (skm ships with Claude Code, Codex and Pi), or a source that serves skills (skm reads git repos itself). Use extensions for anything personal or company-specific, so the core stays generic.

## Where extensions live

skm loads every `*.yaml` and `*.yml` file in `~/.skm/extensions/` on the hub when a command starts. Each file is one extension.

```sh
skm extensions          # loaded extensions, what each adds, warnings and errors
skm extensions --json
```

In the desktop app, open **Settings → Extensions** to see the same list and open the folder. To turn an extension off, move its file out of the folder.

An extension is data only. skm runs no code when it loads the file. It runs the commands a file names only when they are needed:

- An agent's `cli.update` runs when you start an update (`skm harness update`, or the update buttons in the app), on the hosts where that agent is enabled, in a login shell, the same way the built-in agent update commands run.
- A source's `latest` and `fetch` run on the hub when skm checks or updates an upstream that uses the source (`skm upstream`, the TUI, the app's upstream check).

Warning: these commands run with your user's permissions. Install extension files only from people you trust, and read them first.

## Format

```yaml
name: my-setup              # optional; defaults to the file name. Lowercase letters, digits, dashes.

agents:                     # coding agents beyond claude / codex / pi
  - id: opencode            # used in config.yaml (agents, hosts.<h>.agents, rules)
    name: OpenCode          # display name
    skillsDir: ~/.config/opencode/skills
    alsoReads: [~/.claude/skills]   # other dirs this agent also loads (reported, never managed)
    cli: { bin: opencode, update: opencode upgrade }   # both optional; bin defaults to the id

sources:                    # where upstreams with `source: <id>` get their skills (see Sources)
  - id: my-registry
    params: [namespace]
    latest: my-registry show "$NAMESPACE/$SKILL" --json | jq -r .version
    fetch: my-registry download "$NAMESPACE/$SKILL" --version "$VERSION" --unpack "$OUT"
```

Both lists are optional. skm rejects a file with an unknown top-level key, so a typo does not go unnoticed.

skm 0.6 removed the `tools:` and `apps:` lists. A file that still has one loads with a warning in `skm extensions` and in the app, and skm ignores that list. Delete it from the file to clear the warning. The Codex desktop app (ChatGPT.app), which 0.5 shipped as the built-in extension `chatgpt-desktop`, is now part of the built-in codex agent.

## Agents

An extension agent behaves like a built-in agent with a plain skill listing:

- Add its id to `agents:` in `config.yaml` (and to `hosts.<host>.agents` if you list agents per host). Then rules, `skm sync`, `skm status` and the app's grids include it.
- skm links store skills into `skillsDir` on every host where the agent is enabled.
- skm counts the listing cost with the o200k tokenizer and no budget limit, because skm does not know how that agent truncates its listing.
- `skm harness` shows `cli.bin --version` on each host, and `skm harness update` runs `cli.update`.

## Sources

A source lets an upstream get its skills from somewhere other than a git repo, for example a company skill registry. It names two shell commands:

```yaml
sources:
  - id: my-registry           # what upstreams.<name>.source names
    name: My registry         # optional display name
    params: [namespace]       # keys every upstream of this source must set
    # prints the newest version of $SKILL; skm reads the last non-empty line of stdout
    latest: my-registry show "$NAMESPACE/$SKILL" --json | jq -r .version
    # writes the files of $SKILL at $VERSION into the empty dir $OUT
    fetch: |
      my-registry download "$NAMESPACE/$SKILL" --version "$VERSION" -o "$WORK/skill.zip"
      unzip -q "$WORK/skill.zip" -d "$OUT"
```

| Variable | `latest` | `fetch` | Value |
|---|---|---|---|
| `$SKILL` | yes | yes | The skill name, from `upstreams.<name>.skills` |
| `$VERSION` | | yes | The version to download |
| `$OUT` | | yes | An empty dir; the skill's files go here |
| `$WORK` | | yes | A scratch dir; skm deletes it afterwards |
| each param, upper-cased | yes | yes | From `upstreams.<name>` (`namespace` → `$NAMESPACE`) |

- skm runs the commands with `sh -c` on the hub, with skm's own environment, one skill at a time.
- `latest` must print a version that can be a file name: letters, digits, `.`, `_`, `+` and `-`.
- After `fetch`, `$OUT` must hold `SKILL.md`, either at its root or in its only subdir (an archive that unpacks to `<skill>/` works as it is).
- skm computes the digest of the downloaded files itself, keeps them in `~/.skm/cache/sources/<upstream>/<skill>/<version>/`, and runs `fetch` again only for a version it does not have.
- A param may not be named `skill`, `version`, `out` or `work`.

An upstream uses a source with `source:`; see [Skills from a registry](../README.md#skills-from-a-registry).

## Conflicts and errors

- If an extension uses an id that a built-in agent or an earlier extension already uses, skm skips the whole extension and reports which ids clash. Files load in name order.
- If a file does not parse, skm skips it and reports the first problem with its path, for example `agents[0].skillsDir: expected a non-empty string`.

Skipped extensions show in `skm extensions` and in the app, with the reason.
