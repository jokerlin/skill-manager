# skm — 多机、多 Agent 的 Skill 管理器

一个 store，处处软链，跨机器 rsync。

```
~/.skm/skills/<name>/SKILL.md     ← 单一事实源（store）
~/.claude/skills/<name>  ─┐
~/.agents/skills/<name>  ─┼─→ 软链到 store（Claude Code / Codex / Cursor / Gemini …）
~/.cursor/skills/<name>  ─┘
mini:~/.skm/skills  devbox:~/.skm/skills   ← rsync 镜像，远端再本地软链
```

远端主机只需要 `ssh`、`rsync`、POSIX `sh`，不用安装任何东西。

v2 起，skm 的清单以「每个 agent 实际会加载什么」为准：用户目录、旧目录、Codex 内置、Claude/Codex plugin 缓存全部罗列，并标出每一条是怎么存储、归谁管的。store + 软链只是其中一种存储方式；plugin 和 CLI 自带的 skill 留在各自的 owner 那里，skm 只统一「清单 + 策略」，不搬文件。

## 安装

```sh
bun install
bun run build            # → dist/skm（单文件可执行）
cp dist/skm ~/.local/bin/skm
# 或直接：bun run bin/skm.ts <cmd>
```

## 五分钟上手

```sh
skm init                                   # 建 ~/.skm/{config.yaml,skills}，列出各 agent 目录里未纳管的 skill
skm adopt --from claude codex cursor       # 把真实目录搬进 store，原位置留软链（链式软链会被改成直链）
skm status                                 # 探测每台主机：每个 agent 实际消费了哪些 skill、有无漂移/冲突
skm pull mini --all                        # 把远端有而 hub 没有的 skill 拉回 store
skm rules infer --write                    # 按"每台机器现在有什么"自动生成范围规则
skm sync --dry-run                         # 看 plan
skm sync --replace-conflicts               # 备份 → rsync → 软链（远端真实目录移入备份后换成软链）
skm                                        # TUI
```

## 配置 `~/.skm/config.yaml`

```yaml
store: ~/.skm/skills
agents: [claude, codex, pi, dsh]           # 可用 id 见 src/core/agents.ts（claude/codex/pi/dsh/opencode/cursor/gemini/…）
hosts:
  local: {}
  mini: { ssh: mini }                       # ~/.ssh/config 里的别名
  devbox: { ssh: devbox, agents: [claude, codex] }   # 该主机只启用这两个 agent
defaults: { hosts: all, agents: all }       # 未命中规则的 skill 默认去向
rules:                                      # 自上而下，后者覆盖前者；skills 支持 glob
  - skills: ["kb-*"]
    hosts: { except: [devbox] }
  - skills: ["corp-*"]
    hosts: { only: [mini, devbox] }
  - skills: [hatch-pet]
    agents: { only: [codex] }
    off: ["mini/codex"]                     # 精确到 主机/agent 的单元格开关（TUI 里按空格生成）
plugins:                                    # v2：期望状态扩展到 plugin，由 claude/codex CLI 落地，不拷文件
  superpowers: { marketplace: claude-plugins-official, agents: { only: [claude, codex] } }
  linear-cli: { marketplace: { claude: linear-cli, codex: linear-cli }, hosts: { except: [home-mini] } }
  humanizer: { marketplace: claude-extras, enabled: false }   # enabled: false：凡是装了的主机都关掉，不看 hosts/agents 选择器；把"禁用"记在 skm 里而不是手改 config.toml
owned:                                      # v2：某个 CLI 自带的 skill（真实目录），skm 不软链，只核对
  acme: { tool: acme }              # ensure 默认 `acme self skill install -g -s acme`；fallback: store|none
eval: { agent: claude }                     # 或 codex；model 可选
contextTokens: 1000000                      # 预算模拟的兜底上下文：Claude 按各主机 settings.json 的 model、Codex 按 config.toml 的 model 在 `codex debug models` 目录里的窗口（没写 model 时取目录的默认预设）推断，认不出时才用它
backupBeforeApply: true
```

求值：`desired(skill, host, agent) = hosts选择器(host) ∧ agents选择器(agent)`，再按顺序套用 `on/off` 单元格覆盖，最后要求 agent 在该主机启用。

## 命令

| 命令 | 作用 |
|---|---|
| `skm` | TUI：skills / hosts / sync / insights / help 五个视图 |
| `skm init` | 初始化，列出未纳管 skill |
| `skm adopt <path…> \| --from <agent…>` | 真实目录 → store + 软链 |
| `skm ls [--json] [--host H] [--agent A] [--sort cost]` | 列表 + 上下文占用 |
| `skm show <skill>` | 详情、成本、主机×agent 矩阵、启发式提示 |
| `skm status [--host H] [--json]` | 探测：每个 主机×agent 从所有来源加载的 skill 数（user / legacy / builtin / plugin）、listing 预算、漂移、冲突、blocked、remote-only |
| `skm inventory [--host H] [--agent A] [--json]` | v2 清单：每个 主机×agent 实际加载的每一条 skill——来源、存储方式、owner、版本、listing/body 成本，以及同名/同内容/陈旧缓存等发现 |
| `skm plan` / `skm sync [--dry-run] [--replace-conflicts] [-y] [--no-backup]` | 计算/执行同步；apply 前自动备份；apply 后重新探测验证 |
| `skm pull <host> [skills…] \| --all [--force]` | 远端 store 或 agent 目录里的未纳管 skill → hub |
| `skm rules infer [--write]` | 从各主机现状推导主机级规则 |
| `skm backup [hosts…]` / `skm backups [host]` / `skm restore <host> <ts>` | 快照与一键还原 |
| `skm doctor [--cached] [--host H] [--json]` | 规范校验、启发式、每个 主机×agent 覆盖所有来源的 listing 预算模拟、跨主机 plugin 版本漂移；`--cached` 用上次探测缓存（`~/.skm/cache/inventory/`），不走 ssh |
| `skm eval [skills…] [--all] [--agent claude\|codex] [--fresh] [--cached] [--json] [--batch n]` | LLM 评估（`--all` 把本机 plugin / 真实目录里的 skill 也评，名字形如 `plugin:skill`）：有用度、描述质量、重复、建议；按内容 hash 缓存。claude 先试 `-p --bare`（最省上下文，需要 API key），登录态是订阅时自动回退到普通 `-p`（关掉工具/MCP/skills） |

## v2：按消费方罗列 skill 来源

每个 agent 启动时会把下面这些地方的 SKILL.md 全部列进上下文，skm 按这个顺序探测并合并成「有效清单」：

| 来源 | Claude Code | Codex | pi / dsh | owner |
|---|---|---|---|---|
| 用户目录 | `~/.claude/skills` | `~/.agents/skills` | `~/.pi/agent/skills` / `~/.dsh/skills` | skm（软链）、acme / skills-cli（真实目录）、manual |
| 旧目录 / 兼容目录 | — | `~/.codex/skills` | dsh 还读 `~/.agents/skills`（同名以 `~/.dsh/skills` 为准，另一份被遮蔽、不加载） | 同上 |
| 内置 | — | `~/.codex/skills/.system` | — | codex-builtin |
| plugin 缓存 | `~/.claude/plugins/cache/<mk>/<plugin>/<ver>/skills/*`，启用状态看 `settings.json` `enabledPlugins`，生效版本看 `installed_plugins.json` | `~/.codex/plugins/cache/...`，`config.toml` `[plugins."name@mk"] enabled`；缓存了但没写 config 的 Codex 不会加载，不计入（2026-09-06 用真实会话核对） | — | claude-plugins / codex-plugins |

每一条都带：存储方式（`link→store`、`real dir`、`link→别处`、`plugin cache`、`builtin`）、owner、版本（plugin 版本 / acme lock / skills-cli lock）、listing 字符数、body token、内容 hash。发现项：

- `same-name`：同一 agent 从两个来源加载同名 skill（如 Codex 内置 `skill-creator` 与 plugin 版）。
- `linked-twice`：两个目录都软链到 store，同一批 skill 被加载两次（Codex 的 `~/.agents/skills` + `~/.codex/skills`）。
- `shadowed`：agent 按名字去重时（dsh：`~/.dsh/skills` 先于 `~/.agents/skills`），另一目录里的同名副本不会加载，也不计入预算；只是提示，若两份内容不同会单独列出。
- `same-content`：不同名但 SKILL.md 完全相同。
- `stale-cache` / `disabled-cached` / `unloaded-cache`：plugin 缓存里有未生效的旧版本 / 配置里明确关掉但仍占磁盘 / 配置里根本没提（Codex：config.toml 没有 `[plugins."id"]`，多半 marketplace 也没配；Claude：不在 `enabledPlugins` 也不在 `installed_plugins.json`），agent 从不加载的纯缓存残留，例如 Codex 桌面端遗留的 openai-templates、gmail、finances。
- `version-drift`：同一 plugin 在不同 主机×agent 生效版本不一致。

期望状态扩展到 plugin 与 owner 自带 skill 之后，`plan/sync` 多了几类不搬文件的 op：`marketplace-add`、`plugin-install`、`plugin-enable`、`plugin-disable`（走 `claude plugin …` / `codex plugin …`，Codex 没有 enable/disable 子命令时直接改 `config.toml` 的 `enabled`）、`owned-ensure`（调 owner CLI 安装）；主机上找不到对应 CLI 时给出 `blocked`，不会退化成拷文件。备份范围同时包含 `~/.claude/settings.json`、`~/.claude/plugins/installed_plugins.json`、`~/.codex/config.toml`。

## 上下文占用怎么算

- **listing**（每轮都付）：一律显示 token。store 视图（`ls / show` / App 的 Skills）用 o200k 估算 `description + when_to_use`；每主机×agent 的预算按各 agent 自己的记账换算成 token：Claude = 字符 ÷ 每 token 字符数，Codex = ⌈字节/4⌉，pi/dsh 等没有文档预算的用 o200k 估算、不设上限。v2 的 `status / inventory / doctor` 按有效清单（含 plugin、内置、旧目录）算，主机不可达时才退回只按 store 估。
  - Claude Code：总预算（字符）= 模型上下文 token 数 × 每 token 字符数 × `skillListingBudgetFraction`（默认 1%），每 token 字符数对 Opus/Sonnet ≤4.6 与 Haiku 4.5 取 4、其余（Fable、Opus 4.7+、Sonnet 5）取 3；上下文来自各主机 `~/.claude/settings.json` 的 `model`（Fable/Opus 4.7+/Sonnet 5 原生 1M，老模型 200K，`[1m]` 后缀升 1M，`env.CLAUDE_CODE_DISABLE_1M_CONTEXT` 压回 200K），与 `autoCompactWindow` 无关；`env.SLASH_COMMAND_TOOL_CHAR_BUDGET` 直接定死预算。例：Fable 1M × 3 × 1% = 30,000 字符，显示为 1M × 1% = 10,000 token；Opus 4.6 200K × 4 × 1% = 8,000 字符 = 2,000 token。单个 skill 上限 `skillListingMaxDescChars`（默认 1536）；超预算时按调用频率丢描述，名字永远保留。listing 字符按 Claude Code 的 `- name: description` 行计；Claude Code 自带的内置 skill（code-review、simplify 等十余个）不在 skm 清单里，看真实数字用 Claude Code 的 `/context`。（公式来自 Claude Code 2.1.263 二进制，见 `docs/reports/2026-09-06-listing-budget-fix.md`）
  - Codex：总预算（token）= 模型上下文窗口 × 2%，窗口来自各主机 `~/.codex/config.toml` 的 `model` 在模型目录里的 `context_window`（目录由探测时的 `codex debug models` 给出，没有 codex CLI 时退回 `~/.codex/models_cache.json`；config.toml 没写 `model` 时按 Codex 自己的规则取目录里 priority 最小的可见预设，例如 home-mini 没写 model 也算 gpt-6-astra 的 272K；`model_context_window` 可覆盖，封顶 `max_context_window`；目录都没有时才用 config `contextTokens`）；`[skills] max_context_tokens` 直接定死（封顶 10,000）；窗口未知时 8,000 字符（显示 ≈ 2,000 token）。每条 `- name: description (file: rN/path)` 按 ⌈字节/4⌉ 计 token（路径经 `### Skill roots` 别名表压缩，表本身也计费；plugin 技能名带 `plugin:` 前缀；只列 `description`，不含 `when_to_use`；单条 ≤1,024 字符）。超预算时先把所有描述按轮询缩短（技能都还在），连空描述都放不下才整条省略。例：gpt-6-astra 272K × 2% = 5,440 token（它的 `context_window` 就是 272K，真实会话报 `model_context_window: 258400` = 272K × 95%；872K 的 `max_context_window` 只在 config.toml 写了 `model_context_window` 时才用得上，所以 Claude 10,000t 与 Codex 5,440t 的差距是真的：1M × 1% 对 272K × 2%）。（公式来自 codex-rs/ext/skills/src/render.rs，并用 codex 0.153.4 真实会话核对，见 `docs/reports/2026-09-06-listing-budget-fix.md`）
- **body**（激活时付）：SKILL.md 正文 token 与行数；规范建议 <5000 token、<500 行。

## 备份 / 一键还原

每次 `sync` apply 前，每台目标主机上生成：

```
~/.skm/backups/<ts>/
├── snapshot.tar.gz   # store + 所有 agent 用户级目录（软链按软链保存）
├── manifest.txt      # present/absent 各路径
└── restore.sh        # sh restore.sh 即回到快照时刻（删除现状 → 解包；快照时不存在的目录会被删掉）
```

远端的快照同时拉回 hub 的 `~/.skm/backups/<host>/<ts>/`。还原：`skm restore <host> <ts>` 或在主机上 `sh ~/.skm/backups/<ts>/restore.sh`。

## 安全边界

- 只删除"指向 store 且 hub 认识该 skill"的软链；真实目录、指向别处的软链、远端独有的 store skill 一律不动（除非 `--replace-conflicts`，且先移入备份）。
- 主机不可达不影响其他主机。
- plugin / owned 类 op 只通过各自 owner 的 CLI 落地（`claude plugin`、`codex plugin`、`acme self skill`），从不改 plugin 缓存目录；CLI 缺失时 op 变成 `blocked`。
- 所有 IO 返回 `Result`，错误为标签联合并穷尽渲染。

## Mac App

`macos/` 是一层 SwiftUI 外壳（macOS 14+），所有逻辑仍在 CLI 里：App 只调用 `skm ... --json`，同步/备份/评估则流式读取 `skm sync -y` 等命令的输出。

```sh
sh macos/build.sh            # 产出 macos/dist/Skm.app（需要 Xcode 命令行工具；先安装 skm 到 ~/.local/bin）
open macos/dist/Skm.app
```

- 左侧 Skills / Hosts / Sync / Insights 与 TUI 的四个视图一一对应；底部是各机器的连通/待同步状态。
- **Skills 是全集**：store 里的 skill 之外，还列出各主机 agent 实际加载的 plugin skill、Codex 内置 skill、未纳管目录，可按 Store / Plugins / Builtin / Unmanaged 过滤；每行给出来源、listing/body 成本、跨主机版本（不一致标红）、在哪些主机被多少个 agent 加载。选中 store skill 可点 host × agent 格子开关作用域（等价于 `skm scope`）；选中 plugin skill 则看到它在每个 主机×agent 的加载情况、版本、缓存路径和管理方式。
- **Hosts 是主从式**：左边每台主机下一行一个 agent，标签写明「N linked to store / N real dir / N link elsewhere / N broken link / legacy dir / builtin / from plugins」和 listing 预算；点一行，右边列出这个 agent 启动时加载的每一条 skill（来源、存储、owner、版本、成本）、plugin 列表和相关发现。
- 颜色约定：description 超过 Claude 的 1536 字符上限、body 超过 5000 token 标橙；预算超出标红。所有 listing/预算数字都是 token。
- 找不到 CLI 时在 设置（⌘,）里填 `skm` 路径，或 `bun run <repo>/bin/skm.ts`。
- 无头截图（文档/CI 用，不需要"屏幕录制"权限）：`SKM_SNAPSHOT=/tmp/skm ./macos/dist/Skm.app/Contents/MacOS/Skm` 会写出 `/tmp/skm-{skills,hosts,sync,insights}.png` 后自动退出；屏幕锁定或显示器休眠时窗口抓图是空白的，加 `SKM_SNAPSHOT_OFFSCREEN=1` 改走视图层级离屏渲染。
- TUI 同样可以无头出图：`bun scripts/tui-snapshot.tsx out.txt`。

## 开发

```sh
bun test            # 101 个测试：纯核心 + 用临时 HOME 跑真实 sh/rsync 的集成测试 + TUI 渲染
bun run typecheck
```

结构：`src/core`（纯函数：frontmatter、规则求值、来源/plugin 状态解析（`sources.ts`、`effective.ts`）、diff→Op[]、sh 脚本生成、预算模拟、去重）→ `src/shell`（文件系统、ssh/rsync、子进程）→ `src/cli` / `src/tui`。
