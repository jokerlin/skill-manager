# Changelog

All notable changes to Skill Manager. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The release workflow uses the section for a version as its GitHub release notes.

## [Unreleased]

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

[Unreleased]: https://github.com/jokerlin/skill-manager/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/jokerlin/skill-manager/compare/v0.4.3...v0.5.0
[0.4.3]: https://github.com/jokerlin/skill-manager/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/jokerlin/skill-manager/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/jokerlin/skill-manager/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jokerlin/skill-manager/releases/tag/v0.4.0
