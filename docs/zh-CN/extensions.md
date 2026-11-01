# 扩展

[English](../extensions.md) | 简体中文

扩展用来加入内置 skm 不认识的东西：另一个编程 agent，或一个会写 plugin marketplace 的桌面应用。个人或公司专用的功能都放进扩展，skm 核心保持通用。

## 扩展放在哪里

每条命令启动时，skm 读取 hub 上 `~/.skm/extensions/` 里的所有 `*.yaml` 和 `*.yml` 文件。一个文件就是一个扩展。

```sh
skm extensions          # 已加载的扩展、各自加入了什么、错误
skm extensions --json
```

在桌面 App 里打开 **设置 → 扩展**，可以看到同样的列表，开关单个扩展，或打开扩展目录。

扩展只包含数据，skm 读文件时不执行任何代码。文件里的 shell 命令只在你发起更新时执行（`skm harness update`，或 App 里的更新按钮）。命令在文件选中的主机上、在登录 shell 里运行，方式和内置 agent 的更新命令相同。

警告：扩展的 `update` 命令会以你的用户权限在每台选中的主机上执行。只安装可信来源的扩展文件，并且先读一遍。

## 格式

```yaml
name: my-setup              # 可选，默认取文件名。只能用小写字母、数字、短横线。

agents:                     # claude / codex / pi 之外的编程 agent
  - id: opencode            # 在 config.yaml 里使用（agents、hosts.<h>.agents、rules）
    name: OpenCode          # 显示名
    skillsDir: ~/.config/opencode/skills
    alsoReads: [~/.claude/skills]   # 该 agent 还会加载的其他目录（只列出，不管理）
    cli: { bin: opencode, update: opencode upgrade }   # 都可选；bin 默认等于 id

apps:                       # agent 的 macOS 桌面应用，会安装 plugin marketplace
  - id: myapp
    agent: codex            # 这个应用属于哪个 agent
    name: My App
    bundle: /Applications/My App.app
    feed: https://example.com/appcast.xml        # Sparkle appcast，只接受 https
    marketplaces: [my-bundled]                   # 该应用写入的 marketplace
    marker: .myapp/bundled/.ready                # $HOME 下的文件，应用更新后会重写它
    settle: { file: .cache/myapp/runtime.json, busy: ".cache/myapp/install-*" }   # 可选

```

两个列表都可选。文件顶层出现未知字段时 skm 会拒绝加载，拼写错误不会被悄悄忽略。

skm 0.6 删除了 `tools:` 列表。文件里还有这个列表时，扩展照常加载，`skm extensions` 和 App 里显示一条警告，skm 忽略这个列表。从文件里删掉它，警告就会消失。

### Agent

扩展里的 agent 和内置 agent 行为相同，listing 按普通列表处理：

- 把它的 id 加到 `config.yaml` 的 `agents:` 里（如果你按主机列 agent，也加到 `hosts.<host>.agents`）。之后规则、`skm sync`、`skm status` 和 App 的网格都会包含它。
- 在启用该 agent 的每台主机上，skm 把 store 里的 skill 软链到 `skillsDir`。
- listing 成本用 o200k 分词器估算，不设预算上限，因为 skm 不知道该 agent 怎么截断 listing。
- `skm harness` 在每台主机上显示 `cli.bin --version`，`skm harness update` 执行 `cli.update`。

### 应用

应用挂在它所属的 agent 上。在一台主机上运行 `skm harness update --agent <应用 id>` 时，skm 会：

1. 从 Sparkle appcast `feed` 读取最新版本；
2. 下载新版，用 `codesign --verify --deep --strict` 校验签名，并确认 Team ID 和已安装的应用相同；
3. 把旧版移到该主机的 `~/.skm/backups/app/`，安装新版；
4. 在后台打开应用，等它重写 `marker`（设置了 `settle` 时，还要等 `settle.file` 不再变化、`settle.busy` 匹配的路径全部消失）；
5. 如果应用原来没在运行，再把它退出。

应用的 `marketplaces` 在插件视图里显示为「随应用分发」。更新这类 plugin 时，先在应用落后的主机上更新应用。

ChatGPT 桌面版（它安装 Codex 的 `openai-bundled` 和 `openai-primary-runtime` 两个 marketplace）作为内置扩展 `chatgpt-desktop` 提供。

## 关闭扩展

```yaml
# ~/.skm/config.yaml
disabledExtensions: [chatgpt-desktop, my-setup]
```

App 里 **设置 → 扩展** 的开关写的也是这个字段。

## 冲突和错误

- 扩展用到的 id 已经被内置 agent 或排在前面的扩展占用时，skm 跳过整个扩展，并报告哪些 id 冲突。文件按文件名顺序加载。
- 文件解析失败时，skm 跳过它，并报告第一个问题及其路径，例如 `agents[0].skillsDir: expected a non-empty string`。
- 应用指向一个不存在的 agent 时，skm 报告错误，不挂载该应用。

被跳过的扩展会在 `skm extensions` 和 App 里列出原因。
