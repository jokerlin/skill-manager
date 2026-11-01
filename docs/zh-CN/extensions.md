# 扩展

[English](../extensions.md) | 简体中文

扩展用来加入内置 skm 不认识的编程 agent（skm 内置 Claude Code、Codex 和 Pi）。个人或公司专用的功能都放进扩展，skm 核心保持通用。

## 扩展放在哪里

每个命令启动时，skm 读取主力机 `~/.skm/extensions/` 里所有 `*.yaml` 和 `*.yml` 文件。一个文件就是一个扩展。

```sh
skm extensions          # 已加载的扩展、各自加入了什么、警告和错误
skm extensions --json
```

在桌面 App 里打开 **设置 → 扩展**，可以看到同样的列表，也可以打开扩展目录。要关闭一个扩展，把它的文件移出这个目录。

扩展只包含数据，skm 读文件时不执行任何代码。agent 的 `cli.update` 命令只在你发起更新时执行（`skm harness update`，或 App 里的更新按钮）。命令在启用该 agent 的主机上、在登录 shell 里运行，方式和内置 agent 的更新命令相同。

警告：扩展的 `update` 命令会以你的用户权限，在每台启用该 agent 的主机上执行。只安装可信来源的扩展文件，并且先读一遍。

## 格式

```yaml
name: my-setup              # 可选；默认等于文件名。只能用小写字母、数字和短横线。

agents:                     # claude / codex / pi 以外的编程 agent
  - id: opencode            # 在 config.yaml 里使用（agents、hosts.<h>.agents、rules）
    name: OpenCode          # 显示名
    skillsDir: ~/.config/opencode/skills
    alsoReads: [~/.claude/skills]   # 该 agent 还会加载的其他目录（只报告，不管理）
    cli: { bin: opencode, update: opencode upgrade }   # 都可选；bin 默认等于 id
```

文件顶层出现未知字段时 skm 会拒绝加载，拼写错误不会被悄悄忽略。

skm 0.6 删除了 `tools:` 和 `apps:` 两个列表。文件里还有其中一个时，扩展照常加载，`skm extensions` 和 App 里显示一条警告，skm 忽略这个列表。从文件里删掉它，警告就会消失。0.5 里以内置扩展 `chatgpt-desktop` 提供的 Codex 桌面 App（ChatGPT.app），现在是内置 codex agent 的一部分。

## Agent

扩展里的 agent 和内置 agent 行为相同，listing 按普通列表处理：

- 把它的 id 加到 `config.yaml` 的 `agents:` 里（如果你按主机列 agent，也加到 `hosts.<host>.agents`）。之后规则、`skm sync`、`skm status` 和 App 的网格都会包含它。
- 在启用该 agent 的每台主机上，skm 把 store 里的 skill 软链到 `skillsDir`。
- listing 成本用 o200k 分词器估算，不设预算上限，因为 skm 不知道该 agent 怎么截断 listing。
- `skm harness` 在每台主机上显示 `cli.bin --version`，`skm harness update` 执行 `cli.update`。

## 冲突和错误

- 扩展用到的 id 已经被内置 agent 或排在前面的扩展占用时，skm 跳过整个扩展，并报告哪些 id 冲突。文件按文件名顺序加载。
- 文件解析失败时，skm 跳过它，并报告第一个问题及其路径，例如 `agents[0].skillsDir: expected a non-empty string`。

被跳过的扩展会显示在 `skm extensions` 和 App 里，并附上原因。
