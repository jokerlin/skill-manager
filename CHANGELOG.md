# Changelog

All notable changes to Skill Manager. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The release workflow uses the section for a version as its GitHub release notes.

## [Unreleased]

### Fixed

- `skm upstream` printed every skill a repo has but `config.yaml` does not track, on one line. For a repo like bytedcli that was 266 names. It now prints the count and three examples when there are more than three; `skm upstream --json` still lists every name.

## [0.5.3] - 2026-11-01

### Added

- Skills can track the git repo they came from. Declare it under `upstreams:` in `config.yaml`, or run `skm upstream adopt <name> --repo <url>`; adopt also finds which upstream commit each store copy equals. `skm upstream` shows each skill's state (current, update available, edited locally) and the upstream commits since your version. `skm upstream update` backs up, writes the new version into the store and records it; it does not overwrite a copy you edited unless you pass `--force`. Then `skm sync` copies it to every host.
- The app shows the upstream state of each skill in the Skills view, with an Updates filter, an update button for all of them, and the upstream commits since your version in the detail panel. The app checks the upstreams when it starts.

## [0.5.2] - 2026-11-01

### Changed

- The desktop app downloads an update over 4 connections at once. Through a proxy, one connection ran anywhere from 3 KB/s to 3 MB/s, and the 142 MB update took 9 min 38 s; now it takes 35 to 60 s. A connection under a quarter of the speed of the others is reopened, and at the end the idle connections take over the bytes a slow one has left. A server that ignores range requests gets one plain request.

### Fixed

- Old update downloads no longer pile up (about 140 MB each). The app deletes the downloads of versions it has already installed when it starts.

## [0.5.1] - 2026-11-01

### Added

- Homebrew tap: `brew install --cask skill-manager` for the app, `brew install skill-manager-cli` for the CLI (after `brew tap jokerlin/tap` and `brew trust jokerlin/tap`). Each release updates the tap.

### Fixed

- The TUI Plugins list shows long versions whole: a 13-character version such as `26.1027.51404` lost its first digit.

## [0.5.0] - 2026-11-01

### Added

- TUI Plugins view (key `2`): every plugin with its version on each host × agent, drift in red, and `u` to update a plugin on every host (marketplace refresh, then plugin update; backup first when that setting is on).
- TUI skills list has an "enabled on" column with the same phrase as the app (`Everywhere`, `Only studio`, `All but Pi`, `5 of 9`).

### Changed

- The TUI sync view is now the changes view (key `4`). Its tab shows how many changes are pending, and `s` (from any view) or Enter (in the changes view) applies them after a confirm.
- The app and the TUI share one implementation for the "enabled on" phrase and for picking the newest plugin version.

### Fixed

- The TUI lays itself out again when the terminal is resized.
- TUI lines no longer wrap or draw over each other: the skills list keeps its width, the header and footer stay one line each (hosts that do not fit show as `+N`), and a skill detail taller than its panel is cut at the border.

## [0.4.3] - 2026-11-01

### Added

- The standalone `skm-darwin-*` CLI binaries are signed with the Developer ID and notarized, so a copy downloaded with a browser runs without a Gatekeeper prompt.

### Changed

- Releases build the arm64 and x64 apps in parallel.

## [0.4.2] - 2026-11-01

### Changed

- The desktop app checks for updates once each time it starts, instead of every 6 hours. Check by hand from About.

### Fixed

- An update download that receives no data for 60 seconds is abandoned and deleted, instead of staying at "downloading" forever after a dropped connection.

## [0.4.1] - 2026-11-01

### Added

- The macOS app is signed with a Developer ID and notarized by Apple. It opens without a trip to System Settings → Privacy & Security.
- A signed app installs an update only if the new app's code signature verifies and has the same Team ID.

## [0.4.0] - 2026-11-01

First public release.

### Added

- Desktop app (Electron) with Skills, Plugins and Hosts views, a pending-changes bar, settings, a command palette, and English and Simplified Chinese.
- `skm harness` and `skm harness update`: agent CLI, desktop app and tool versions on every host, and their updates.
- `skm plugin update`: update plugins whose versions drift across hosts, including plugins that ship with the ChatGPT desktop app.
- Extensions: YAML files in `~/.skm/extensions/` add agents, desktop apps and update tasks.
- Self-update from GitHub Releases with an Ed25519-signed manifest and SHA-512 checks.
- Release workflow with build provenance attestations and `SHA256SUMS`.

[Unreleased]: https://github.com/jokerlin/skill-manager/compare/v0.5.3...HEAD
[0.5.3]: https://github.com/jokerlin/skill-manager/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/jokerlin/skill-manager/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/jokerlin/skill-manager/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/jokerlin/skill-manager/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/jokerlin/skill-manager/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/jokerlin/skill-manager/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/jokerlin/skill-manager/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jokerlin/skill-manager/releases/tag/v0.4.0
