# Changelog

All notable changes to Skill Manager. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The release workflow uses the section for a version as its GitHub release notes.

## [Unreleased]

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

[Unreleased]: https://github.com/jokerlin/skill-manager/compare/v0.4.2...HEAD
[0.4.2]: https://github.com/jokerlin/skill-manager/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/jokerlin/skill-manager/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jokerlin/skill-manager/releases/tag/v0.4.0
