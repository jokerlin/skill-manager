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
agents: [claude, codex, cursor, gemini]
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
eval: { agent: claude }                     # 或 codex；model 可选
contextTokens: 200000                       # 用于上下文预算模拟
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
| `skm status [--host H] [--json]` | 探测：每个 agent 实际消费的 skill（含旧目录副本）、漂移、冲突、remote-only |
| `skm plan` / `skm sync [--dry-run] [--replace-conflicts] [-y] [--no-backup]` | 计算/执行同步；apply 前自动备份；apply 后重新探测验证 |
| `skm pull <host> [skills…] \| --all [--force]` | 远端 store 或 agent 目录里的未纳管 skill → hub |
| `skm rules infer [--write]` | 从各主机现状推导主机级规则 |
| `skm backup [hosts…]` / `skm backups [host]` / `skm restore <host> <ts>` | 快照与一键还原 |
| `skm doctor` | 规范校验、启发式、每个 主机×agent 的 listing 预算模拟 |
| `skm eval [skills…] [--agent claude\|codex] [--fresh] [--cached] [--json] [--batch n]` | LLM 评估：有用度、描述质量、重复、建议；按内容 hash 缓存。claude 先试 `-p --bare`（最省上下文，需要 API key），登录态是订阅时自动回退到普通 `-p`（关掉工具/MCP/skills） |

## 上下文占用怎么算

- **listing**（每轮都付）：`description + when_to_use` 的字符数与估算 token（o200k 编码，仅供比较）。
  - Claude Code：总预算 = 上下文 × `skillListingBudgetFraction`（默认 1%）字符，单个 skill 上限 `skillListingMaxDescChars`（默认 1536）；超预算时按调用频率丢描述。`skm doctor` 会读你 `~/.claude/settings.json` 里的覆盖值做模拟。
  - Codex：总预算 = 上下文 × 2%（未知时 8000 字符），超出先压缩描述。
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
- 所有 IO 返回 `Result`，错误为标签联合并穷尽渲染。

## Mac App

`macos/` 是一层 SwiftUI 外壳（macOS 14+），所有逻辑仍在 CLI 里：App 只调用 `skm ... --json`，同步/备份/评估则流式读取 `skm sync -y` 等命令的输出。

```sh
sh macos/build.sh            # 产出 macos/dist/Skm.app（需要 Xcode 命令行工具；先安装 skm 到 ~/.local/bin）
open macos/dist/Skm.app
```

- 左侧 Skills / Hosts / Sync / Insights 与 TUI 的四个视图一一对应；底部是各机器的连通/待同步状态。
- 选中一个 skill 后，点击右侧 host × agent 格子即可开关作用域（等价于 `skm scope`）。
- 找不到 CLI 时在 设置（⌘,）里填 `skm` 路径，或 `bun run <repo>/bin/skm.ts`。
- 无头截图（文档/CI 用，不需要"屏幕录制"权限）：`SKM_SNAPSHOT=/tmp/skm ./macos/dist/Skm.app/Contents/MacOS/Skm` 会写出 `/tmp/skm-{skills,hosts,sync,insights}.png` 后自动退出。
- TUI 同样可以无头出图：`bun scripts/tui-snapshot.tsx out.txt`。

## 开发

```sh
bun test            # 64 个测试：纯核心 + 用临时 HOME 跑真实 sh/rsync 的集成测试 + TUI 渲染
bun run typecheck
```

结构：`src/core`（纯函数：frontmatter、规则求值、diff→Op[]、sh 脚本生成、预算模拟、去重）→ `src/shell`（文件系统、ssh/rsync、子进程）→ `src/cli` / `src/tui`。
