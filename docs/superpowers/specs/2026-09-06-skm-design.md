# skm — 多机多 Agent 的 Skill 管理器 设计文档

日期：2026-09-06
状态：已定稿（用户授权自主实现）

## 1. 目标

管理 coding agent（Claude Code、Codex、Cursor、Gemini CLI 等）的 skill，覆盖本机与多台 SSH 主机：

1. TUI 界面。
2. 多机（本机 / mini / home-mini / devbox）的 skill 查看、同步、个性化：大部分 skill 相同，同时支持 **agent × 主机** 的个性化范围。
3. 架构：skill 目录是**单一事实源**（store），agent 目录里只有软链。跨机器无法软链，用 **rsync 把 store 镜像到远端，再在远端本地建软链**。
4. 一眼看清每个 skill 做什么、占多少上下文。
5. 用 `claude -p` / `codex exec` 评估 skill 是否有用、是否重复，并给出建议。

## 2. 调研结论（用于定位差异）

| 工具 | 单一事实源 | 多 agent 软链 | 多机 | 上下文占用 | AI 评估 | TUI |
|---|---|---|---|---|---|---|
| Vercel `skills` CLI | `~/.agents/skills` | 有（安装时） | 无 | 无 | 无 | 无（交互式安装） |
| runkids/skillshare (Go) | `~/.config/skillshare/skills` | 有，含 per-target include/exclude、copy 模式 | 通过 git clone + sync，无 SSH 推送 | 无 | 无 | 有详情页 + Web UI |
| xingkongliang/skills-manager (Tauri) | `~/.skills-manager` + SQLite | 有 | git 备份 | 无 | 无 | 桌面 GUI |
| Claude Code 内置 `/skill-doctor` | — | — | — | 有（仅本机本 agent） | 无 | — |

差异化：本工具补上 **SSH 多机推送 + 主机×agent 矩阵 + 上下文预算模拟（按各 agent 真实规则）+ LLM 评估**，并保留"store 单一事实源、其余全是软链"的干净结构。

关键事实（实现依据）：

- Agent Skills 规范：`name` ≤64 字符小写连字符且须与目录名一致；`description` 1–1024 字符；推荐 SKILL.md 正文 <5000 token、<500 行。
- Claude Code：listing 字符预算 = 模型上下文 token × 每 token 字符数（老模型 4、Fable/Opus 4.7+/Sonnet 5 为 3）× `skillListingBudgetFraction`（默认 0.01）；上下文由 `settings.json` 的 `model` 决定（Fable 原生 1M），不是 `autoCompactWindow`；`env.SLASH_COMMAND_TOOL_CHAR_BUDGET` 可定死预算。单个 skill `description + when_to_use` 上限 `skillListingMaxDescChars`（默认 1536）；超预算时按调用频率丢弃描述。用户级目录 `~/.claude/skills`。（2026-09-06 修正：此前按「上下文 × 1% 直接当字符」低估 4–15 倍，见 `docs/reports/2026-09-06-listing-budget-fix.md`）UI 一律显示 token：Claude 把两边都除以每 token 字符数（Fable 1M → 10,000 token），Codex 本来就是 token，其余 agent 用 o200k 估算且无上限。
- Codex：用户级目录 `~/.agents/skills`（跟随软链），listing 预算 = 上下文 2% 或未知时 8000 字符，超出先压缩描述。旧目录 `~/.codex/skills` 中的副本会造成重复加载。
- dsh：`~/.dsh/skills`（rank 400）与 `~/.agents/skills`（rank 500）按名字去重，先到先得；同名副本在 skm 里记为 shadowed（`Agent.duplicates: "user-dir-first"`），不计加载、不计预算，只出一条 `shadowed` 发现。
- Vercel `skills` CLI 的 agent → 目录映射表（见 `src/core/agents.ts`）。

## 3. 架构

```
~/.skm/
├── config.yaml        # 主机、agent、范围规则
├── skills/            # STORE：单一事实源，每个子目录一个 skill
├── backups/<ts>/      # 每次 apply 前的快照 + restore.sh
└── cache/             # 评估结果缓存（按内容哈希）
```

每台主机同构：远端也有 `~/.skm/skills`（由 hub rsync 镜像）与 `~/.skm/backups`。远端**不需要安装本工具**，只需 `ssh`、`rsync`、POSIX `sh`。

数据流（纯函数核心 + 薄外壳）：

```
config.yaml ─┐
store 扫描 ──┼─► Model(Skill[], Host[], Agent[]) ─► desired(host, agent) ─┐
远端 probe ──┘                                                            ├─► diff ─► Op[] ─► Executor(local | ssh) ─► Report
                                                     current(host, agent) ─┘
```

- **纯核心**（无 IO）：frontmatter 解析、范围规则求值、期望状态计算、diff → `Op[]`、上下文预算模拟、去重启发式、sh 脚本生成。
- **外壳**：文件系统、ssh/rsync 子进程、`claude`/`codex` 子进程、Ink TUI。

### 3.1 领域模型（ADT）

```ts
type AgentId = 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'copilot' | 'windsurf' | ...
type Agent = { id: AgentId; name: string; userDir: (home: string) => string; listing: ListingRule }
type ListingRule =
  | { kind: 'claude'; budgetFraction: number; maxDescChars: number; contextTokens: number }
  | { kind: 'codex'; budgetFraction: number; fallbackChars: number; contextTokens: number }
  | { kind: 'unknown' }

type Host =
  | { kind: 'local'; id: 'local'; home: string; skm: string }
  | { kind: 'ssh'; id: string; ssh: string; home?: string; skm: string }   // ssh = ~/.ssh/config alias

type Skill = {
  name: string; dir: string;
  frontmatter: Result<Frontmatter, FrontmatterError>;
  body: string; files: FileStat[];
  cost: { descChars: number; descTokens: number; bodyTokens: number; bodyLines: number; totalBytes: number }
}

type Scope = { hosts: Selector; agents: Selector }     // Selector = 'all' | { only: Glob[] } | { except: Glob[] }
type Rule = { skills: Glob[]; scope: Partial<Scope> }   // 后者覆盖前者

type Target = { host: HostId; agent: AgentId }
type Desired = Map<HostId, Map<AgentId, Set<SkillName>>>

type Entry =                                   // agent 目录里的一个条目（probe 结果）
  | { kind: 'managed'; name: string }          // 指向 store 的软链
  | { kind: 'foreign-link'; name: string; target: string }
  | { kind: 'dir'; name: string }              // 真实目录（未纳管）
  | { kind: 'file'; name: string }

type Op =
  | { op: 'mkdir'; host; path }
  | { op: 'rsync-skill'; host; skill }         // hub store → 远端 store（--delete）
  | { op: 'link'; host; agent; skill }
  | { op: 'unlink'; host; agent; skill }       // 仅删除 managed 软链
  | { op: 'conflict'; host; agent; skill; entry: Entry }  // 不自动处理，报告
  | { op: 'stale-store'; host; skill }         // 远端 store 有但 hub 没有（remote-only）
```

### 3.2 范围规则（个性化）

```yaml
store: ~/.skm/skills
hosts:
  local: {}
  mini:      { ssh: mini }
  home-mini: { ssh: home-mini }
  devbox:    { ssh: devbox, agents: [claude, codex] }   # 主机级 agent 列表（默认用全局 agents）
agents: [claude, codex, cursor, gemini]
defaults: { hosts: all, agents: all }                   # 未命中规则的 skill 默认去向
rules:                                                  # 从上到下，后者覆盖前者；glob 匹配 skill 名
  - skills: ["kb-*"]         ; hosts: { except: [devbox] }
  - skills: ["corp-*"]    ; hosts: { only: [mini, devbox] }
  - skills: ["hatch-pet"]      ; hosts: { only: [local] } ; agents: { only: [codex] }
```

求值：`desired(host, agent) = { s | scope(s).hosts ∋ host ∧ scope(s).agents ∋ agent ∧ agent ∈ hostAgents(host) }`。纯函数，可穷尽测试。TUI 的矩阵编辑直接改写 `rules`（对单个 skill 生成/合并一条精确规则）。

### 3.3 同步协议（远端零依赖）

1. **probe**：`ssh host sh -s < probe.sh`，脚本输出以 TAB 分隔的行：`store\t<name>\t<sha of SKILL.md>`、`entry\t<agent>\t<name>\t<kind>\t<target>`、`meta\thome\t<path>`。hub 解析成 `Entry[]`。
2. **rsync**：对每个应去该主机的 skill：`rsync -a --delete --exclude .DS_Store <store>/<skill>/ host:~/.skm/skills/<skill>/`。远端 store 里 hub 没有的目录**不删**，报告为 remote-only（可 `skm pull`）。
3. **apply**：`ssh host sh -s < apply.sh`，脚本内容由 `Op[]` 纯函数生成：`mkdir -p`、`ln -sfn`、`rm`（仅当当前是指向 store 的软链）。幂等。
4. 本机走同一套 `Op[]`，由本地 executor 直接执行。

冲突（目标位置是真实目录/异源软链）默认跳过并报告；`--replace-conflicts` 时先把原目录移到 `~/.skm/backups/<ts>/conflicts/` 再建软链。

### 3.4 备份 / 一键还原

`skm backup [host]`（apply 前自动执行）：在目标主机上

```
~/.skm/backups/<ts>/
├── snapshot.tar.gz   # store + 所有 agent 用户级目录（tar 保留软链本身）
├── manifest.txt      # 打包了哪些路径
└── restore.sh        # 一键还原：删除现有这些路径 → 解包 → 打印校验
```

还原命令：`sh ~/.skm/backups/<ts>/restore.sh`（远端）或 `skm restore <host> <ts>`（从 hub 触发）。快照同时拉回 hub 的 `~/.skm/backups/<host>/<ts>/` 一份。

### 3.5 上下文占用

每个 skill：`descChars`、`descTokens`（gpt-tokenizer o200k 估算，标注为估算）、`bodyTokens`、`bodyLines`、`files`、`bytes`。

每个 (host, agent) 汇总：listing 总字符 vs 预算；Claude 规则下超预算时估算会有多少 skill 的描述被丢弃；单 skill 描述超 1536 字符标黄；正文 >5000 token 或 >500 行标黄（规范建议）。Claude 的 `model`、`skillListingBudgetFraction / skillListingMaxDescChars`、`env.CLAUDE_CODE_DISABLE_1M_CONTEXT`、`env.SLASH_COMMAND_TOOL_CHAR_BUDGET` 均从各主机 `~/.claude/settings.json` 读取（`src/core/claude-model.ts` 解析模型→窗口）；config `contextTokens` 只作兜底。

### 3.6 评估与推荐

- 本地启发式（免费、即时）：描述 token 集合 Jaccard 相似度 > 0.5 标记"疑似重复"；描述缺"何时使用"关键词标记；描述过短（<40 字符）标记。
- LLM 评估：`skm eval [--agent claude|codex] [skills...]`。把 name/description/正文前 N 行打包成一个 prompt，要求按 JSON Schema 返回：每个 skill `{usefulness: 1-5, description_quality: 1-5, overlaps: string[], trim_suggestion, verdict: keep|merge|trim|drop, reason}`。
  - Claude：`claude -p --bare --output-format json --json-schema <schema> --tools ""`。
  - Codex：`codex exec --ephemeral --skip-git-repo-check -s read-only --output-schema <file> -o <out>`。
- 结果按 skill 内容哈希缓存于 `~/.skm/cache/eval/`，TUI 的 Insights 面板展示。

## 4. CLI

```
skm                      # TUI
skm init                 # 生成 config.yaml；发现 ~/.agents/skills、~/.claude/skills 等现有 skill
skm adopt <path|agent>   # 把真实目录移入 store，原位置换成软链（迁移）
skm ls [--json] [--host H] [--agent A]
skm show <skill>
skm plan [--host H]      # 只算 Op[]，打印
skm sync [--host H] [--dry-run] [--replace-conflicts] [-y]   # backup → rsync → apply
skm status [--host H]    # probe + diff 摘要
skm pull <host> <skill|--all>    # 远端 store 独有的 skill 拉回 hub
skm backup [host] / skm restore <host> <ts> / skm backups [host]
skm doctor               # 规范校验 + 上下文预算报告
skm eval [--agent claude|codex] [skills...]
```

## 5. TUI（Ink）

```
┌ skm ── hub: local ── hosts: local ● mini ● home-mini ○ devbox ● ─────────────┐
│ Skills (41)   filter: /kb        │ kb-doc                                 │
│ ▸ kb-doc     desc 312c/78t  body 1.1kt │ 飞书云文档（Docx / Wiki）内容操作… │
│   kb-drive   desc 288c/70t  body 4.0kt │ files 18  bytes 596K  refs 16      │
│   acme     desc 1.9kc ⚠   body 12kt ⚠│ ── targets ──  claude codex cursor │
│   …                                       │   local        ●      ●      ○     │
│                                           │   mini         ●      ●      ○     │
│                                           │   devbox       ○      ○      ○     │
│                                           │ ── insights ── 疑似与 kb-wiki 重复│
├───────────────────────────────────────────┴────────────────────────────────────┤
│ j/k 移动  / 过滤  Tab 面板  Space 切换目标  s 同步  e 评估  b 备份  ? 帮助  q 退出│
└──────────────────────────────────────────────────────────────────────────────┘
```

视图：Skills（列表+详情+矩阵）、Hosts（可达性、drift 数、remote-only 数）、Sync（plan 列表 → 确认 → 执行日志）、Insights（评估结果排序）。Skills 列表排序：TUI 用 `o` 轮换排序键（name → listing token → body token，成本键默认降序）、`O` 翻转方向；App 点表头排序（Skill / Source / Listing / Body / Version / Loaded on / Description），再点翻转，默认按来源分组再按名字。

## 6. 错误处理

- 所有 IO 返回 `Result<T, E>`，`E` 为标签联合（`ssh-unreachable`、`rsync-failed`、`frontmatter-invalid`、`conflict` …），TUI/CLI 对 `E` 穷尽匹配渲染。
- 不可达主机不阻塞其他主机；TUI 标灰。
- apply 顺序：backup 成功才 rsync；rsync 成功才 link；任一步失败停止该主机并报告，其他主机继续。
- 永不删除非 managed 的条目；永不删除远端 store 中 hub 没有的目录。

## 7. 测试

- 纯核心（规则求值、diff、脚本生成、预算模拟、frontmatter 解析、去重）：`bun test` 单元测试，穷尽 case。
- 执行器：用临时目录做真实文件系统集成测试（本地 executor）；ssh executor 用 `localhost`-风格的 fake（注入 `run(cmd)`）测试脚本拼装。
- 真机验证：先 `skm backup` 三台主机，`skm sync --dry-run` 审阅，再 apply，再 `restore` 验证还原等价，再 apply。

## 8. 非目标（v1）

- 不做 marketplace / 安装（用 Vercel `skills add` 后 `skm adopt`）。
- 不做安全审计。
- 不做项目级（`.claude/skills`）同步，只做用户级。
- 不做 Windows。
