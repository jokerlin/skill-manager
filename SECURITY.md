# Security policy

English | [简体中文](#简体中文)

## Supported versions

Security fixes go into the latest release. Update the desktop app from **About → Check for updates**, or download the latest CLI from [Releases](https://github.com/jokerlin/skill-manager/releases).

## Report a vulnerability

Do not open a public issue for a security problem. Report it privately through GitHub: open the repository's **Security** tab and click **Report a vulnerability** ([direct link](https://github.com/jokerlin/skill-manager/security/advisories/new)).

Include the version, what an attacker can do, and the steps to reproduce. You should get a reply within 7 days. After a fix is released, the advisory is published with credit to you, unless you ask not to be named.

## Scope

These are in scope:

- The update path of the desktop app: manifest signature check, checksum check, and the app swap.
- Commands that skm runs on remote hosts over ssh, and the shell scripts it generates (quoting, paths, backups, restore).
- Config, extension and plugin data that leads skm to run a command or change a file it should not.
- The Electron app: IPC between the renderer and the main process, external links, file access.

Out of scope: problems that need an attacker who can already write to your `~/.skm/config.yaml`, `~/.skm/extensions/` or `~/.ssh/config`. Extensions run the commands they declare by design (see [docs/extensions.md](docs/extensions.md)).

## How releases are protected

- The release workflow signs `latest-mac.json` with an Ed25519 key that only exists as a GitHub Actions secret. The app installs an update only when the signature verifies against the public key built into it, and the zip matches the signed SHA-512.
- Every release asset has a build provenance attestation: `gh attestation verify <file> --repo jokerlin/skill-manager`.
- `SHA256SUMS` lists the checksum of every asset.
- From 0.4.1 the app is signed with a Developer ID (Team ID `A5T4ZJ88AT`) and notarized by Apple. A signed app installs an update only if the new bundle's code signature verifies and has the same Team ID.

---

## 简体中文

### 支持的版本

安全修复只进入最新 release。桌面 App 在 **关于 → 检查更新** 里更新，CLI 从 [Releases](https://github.com/jokerlin/skill-manager/releases) 下载最新版。

### 报告漏洞

不要为安全问题开公开 issue。请通过 GitHub 私下报告：打开仓库的 **Security** 标签页，点击 **Report a vulnerability**（[直达链接](https://github.com/jokerlin/skill-manager/security/advisories/new)）。

请写明版本、攻击者能做到什么、复现步骤。7 天内会有回复。修复发布后会公开这份 advisory 并致谢你；如果你不想署名，请说明。

### 范围

以下属于范围内：

- 桌面 App 的更新链路：清单签名校验、校验和校验、替换 App。
- skm 通过 ssh 在远端主机上执行的命令，以及它生成的 shell 脚本（引号、路径、备份、还原）。
- 会让 skm 执行不该执行的命令、或改动不该改动的文件的配置、扩展和 plugin 数据。
- Electron App：渲染层和主进程之间的 IPC、外部链接、文件访问。

范围外：需要攻击者已经能写你的 `~/.skm/config.yaml`、`~/.skm/extensions/` 或 `~/.ssh/config` 才能成立的问题。扩展按设计会执行它声明的命令（见 [docs/zh-CN/extensions.md](docs/zh-CN/extensions.md)）。

### release 的保护方式

- Release 工作流用 Ed25519 私钥给 `latest-mac.json` 签名，私钥只存在于 GitHub Actions secret 里。只有签名能用 App 内置的公钥验证通过、且 zip 和签名里的 SHA-512 一致时，App 才安装更新。
- 每个 release 文件都带构建来源证明：`gh attestation verify <文件> --repo jokerlin/skill-manager`。
- `SHA256SUMS` 列出每个文件的校验和。
- 从 0.4.1 起，App 用 Developer ID（Team ID `A5T4ZJ88AT`）签名并经过 Apple 公证。已签名的 App 只安装代码签名校验通过、且 Team ID 相同的新版本。
