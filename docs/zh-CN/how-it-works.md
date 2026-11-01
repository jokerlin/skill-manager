# 工作原理

[English](../how-it-works.md) | 简体中文

## 目标状态

`desired(skill, host, agent) = hosts 选择器(host) ∧ agents 选择器(agent)`，再按顺序套用 `on` / `off` 单元格覆盖，最后要求该 agent 在这台主机上启用。

规则自上而下求值，后面的规则覆盖前面的。没有规则命中时用 `defaults`。`skm scope` 和 App 里的单元格开关写的是 `on` / `off` 覆盖；切回原状态时删掉自己加过的覆盖项，config.yaml 不留残余。

配置里出现不认识的 agent 时，CLI 会提示并忽略它。它不出现在 App 和 TUI 的列里，也不参与探测、同步和备份。

## 每个 agent 加载的来源

每个 agent 启动时会把下面这些地方的 SKILL.md 全部列进上下文。skm 按这个顺序探测，并合并成「有效清单」：

| 来源 | Claude Code | Codex | Pi | owner |
|---|---|---|---|---|
| 用户目录 | `~/.claude/skills` | `~/.agents/skills` | `~/.pi/agent/skills` | skm（软链）、owned 工具（真实目录）、手动 |
| 旧目录 / 兼容目录 | — | `~/.codex/skills` | Pi 也读 `~/.agents/skills`（同名时以 `~/.pi/agent/skills` 为准，另一份被遮蔽） | 同上 |
| 设置排除 | — | — | `~/.pi/agent/settings.json` 的 `skills` 里写 `-skills/<name>`，Pi 在两个目录里都跳过该 skill | skm（sync 维护） |
| 内置 | — | `~/.codex/skills/.system` | — | codex-builtin |
| plugin 缓存 | `~/.claude/plugins/cache/<mk>/<plugin>/<ver>/skills/*`；启用状态看 `settings.json` 的 `enabledPlugins`，生效版本看 `installed_plugins.json` | `~/.codex/plugins/cache/...`；看 `config.toml` 的 `[plugins."name@mk"] enabled`。缓存了但 config 里没写的，Codex 不加载，不计入 | — | claude-plugins / codex-plugins |

每一条都带：存储方式（`link→store`、`real dir`、`link→别处`、`plugin cache`、`builtin`）、owner、版本（plugin 版本或 owned 的 lock）、listing 字符数、正文 token、内容 hash。

### Pi 和 `~/.agents/skills`

Pi 也读 Codex 的 `~/.agents/skills`，所以只给 Codex 的 skill 会被 Pi 一起加载。sync 这样处理：一个 store 或 owned skill 在同步后会出现在 `~/.agents/skills`，但 Pi 不在它的目标里时，sync 在该机 `~/.pi/agent/settings.json` 的 `skills` 数组里写入 `-skills/<name>`（`pi: exclude <name>`）。Pi 重新成为目标，或 skill 离开该目录时，sync 删除这条排除项（`pi: unexclude <name>`）。

skm 只管这种精确写法、且名字属于 store 或 owned 的条目。其他条目（glob、`!pattern`、手写的其他名字）保持不变。编辑用主机上的 node 完成，找不到 node 时这条操作显示为 blocked。

## 发现项

- `same-name`：同一 agent 从两个来源加载同名 skill（如 Codex 内置的 `skill-creator` 和 plugin 版）。
- `linked-twice`：两个目录都软链到 store，同一批 skill 被加载两次（Codex 的 `~/.agents/skills` 加 `~/.codex/skills`）。
- `shadowed`：agent 按名字去重时（Pi：`~/.pi/agent/skills` 先于 `~/.agents/skills`），另一个目录里的同名副本不加载，也不计入预算。这只是提示；两份内容不同时会单独列出。
- `same-content`：名字不同，但 SKILL.md 完全相同。
- `owned-drift`：CLI 自己写的目录和链接给其他 agent 的 store 副本内容不一致。skm 提示把 store 副本刷新成 CLI 的版本。
- `stale-cache` / `disabled-cached` / `unloaded-cache`：plugin 缓存里有未生效的旧版本；配置里明确关掉但仍占磁盘；配置里根本没提（agent 从不加载的纯缓存残留）。
- `version-drift`：同一 plugin 在不同 主机 × agent 上的生效版本不一致。

## 同步操作

`plan` / `sync` 除了 rsync 和软链，还有几类不搬文件的操作：

- `marketplace-add`、`plugin-install`、`plugin-enable`、`plugin-disable`：通过 `claude plugin …` / `codex plugin …` 落地。Codex 没有 enable/disable 子命令时，直接改 `config.toml` 里的 `enabled`。
- `owned-ensure`：调用 owner CLI 的 `ensure` 命令安装。
- 主机上找不到对应 CLI 时，操作显示为 `blocked`，不会退化成拷文件。

主机缺 marketplace 时，`marketplace-add` 用 hub 配置里的来源。如果 hub 上它只是本地目录（Codex `source_type = "local"`，Claude `directory` / `file`，例如 ChatGPT 桌面版写入的 `openai-primary-runtime`），其他主机上的这条操作显示为 `blocked`。这时在该机手动添加，或用 `hosts` 选择器排除该机。

备份范围包括 store、所有 agent 用户目录，以及 `~/.claude/settings.json`、`~/.claude/plugins/installed_plugins.json`、`~/.codex/config.toml`。

## 上下文占用

**listing**（每轮都付）一律显示为 token。store 视图（`ls`、`show`、App 的技能页）用 o200k 估算 `description + when_to_use`。每个 主机 × agent 的预算按各 agent 自己的记账换算成 token。`status`、`inventory`、`doctor` 按有效清单（含 plugin、内置、旧目录）计算；主机不可达时才退回只按 store 估算。

### Claude Code

- 总预算（字符）= 模型上下文 token 数 × 每 token 字符数 × `skillListingBudgetFraction`（默认 1%）。
- 每 token 字符数：Opus/Sonnet 4.6 及更早、Haiku 4.5 取 4；其余（Fable、Opus 4.7+、Sonnet 5）取 3。
- 上下文来自各主机 `~/.claude/settings.json` 的 `model`：Fable、Opus 4.7+、Sonnet 5 原生 1M，老模型 200K；`[1m]` 后缀升到 1M；`env.CLAUDE_CODE_DISABLE_1M_CONTEXT` 压回 200K。和 `autoCompactWindow` 无关。
- `env.SLASH_COMMAND_TOOL_CHAR_BUDGET` 直接定死预算。单个 skill 上限 `skillListingMaxDescChars`（默认 1536）。
- 例：Fable 1M × 3 × 1% = 30,000 字符，显示为 10,000 token；Opus 4.6 200K × 4 × 1% = 8,000 字符 = 2,000 token。
- 超预算时按调用频率丢描述，名字永远保留。listing 字符按 `- name: description` 行计。Claude Code 自带的内置 skill 不在 skm 清单里，看真实数字用 Claude Code 的 `/context`。

### Codex

- 总预算（token）= 模型上下文窗口 × 2%。
- 窗口来自各主机 `~/.codex/config.toml` 的 `model` 在模型目录里的 `context_window`。目录由探测时的 `codex debug models` 给出；没有 codex CLI 时退回 `~/.codex/models_cache.json`。config.toml 没写 `model` 时，按 Codex 自己的规则取目录里 priority 最小的可见预设。`model_context_window` 可覆盖，封顶 `max_context_window`。目录都没有时才用 config 的 `contextTokens`。
- `[skills] max_context_tokens` 直接定死预算（封顶 10,000）。窗口未知时用 8,000 字符（约 2,000 token）。
- 每条 `- name: description (file: rN/path)` 按 ⌈字节/4⌉ 计 token。路径经 `### Skill roots` 别名表压缩，表本身也计费；plugin skill 名带 `plugin:` 前缀；只列 `description`，不含 `when_to_use`；单条不超过 1,024 字符。
- 超预算时先把所有描述轮询缩短（skill 都还在），连空描述都放不下才整条省略。

### Pi

Pi 没有公开的 listing 预算。skm 用 o200k 估算，不设上限。

**body**（激活时付）：SKILL.md 正文的 token 数和行数。规范建议少于 5,000 token、少于 500 行。

## 上游

`skm upstream` 对 `upstreams:` 下的每个 skill 比较三个摘要：

- **base**：skm 上次写入的内容，记录在 `~/.skm/upstreams.lock.json`
- **store**：store 目录的现状
- **target**：镜像（`~/.skm/cache/upstreams/<name>.git`）里目标 ref 下的目录

摘要是对每个文件的路径和 git blob id 求 SHA-256。所以 skm 不用 checkout，就能用同一种方法给 store 副本和仓库里的树算摘要。`.DS_Store`、`__pycache__`、`*.pyc` 和 `.git` 不计入。文件权限也不计入，但 `update` 会写入权限（`100755` 的文件可执行）。

`update` 先把 skill 写到 `<store>/.upstream-<skill>`，再换到原位置，然后读回来，核对摘要和目标一致。写入前，它在 hub 上备份要替换的 skill 目录和 lock 文件，所以 `skm restore <hub> <ts>` 能把两者一起还原。已经等于目标版本的 skill，lock 记录也会移到目标版本，这样以后的改动按正确的 base 判断。

## 备份和还原

每次 `sync` 应用前，每台目标主机上生成：

```
~/.skm/backups/<ts>/
├── snapshot.tar.gz   # store + 所有 agent 用户目录（软链按软链保存）
├── manifest.txt      # 各路径 present / absent
└── restore.sh        # sh restore.sh 回到快照时刻（删除现状 → 解包；快照时不存在的目录会被删掉）
```

远端的快照同时拉回 hub 的 `~/.skm/backups/<host>/<ts>/`。用 `skm restore <host> <ts>` 还原，或在主机上运行 `sh ~/.skm/backups/<ts>/restore.sh`。

警告：`restore.sh` 先删除快照覆盖的目录的现状，再解包。快照之后对这些目录做的改动全部丢失。

## 已知问题

`$HOME` 是软链接的主机（如 `/home/x → /mnt/data/home/x`）上，旧版 Codex 会把 `openai-bundled` 的 source 记成真实路径。Codex 0.166 因此隐藏这个 marketplace，`codex plugin add` 报 not found。把 `~/.codex/config.toml` 里这一行改回以 `$HOME` 开头的路径即可。
