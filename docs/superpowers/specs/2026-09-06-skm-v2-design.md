# skm v2 设计：以「agent 真实消费」为中心的盘点与对账

日期：2026-09-06　状态：实施中　前置：`2026-09-06-skm-design.md`（v1）

## 1. 为什么改

v1 只看一个来源：`~/.skm/skills`（store）和它软链进各 agent 用户目录的 skill。
但 agent 真正加载的 skill 来自多处：

| 来源 | Claude Code | Codex | 存储方式 | 拥有者 |
|---|---|---|---|---|
| 用户目录 | `~/.claude/skills/*` | `~/.agents/skills/*` | 软链到 store，或真实目录 | skm / acme / `npx skills` / 手工 |
| 旧目录 | — | `~/.codex/skills/*` | 真实目录（与用户目录同名时加载两次） | 手工 |
| 内置 | （不在磁盘上） | `~/.codex/skills/.system/*` | Codex 自带 | Codex |
| 插件 | `~/.claude/plugins/cache/<mk>/<plugin>/<ver>/skills/*`，由 `~/.claude/settings.json` 的 `enabledPlugins` 开关，`installed_plugins.json` 记录激活版本 | `~/.codex/plugins/cache/<mk>/<plugin>/<ver>/skills/*`，由 `~/.codex/config.toml` 的 `[plugins."name@mk"] enabled` 开关（缺省为 true） | 各自的插件缓存 | claude plugins / codex plugins |

后果：`skm status` 看不到 superpowers 这类插件 skill；`skm doctor` 的上下文预算只算 store 里的 skill（本机 Claude 少算了约 7,200 字符）；acme 这种「CLI 自己管」的 skill 只能靠删规则来绕开。

用户的期望：**尽可能集中管理、充分复用**。v2 的口径是：**盘点和策略集中在 skm，存储保留在各自的拥有者手里**。skm 不复制插件文件，而是通过 `claude plugin` / `codex plugin` / `acme` 等命令对账。

## 2. 目标 / 非目标

目标
1. 每个 (主机, agent) 输出它实际会触发的完整 skill 列表：来源、存储路径与方式、拥有者、版本、listing 开销、内容哈希；标出同名、同内容、版本漂移、缓存残留。
2. 期望状态扩展到插件与 CLI 自管 skill：`plugins:` 与 `owned:` 两段配置；plan/sync 生成并执行对应命令。
3. 预算（doctor）与评估（eval）覆盖全部来源。
4. TUI、Mac App、`--json` 同步暴露以上信息。

非目标
- 项目级 skill（`<repo>/.claude/skills`）：随 cwd 变化，不纳入。
- Claude 内置 skill、`~/.claude/commands/*.md`：不在 skill 列表语义内。
- 插件内非 `skills/*` 路径的 SKILL.md（例如 `node_modules/**`、`.claude/skills/**`）：agent 不加载，忽略。
- 插件升级编排（`plugin-update`）：只报告版本漂移，不自动升级。
- 项目/本地作用域的插件启用（`settings.local.json`、项目 settings）：只读用户级。

## 3. 数据模型（`src/core`）

```ts
// sources.ts
type Source =
  | { kind: "user" }                                   // agent 用户目录
  | { kind: "legacy"; dir: string }                    // alsoReads 目录
  | { kind: "builtin" }                                // ~/.codex/skills/.system
  | { kind: "plugin"; marketplace: string; plugin: string; version: string };

type Storage =
  | { kind: "store-link"; direct: boolean }            // 软链进 store
  | { kind: "real-dir" }
  | { kind: "link-elsewhere"; target: string }
  | { kind: "plugin-cache" }
  | { kind: "builtin" };

type Owner = "skm" | "acme" | "skills-cli" | "claude-plugins" | "codex-plugins" | "codex-builtin" | "manual";

type Effective = {                                     // 一条「agent 会加载」的记录
  agent: string; name: string;
  source: Source; storage: Storage; owner: Owner;
  path: string;                                        // 磁盘上的目录
  version: Option<string>;                             // 插件版本 / acme 版本
  enabled: "on" | "implicit";                          // implicit = Codex 插件无 config 条目，按缺省 true 计入
  listing: string; listingChars: number; bodyTokens: number; hash: string;
};

type PluginState = {                                   // 一台主机上一个 agent 的一个插件
  agent: string; marketplace: string; name: string;
  enabled: "on" | "off" | "implicit";
  active: Option<{ version: string; dir: string; skills: string[] }>;
  cachedVersions: string[];                            // 全部缓存版本（含残留）
};

type Finding =
  | { kind: "same-name";     host; agent; name; paths: string[] }
  | { kind: "same-content";  host; agent; hash; paths: string[] }
  | { kind: "version-drift"; plugin; cells: { host; agent; version }[] }
  | { kind: "stale-cache";   host; agent; plugin; versions: string[] }
  | { kind: "disabled-cached"; host; agent; plugin };
```

拥有者判定（纯函数）：软链进 store → `skm`；真实目录且名字在 acme lock（`~/.local/share/acme/data/skill-lock.json` 的 `global.skills`）→ `acme`；真实目录且名字在 `~/.agents/.skill-lock.json` 的 `skills` → `skills-cli`；其余真实目录 → `manual`；插件 → `claude-plugins`/`codex-plugins`；`.system` → `codex-builtin`。

插件激活版本：Claude 用 `installed_plugins.json[plugins]["name@mk"][0].installPath`；Codex 无记录，取缓存中最高版本（数字优先的自然序比较），多版本时记入 `cachedVersions`。Claude 的 `enabledPlugins` 只有显式 `true` 才算 on；Codex 有 `[plugins."x"] enabled` 按值，无条目但有缓存则 `implicit`（Codex 源码 `PluginConfig.enabled` 缺省 true）。

## 4. 探测协议扩展（`probeScript` v2）

在 v1 的 `meta/store/dir/entry/also` 行之外新增（仍是 TSV，`sh -s` 可跑，macOS/Linux 通用）：

| 行 | 含义 |
|---|---|
| `tool\t<name>\t<path\|->` | `claude` / `codex` / `acme` 在增强 PATH（`~/.local/bin:~/.bun/bin:~/.npm-global/bin:~/.local/share/mise/shims:/opt/homebrew/bin:/usr/local/bin`）下的位置 |
| `file\t<id>\t<b64>` | 原样带回：`claude-settings`、`claude-installed`、`claude-marketplaces`、`codex-config`、`acme-lock`、`agents-lock`（缺失则不发） |
| `pcache\t<agent>\t<mk>\t<plugin>\t<ver>\t<dir>` | 插件缓存里的每个版本目录 |
| `pskill\t<agent>\t<mk>\t<plugin>\t<ver>\t<name>\t<dir>\t<hash>` | `<ver>/skills/<name>/SKILL.md` |
| `builtin\t<agent>\t<name>\t<dir>\t<hash>` | `~/.codex/skills/.system/<name>` |
| `md\t<hash>\t<bytes>\t<b64>` | SKILL.md 全文，按哈希去重，每个哈希只发一次 |
| `entry`/`also` 行末尾追加 `\t<hash>` | 用户目录 / 旧目录条目的 SKILL.md 哈希（无 SKILL.md 为空） |

哈希在主机端算（sha1sum/shasum/cksum），hub 用 `md` 行还原全文后解析 frontmatter，得到 listing 文本、body token 估算。`base64 | tr -d '\n'` 在 macOS/Linux 行为一致。

## 5. 配置扩展（`config.yaml`）

```yaml
plugins:                                     # 插件的期望状态；缺省为空 = 只报告不动
  superpowers:
    marketplace: claude-plugins-official     # 字符串，或按 agent 区分 { claude: linear-cli, codex: claude-extras }
    hosts: all                               # 与 rules 相同的选择器语法
    agents: { only: [claude, codex] }        # 只有 claude/codex 支持插件，其余 agent 忽略
owned:                                       # CLI 自管的 skill
  acme:
    tool: acme                           # 主机上必须存在的命令
    ensure: acme self skill install -g -s acme   # 目录缺失且工具存在时执行；可省略（按 tool 有内置默认）
    fallback: store                          # 工具不存在时：store = 软链 store 副本；none = 留空
```

语义
- 插件期望单元格：`hosts(host) ∧ agents(agent) ∧ agent ∈ {claude, codex} ∧ 主机启用该 agent`。
- `owned` 的 skill 仍用 `rules`/`defaults` 决定去哪些单元格；到了单元格再看：工具在 → 应为该工具写出的真实目录；工具不在 → 按 `fallback`。
- 现有 `acme` 的 `hosts: { only: [] }` 临时规则由 `owned.acme` 取代（迁移时删除）。

## 6. 计划与执行

`Op` 新增：

| op | 触发条件 | 执行（主机端，增强 PATH） |
|---|---|---|
| `marketplace-add {agent, marketplace, source}` | 插件期望存在，但该 agent 未配置此 marketplace；hub 端知道 source | `claude plugin marketplace add <source>` / `codex plugin marketplace add <source>` |
| `plugin-install {agent, plugin}` | 期望 on，缓存无该插件 | `claude plugin install name@mk` / `codex plugin add name@mk` |
| `plugin-enable {agent, plugin}` | 期望 on，已缓存但 off | `claude plugin enable name@mk` / Codex：awk 改写 `config.toml` 的 `[plugins."name@mk"]` 表（无则追加） |
| `plugin-disable {agent, plugin}` | 期望 off（配置里声明了该插件但选择器不含此单元格），当前 on/implicit | `claude plugin disable name@mk` / 同上写 `enabled = false` |
| `owned-ensure {skill, tool, command}` | owned skill 期望在此主机，工具存在，且该主机任一 agent 的目录缺失或不是真实目录 | 运行 `command`（每主机一次） |
| `blocked {agent, what, reason}` | 需要的工具不存在 / marketplace 来源未知 | 不执行，只报告（同 conflict） |

排序：mkdir → rsync → unlink → link → marketplace-add → plugin-install → plugin-enable → plugin-disable → owned-ensure → conflict → blocked → remote-only。
`isMutation` 覆盖新增的可执行 op。执行阶段：`executePlan` 在 apply.sh 之后追加一段「命令脚本」，逐条 `cmd && echo ok-line || echo fail-line`，失败不影响其他条目；结果进入 `SyncReport.commands`。
备份路径追加 `~/.claude/settings.json`、`~/.claude/plugins/installed_plugins.json`、`~/.codex/config.toml`。

安全边界沿用 v1：不删真实目录、不 unlink 非 hub 的软链、不删远端 store；新增：不删插件缓存、不改 marketplace 列表以外的 config.toml 内容。

## 7. 预算与评估

- `simulateListing` 改为接受 `{ name, listing }[]`；`doctor` 和 `status` 的预算基于「有效清单」（用户目录非文件条目 + 旧目录 + 内置 + 已启用插件的 skill）。
- `doctor` 因此需要探测主机（与 status 同一探测，一次 ssh），并新增 Finding 输出。
- `eval --all`：把本机有效清单中可读的插件 skill 与真实目录 skill 一并评估（缓存键仍是 name+hash；插件 skill 的 name 用 `plugin:name` 避免撞名）。

## 8. 展示

- `skm inventory [--host h] [--agent a] [--json]`：每个 (host, agent) 一张表：name / source / storage / owner / version / listing / 标记（同名、同内容），末行预算结论。
- `skm status`：每个 agent 行追加来源计数与插件版本摘要；`--json` 追加 `effective`、`plugins`、`budget`、`tools`。
- `skm doctor`：预算表改为有效清单；追加跨主机 Finding。
- TUI Hosts 视图：每个 agent 行显示 `user n · plugin n (superpowers 6.3.0 …) · legacy n · builtin n · 预算 fits/over`。
- Mac App：`AgentStatus` 增加可选字段 `effective`、`budget`、`plugins`；Hosts 页显示来源摘要与预算。

## 9. 测试

- 纯解析：settings.json / installed_plugins.json / config.toml（`Bun.TOML.parse`）/ 两个 lock 文件 / 版本排序。
- `buildEffective`、`findings`、`planHost` v2（插件 on/off/缺失、owned 三态、blocked）。
- 脚本：临时 HOME 下构造用户目录、旧目录、`.system`、两个插件缓存、五个配置文件，跑 `probeScript` 再 `parseProbeOutput`；Codex config.toml 的 awk 改写幂等。
- 真机：四台主机 `status/inventory/doctor`（home-mini 单独跑），迁移配置后 `plan` 无意外 mutation，`sync` 后再探测收敛；全程先备份。
