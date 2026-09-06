# skm v2 Implementation Plan

**Goal:** 让 skm 盘点每个 (主机, agent) 真正加载的全部 skill（用户目录、旧目录、内置、Claude/Codex 插件），把期望状态扩展到插件与 CLI 自管 skill，并用各拥有者自己的命令对账；预算与评估覆盖全部来源。

**Architecture:** 纯核心 + 薄外壳不变。探测脚本多带回五个配置文件与所有 SKILL.md（按哈希去重），hub 端用纯函数解析出 `Effective[]`、`PluginState[]`、`Finding[]`；计划器在 v1 的 link/unlink 之上加插件与 owned 两类 op；执行器在 apply.sh 之后追加一段命令脚本。

**Tech Stack:** Bun 1.3 + TypeScript strict，`Bun.TOML.parse`，ts-pattern，bun:test；Ink TUI；SwiftUI 壳。

**Spec:** `docs/superpowers/specs/2026-09-06-skm-v2-design.md`

## Global Constraints

- 主机端只能依赖 POSIX sh、awk、base64、sha1sum/shasum/cksum。
- 不删真实目录、不 unlink 非 hub 软链、不删远端 store、不删插件缓存。
- 真机变更前每台主机先 `skm backup`（一键还原）。
- `rm -rf` 在本环境被拒绝；清理用 `mv`。
- home-mini 的 ssh 并发会抖，真机验证单独跑 `--host home-mini`。

---

### Task 1: 纯解析器 `src/core/sources.ts`
- Create: `src/core/sources.ts`, Test: `tests/sources.test.ts`
- 内容：`Source/Storage/Owner/Effective/PluginState/Finding` 类型；`parseClaudeSettings`、`parseClaudeInstalled`、`parseClaudeMarketplaces`、`parseCodexConfig`（`Bun.TOML.parse`，返回 `{plugins: {id: enabled}, marketplaces: {name: source}}`）、`parseAcmeLock`、`parseAgentsLock`；`compareVersions`（数字优先自然序）；`ownerOf`。
- 测试用本机真实文件的精简样本。

### Task 2: 探测协议 v2
- Modify: `src/core/scripts.ts`（`probeScript`：tool/file/pcache/pskill/builtin/md 行，entry/also 追加哈希）、`src/core/inventory.ts`（`Inventory` 增加 `tools/files/pluginCache/pluginSkills/builtins/docs`，解析新行）
- Test: `tests/scripts.test.ts` 临时 HOME 加插件缓存、`.system`、五个配置文件；`tests/plan.test.ts` 原有 probe 文本保持可解析（新字段可缺省）。

### Task 3: 有效清单与 Finding
- Create: `src/core/effective.ts`：`pluginStates(inv, agent)`、`buildEffective(inv, agentId, hubSkills)`、`findings(perHost)`。
- 依赖 `frontmatter.parseSkillMd`、`lib/tokens.estimateTokens`。
- Test: `tests/effective.test.ts`。

### Task 4: 配置 `plugins:` / `owned:`
- Modify: `src/core/config.ts`（类型、解析、序列化）；Test: `tests/config.test.ts`。

### Task 5: 计划器 v2
- Modify: `src/core/plan.ts`（Op 联合、`PlanInput` 增加 `plugins/owned/tools/pluginStates/hubMarketplaces`、排序、`opText`、`isMutation`）；`src/shell/hosts.ts`（组装输入）。
- Test: `tests/plan.test.ts` 新 describe。

### Task 6: 执行器 v2
- Modify: `src/core/scripts.ts`（`commandsScript(ops)`：增强 PATH、claude/codex 命令、Codex config.toml awk 改写）、`src/shell/sync.ts`（命令阶段、`SyncReport.commands`）、`src/shell/hosts.ts`（备份路径）。
- Test: `tests/scripts.test.ts` awk 改写幂等（临时 config.toml）。

### Task 7: 预算与命令面
- Modify: `src/core/budget.ts`（`simulateListing` 接受 `{name, listing}[]`，保留 Skill 适配）、`src/cli/status.ts`（探测后附带 effective/budget/plugins/tools；文本与 JSON）、`src/cli/doctor.ts`（改为探测主机；Finding 输出）、新建 `src/cli/inventory.ts`、`bin/skm.ts` 注册 `inventory`、`src/cli/sync.ts`（打印新 op、命令结果）、`src/cli/eval.ts`（`--all`）。
- Test: `tests/budget.test.ts` 更新；`bun run typecheck`。

### Task 8: TUI 与 Mac App
- Modify: `src/tui/state.ts`（HostStatus.ready 增加 effective/budget）、`src/tui/io.ts`、`src/tui/views/Hosts.tsx`、`macos/Sources/Skm/Models.swift`、`Views.swift`（Hosts 页来源摘要 + 预算）。
- Verify: `bun test`，`scripts/tui-snapshot.tsx`，`macos/build.sh` + 截图。

### Task 9: 真机验证与迁移
1. `skm backup`（四台，home-mini 单独）。
2. `skm status` / `skm inventory` / `skm doctor` 全部主机；记录到 `docs/reports/2026-09-06-v2-inventory.md`。
3. 配置迁移：删除 `acme hosts: {only: []}` 规则，加 `owned.acme`，加 `plugins.superpowers`；`skm plan` 确认无意外 mutation；如有 op 则 `skm sync -y`，再探测收敛。
4. 重新编译 `~/.local/bin/skm` 与 `macos/dist/Skm.app`。

### Task 10: 文档
- README「v2：来源与对账」、handbook artifact 更新、记忆更新、提交。
