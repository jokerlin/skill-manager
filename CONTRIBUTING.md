# Contributing

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thanks for helping with Skill Manager. Bug reports, fixes, docs and translations are all welcome.

## Before you start

- For a bug, open an issue with the output of `skm --version`, your OS, the agents involved, and the smallest steps that show the problem. Remove host names, paths and skill names you do not want to share.
- For a new feature, open an issue first and describe the problem it solves. A feature that only one setup needs often fits better as an [extension](docs/extensions.md).
- For a security problem, do not open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need [Bun](https://bun.sh) 1.3 or later, `rsync`, and macOS for the desktop app.

```sh
git clone https://github.com/jokerlin/skill-manager.git
cd skill-manager
bun install
(cd desktop && bun install)

bun run dev status           # run the CLI from source
cd desktop && SKM_COMMAND="bun run $PWD/../bin/skm.ts" bun run dev   # the app, using the CLI from source
```

The tests use a temporary `HOME`, so they do not touch your real `~/.skm`, `~/.claude` or `~/.codex`.

Warning: running `skm sync` from source acts on your real hosts. Run `skm plan` first, or point `HOME` at a test directory.

## Project layout

```
src/core/     pure functions: config, rules, sources, plan (diff → operations), budget, extensions
src/shell/    side effects: file system, ssh, rsync, child processes
src/cli/      commands (Commander)
src/tui/      terminal UI (Ink)
desktop/      Electron app: main process, preload, React renderer
tests/        bun test: pure core, integration with real sh/rsync, TUI rendering
docs/         user docs (English and docs/zh-CN)
```

The desktop app never computes state itself. It runs `skm … --json` and writes through `skm scope` and `skm config patch`. A change in behavior goes into the CLI first.

## Code style

- Keep `src/core` pure: no file system, network, time or randomness. Side effects go in `src/shell`.
- Return `Result` / option values for expected failures. Throw only for real bugs.
- Model states as tagged unions and match every case (`ts-pattern` `.exhaustive()` or a `switch` with no default).
- Prefer `map` / `filter` / `reduce` over loops that mutate. Use classes only for adapters to external systems.
- Write comments for why, not what.
- User-visible text in the app goes through `desktop/src/renderer/src/i18n`. Add every new key to both `en` and `zh`.

## Before you open a pull request

```sh
bun run typecheck
bun test
(cd desktop && bun run typecheck && bun run build)
```

- Add or update tests for behavior changes. A bug fix comes with a test that fails without the fix.
- Update `README.md`, `README.zh-CN.md` and `docs/` when you change commands, config or app behavior.
- Keep a pull request to one change. Describe what changed, why, and how you checked it.
- Do not commit personal data: host names, ssh aliases, real paths under your home directory, tokens, or private skill names.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit titles, for example `fix(plan): …` or `feat(desktop): …`.

CI runs the same checks on Linux and macOS for every pull request.

## Translations

The app's strings are in `desktop/src/renderer/src/i18n/en.ts` and `zh.ts`. To add a language, copy `en.ts`, translate the values, and register the locale in `i18n/index.ts`. Keep product terms (skill, plugin, agent, host) consistent within one language.

## Releases

### When to release

Release only when people who upgrade will notice the change, or are protected by it. Every release asks every app user to download about 140 MB.

| Change | Release? |
|---|---|
| Security fix, data loss, crash at launch, a bug in the updater | Now. A broken updater cannot deliver any later release. |
| User-visible bug fix or feature | Collect a few, then release. |
| Runtime dependency update | Now if it fixes a known vulnerability. Otherwise with the next release. |
| Docs, README, screenshots | No. |
| CI, the release workflow, Dependabot, repository settings | No. Check a release workflow change with a dry run (below). |
| Tests, refactors with no change in behavior, dev dependencies | No. |
| Build changes users do not notice | Not alone. They go out with the next release. |

Changes that do not get a release still go to `main`. Add an entry under `[Unreleased]` in `CHANGELOG.md` when users will care.

To check a change to the release workflow without publishing, run it by hand: Actions → Release → Run workflow. It builds, signs and notarizes everything, and keeps the assets as a workflow artifact.

### How to release

Maintainers release from `main`:

1. Move the `[Unreleased]` entries in `CHANGELOG.md` under a new `## [<version>] - <date>` heading. The release notes come from that section.
2. Set the same version in `package.json` and `desktop/package.json`, and commit.
3. Run `sh desktop/scripts/release.sh`. It checks the versions and a clean tree, then creates and pushes the tag `v<version>`.
4. The Release workflow tests, builds the CLI for macOS and Linux and the app for arm64 and x64, signs and notarizes the app and the macOS CLI, signs `latest-mac.json`, writes `SHA256SUMS`, adds build provenance, and publishes the GitHub release.

Warning: pushing the tag publishes a public release. Installed apps offer it as an update.

The update signing key:

- The workflow reads the Ed25519 private key from the repository secret `SKM_UPDATE_SIGN_KEY`. The matching public key is `updatePublicKey` in `desktop/package.json`.
- If you lose the private key, installed apps cannot verify new releases. Users then have to download the next version by hand.
- A fork that publishes its own releases generates its own key pair and replaces `updatePublicKey`:

  ```sh
  bun desktop/scripts/update-keygen.ts ~/update-signing-key.pem   # paste the printed key into desktop/package.json "updatePublicKey"
  gh secret set SKM_UPDATE_SIGN_KEY < ~/update-signing-key.pem
  ```

  Keep `update-signing-key.pem` outside the repository.

Code signing and notarization (macOS):

- The workflow signs the app with a Developer ID Application certificate and notarizes it with an App Store Connect API key. It reads five secrets: `MAC_CSC_LINK` (the `.p12` with the certificate, its private key and the Developer ID G2 intermediate, base64), `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY` (the `.p8`, base64 on one line), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
- After the build it runs `codesign --verify`, `spctl --assess` and `stapler validate` on each app, and fails if any of them fails.
- Without these secrets (a fork, a local `bun run pack`) electron-builder skips signing and the app is ad-hoc signed. Users then have to allow it in System Settings → Privacy & Security.
- Warning: the signed app pins its Team ID. A release signed by another team, or not signed at all, is refused by the updater of a signed app.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By taking part you agree to it.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
