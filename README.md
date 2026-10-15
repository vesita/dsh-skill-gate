# dsh-skill-gate

A DeepSeek Harness plugin that refuses state-changing tool calls until the session has loaded the required skills.

`dsh-skill-gate` 是一个 DeepSeek Harness 插件：会改变状态的工具调用，在会话成功加载所需的 skill 之前一律拒绝。

## 它解决什么问题

模型经常跳过 skill catalog，直接动手改文件。把「先看 skill、再干活」写成提示词，靠的是自觉；这个插件把它变成机制 —— 本轮的第一次写操作之前，必须真的调用一次原生的 `skill` 工具。

## 为什么用插件机制，而不是靠自觉

- 写在提示词里的规则，模型可以读到，也可以绕过；
- 门禁挂在**工具调用层**：拦的是动作本身，不依赖模型记得这条规则；
- 本插件**不提供任何工具**。解除门禁的唯一方式是成功加载一份 skill，没有可以空手调用（例如 `loaded: []`）的橡皮图章接口。

## 安装

```bash
# 从本地 tgz 安装到某个 profile
dsh plugin --profile <profile> add "file:$DSH_HOME/packages/dsh-skill-gate-1.0.0.tgz"

# 或按包名安装（发布到 registry 之后）
dsh plugin --profile <profile> add dsh-skill-gate
```

装完重启 dsh 生效。

## 配置

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `requiredSkills` | `string[]` | `[]` | 本轮必须成功加载的 skill 名单。 |

- `requiredSkills: []`（默认）：本轮成功加载过**任意一份** skill 即放行。
- `requiredSkills: ["a", "b"]`：`a` 和 `b` **都要**成功加载过才放行；缺哪个，拒绝文案就点名哪个。

配置是 volatile 的：在插件设置页改完立即生效，不需要重载插件。

## 两个例子

要求本轮先读指定的几份 skill：

```json
{ "requiredSkills": ["your-team-required-skill"] }
```

不限定名字，只要求「本轮先看过 skill」：

```json
{ "requiredSkills": [] }
```

## 行为细节

- **粒度是一轮**：判定在 `agent/pre-step` 换 turn 时清空，每个 turn 重新要求一次。
- **只认成功的原生加载**：`tools/result` 里工具名是 `skill`、且 `isError` 为假才算数；失败的加载不算，加载别的工具也不算。
- **受保护的工具**：`write`、`edit`、`plugin_manager`，以及会改状态的 bash 命令（输出重定向、`tee` / `rm` / `mv` / `cp` / `mkdir` / `touch` / `dd` / `chmod` / `chown` / `ln`、`sed -i`、`git commit|push|reset|...`、包管理器的安装类子命令、`sudo`）。
- **只读不拦**：`read` / `grep` / `glob` / `skill` 等只读工具，以及纯读的 bash（含 `2>&1` 这种读侧重定向）一律放行；没有会话身份的调用不拦。
- **反死锁**：`requiredSkills` 里写了当前 catalog 里不存在的名字（skill 改名或删除）时，这个名字本轮被忽略并记一行 warning；取不到 catalog（`skills` 服务缺席或调用失败）时保持严格，按原名单要求。

## 已知边界

- 门禁只能证明**加载动作发生过**，证明不了模型真的读了正文 —— 这是提示词之外唯一能机械判定的东西。
- catalog 软化是 best-effort：它按当前 workspace 的 skill 视图判断；缓存过期时可能多拦或少拦一次。
- bash 判定基于命令文本的正则，没有 shell 解析器：它只拦明确会写的命令，读命令一律放行。
- 判定状态在进程内，按会话 id 记录；进程重启即清空。

## License

MIT
