# 参与贡献

[English](CONTRIBUTING.md) | 简体中文

感谢你帮助改进 Skill Manager。欢迎提交 bug 报告、修复、文档和翻译。

## 开始之前

- 报 bug：开一个 issue，附上 `skm --version` 的输出、操作系统、涉及的 agent，以及能复现问题的最少步骤。不想公开的主机名、路径和 skill 名请先删掉。
- 提新功能：先开 issue，说明它要解决什么问题。只有某一种环境才需要的功能，通常更适合做成[扩展](docs/zh-CN/extensions.md)。
- 安全问题：不要开公开 issue，见 [SECURITY.md](SECURITY.md)。

## 搭建环境

需要 [Bun](https://bun.sh) 1.3 或更高版本、`rsync`；桌面 App 需要 macOS。

```sh
git clone https://github.com/jokerlin/skill-manager.git
cd skill-manager
bun install
(cd desktop && bun install)

bun run dev status           # 从源码运行 CLI
cd desktop && SKM_COMMAND="bun run $PWD/../bin/skm.ts" bun run dev   # 运行 App，并使用源码里的 CLI
```

测试使用临时 `HOME`，不会碰你真实的 `~/.skm`、`~/.claude`、`~/.codex`。

警告：从源码运行 `skm sync` 会作用在你真实的主机上。先运行 `skm plan`，或者把 `HOME` 指向一个测试目录。

## 目录结构

```
src/core/     纯函数：配置、规则、来源、plan（diff → 操作）、预算、扩展
src/shell/    副作用：文件系统、ssh、rsync、子进程
src/cli/      命令（Commander）
src/tui/      终端界面（Ink）
desktop/      Electron App：主进程、preload、React 渲染层
tests/        bun test：纯核心、用真实 sh/rsync 的集成测试、TUI 渲染
docs/         用户文档（英文，以及 docs/zh-CN）
```

桌面 App 自己不计算状态。它运行 `skm … --json`，写操作调用 `skm scope` 和 `skm config patch`。行为上的改动先改 CLI。

## 代码风格

- `src/core` 保持纯净：不碰文件系统、网络、时间和随机数。副作用放在 `src/shell`。
- 可预期的失败返回 `Result` / option 值。只有真正的 bug 才抛异常。
- 状态用带标签的联合类型建模，并穷尽匹配每个分支（`ts-pattern` 的 `.exhaustive()`，或不带 default 的 `switch`）。
- 优先用 `map` / `filter` / `reduce`，不写修改变量的循环。class 只用于对接外部系统的适配器。
- 注释写「为什么」，不写「做了什么」。
- App 里用户可见的文字都走 `desktop/src/renderer/src/i18n`。每个新 key 都要同时加到 `en` 和 `zh`。

## 提交 pull request 之前

```sh
bun run typecheck
bun test
(cd desktop && bun run typecheck && bun run build)
```

- 行为变化要补上或更新测试。修 bug 时附一个不修就会失败的测试。
- 改了命令、配置或 App 行为时，同步更新 `README.md`、`README.zh-CN.md` 和 `docs/`。
- 一个 pull request 只做一件事。写清楚改了什么、为什么改、怎么验证的。
- 不要提交个人数据：主机名、ssh 别名、家目录下的真实路径、token、私有 skill 名。
- commit 标题用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)，例如 `fix(plan): …`、`feat(desktop): …`。

每个 pull request 都会在 CI 里用 Linux 和 macOS 跑同样的检查。

## 翻译

App 的文案在 `desktop/src/renderer/src/i18n/en.ts` 和 `zh.ts`。新增语言时，复制 `en.ts`，翻译各个值，再在 `i18n/index.ts` 里注册这个 locale。同一种语言里，产品术语（skill、plugin、agent、主机）保持一致。

## 发布

### 什么时候发版

只在用户升级后能注意到变化、或因此避开问题时发版。每发一次版，所有 App 用户都要下载约 140 MB。

| 改动 | 是否发版 |
|---|---|
| 安全修复、数据丢失、启动崩溃、自动更新本身的 bug | 立即发。更新器坏了，之后的版本都送不到用户手上。 |
| 用户能感知的 bug 修复或新功能 | 攒几条再发。 |
| 运行时依赖更新 | 修复已知漏洞时立即发，否则跟下个版本走。 |
| 文档、README、截图 | 不发。 |
| CI、发布流程、Dependabot、仓库设置 | 不发。发布流程的改动用试跑验证（见下文）。 |
| 测试、不改行为的重构、开发依赖 | 不发。 |
| 用户感知不到的构建改动 | 不单独发，跟下个版本走。 |

不发版的改动照常合进 `main`。用户会关心的改动，在 `CHANGELOG.md` 的 `[Unreleased]` 下记一条。

想验证发布流程的改动又不想发布时，手动运行它：Actions → Release → Run workflow。它会完成构建、签名和公证，把产物存成 workflow artifact，不发布 release。

### 怎么发版

维护者从 `main` 发布：

1. 把 `CHANGELOG.md` 里 `[Unreleased]` 下的条目移到新的 `## [<版本>] - <日期>` 标题下。release 说明取自这一节。
2. 在 `package.json` 和 `desktop/package.json` 里写同一个版本号，然后提交。
3. 运行 `sh desktop/scripts/release.sh`。脚本检查两个版本号一致、工作区干净，然后创建并推送 tag `v<版本>`。
4. Release 工作流跑测试，构建 macOS 和 Linux 的 CLI、arm64 和 x64 的 App，给 App 和 macOS CLI 签名并公证，给 `latest-mac.json` 签名，生成 `SHA256SUMS`，加上构建来源证明，再发布 GitHub release。

警告：推送 tag 会发布一个公开 release，已安装的 App 会把它当作更新提示给用户。

更新签名密钥：

- 工作流从仓库 secret `SKM_UPDATE_SIGN_KEY` 读取 Ed25519 私钥。对应的公钥是 `desktop/package.json` 里的 `updatePublicKey`。
- 私钥丢失后，已安装的 App 无法验证新 release，用户只能手动下载下一个版本。
- 自己发布 release 的 fork 需要生成自己的密钥对，并替换 `updatePublicKey`：

  ```sh
  bun desktop/scripts/update-keygen.ts ~/update-signing-key.pem   # 把打印出的公钥粘贴到 desktop/package.json 的 "updatePublicKey"
  gh secret set SKM_UPDATE_SIGN_KEY < ~/update-signing-key.pem
  ```

  `update-signing-key.pem` 放在仓库之外。

代码签名和公证（macOS）：

- 工作流用 Developer ID Application 证书签名 App，并用 App Store Connect API Key 提交公证。它读取五个 secret：`MAC_CSC_LINK`（含证书、私钥和 Developer ID G2 中间证书的 `.p12`，base64）、`MAC_CSC_KEY_PASSWORD`、`APPLE_API_KEY`（`.p8`，单行 base64）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`。
- 构建后对每个 App 运行 `codesign --verify`、`spctl --assess` 和 `stapler validate`，任何一项失败，工作流就失败。
- 没有这些 secret 时（fork、本地 `bun run pack`），electron-builder 跳过签名，App 是 ad-hoc 签名，用户需要在 系统设置 → 隐私与安全性 里放行。
- 警告：已签名的 App 会锁定 Team ID。其他团队签名或未签名的 release，已签名 App 的更新器会拒绝安装。

## 行为准则

本项目遵守 [Contributor Covenant](CODE_OF_CONDUCT.md)。参与即表示你同意遵守。

## 许可证

提交贡献即表示你同意以 [MIT 许可证](LICENSE) 授权你的贡献。
