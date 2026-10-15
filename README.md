# dsh-skill-gate

A DeepSeek Harness plugin that refuses state-changing tool calls until the session has loaded the skills listed in `requiredSkills`. With an empty list the gate is off.

`dsh-skill-gate` 是一个 DeepSeek Harness 插件：会改变状态的工具调用，在本轮成功加载**必读名单**里的 skill 之前一律拒绝；**没配名单就不拦**（门禁不生效）。

## 它解决什么问题

模型经常跳过 skill catalog，直接动手改文件。把「先看 skill、再干活」写成提示词，靠的是自觉；这个插件把它变成机制 —— 把「这次任务必读哪几份 skill」写进配置，本轮的第一次写操作之前，那些 skill 必须真的被加载过。

## 为什么用插件机制，而不是靠自觉

- 写在提示词里的规则，模型可以读到，也可以绕过；
- 门禁挂在**工具调用层**：拦的是动作本身，不依赖模型记得这条规则；
- 本插件**不提供任何工具**。解除门禁的唯一方式是成功加载名单里的 skill，没有可以空手调用（例如 `loaded: []`）的橡皮图章接口。

## 安装

```bash
# 从本地 tgz 安装到某个 profile
dsh plugin --profile <profile> add "file:$DSH_HOME/packages/dsh-skill-gate-<version>.tgz"

# 或按包名安装（发布到 registry 之后）
dsh plugin --profile <profile> add dsh-skill-gate
```

装完重启 dsh 生效。

## 配置

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `requiredSkills` | `string[]` | `[]` | 本轮必须成功加载的 skill 名单；**留空 = 门禁不生效**。 |

- `requiredSkills: []`（默认）：**不拦**，受保护的工具直接放行 —— 不配名单就不付这份开销。
- `requiredSkills: ["a", "b"]`：`a` 和 `b` **都要**在本轮成功加载过才放行；缺哪个，拒绝文案就点名哪个。

### 在插件页里改

侧边栏「插件」页 → 本插件那张卡：组合包页与包内那一行各有一处配置区，两处编辑的是同一份配置。

- 配置区列出当前 catalog 里的 skill（名字 + 描述），**勾选即加入必读名单**；顶部过滤框按名字或描述筛。
- 候选来自宿主半边的只读路由 `GET /dsh-skill-gate/skill-index`。它按**当前会话（agent）的 scope** 列 catalog —— 与原生 `skill` 工具同一个视角，所以用户级（`~/.dsh/skills`）与项目级（`<项目>/.dsh/skills`）都列得出来。
- 没有可用会话时它退回全局层（只有插件运行时注册的那几份），载荷标 `partial: true`，配置区上方显示一行警示说明为什么不全。
- **配置里有、但 catalog 里没有的名字**（改名 / 删除 / 项目级看不到）单独一组保留并标警示色，默认勾选；取消勾选即从名单里去掉 —— 不会被静默丢弃。
- **一个都不勾 = 名单为空 = 门禁不生效**（刻意如此）。
- 路由取不到数据（老版本宿主 / 非 web profile / `skills` 服务缺失）时退回「一行一个名字」的文本框，并在界面上说明原因 —— 不会白屏。
- `requiredSkills` 是 volatile 字段：**值改完保存即生效**，不需要重载插件。
- 客户端半边（`lib/client.js`）的代码改动要**重启 dsh** 才生效 —— 浏览器里的插件代码在启动时装载。


## 两个例子

启用门禁：本轮必须先把这几份 skill 加载完才允许动手。

```json
{ "requiredSkills": ["your-team-required-skill"] }
```

关掉门禁（默认）：不配名单，什么都不拦。

```json
{ "requiredSkills": [] }
```

## 行为细节

- **只有必读名单会被检查**：判定看的是「名单里的 skill 读全了没有」，不是「有没有加载过 skill」；名单为空即不拦。
- **粒度是一轮**：判定在 `agent/pre-step` 换 turn 时清空，每个 turn 重新要求一次。
- **只认成功的原生加载**：`tools/result` 里工具名是 `skill`、且 `isError` 为假才算数；失败的加载不算，加载别的工具也不算。
- **受保护的工具**：`write`、`edit`、`plugin_manager`，以及**命令位置**上会改状态的 bash 命令 —— 非空汇的 `>` / `>>` 输出重定向、`tee` / `rm` / `mv` / `cp` / `mkdir` / `touch` / `truncate` / `dd` / `chmod` / `chown` / `ln` / `patch` / `install` / `sudo`、`sed -i` / `sort -o`、`git` 的 `add|commit|push|reset|checkout|clean|rebase|merge|apply|stash|switch|restore|branch|rm|mv|cherry-pick|revert` 子命令、包管理器（`npm` / `pnpm` / `pip` / `apt` / `cargo` 等）的 `install|add|remove|uninstall|upgrade|update|publish|sync` 子命令。命令位置的判据、噪声前缀（`VAR=x` / `command` / `env` / `xargs`）与 `/usr/bin/rm` 这类路径写法以 `src/index.ts` 的 `bashLooksLikeWrite` 为准。
- **只读不拦**：`read` / `grep` / `glob` / `skill` 等只读工具，以及纯读的 bash —— 写命令词只出现在**参数位置**不算写（`cat -n install.sh`、`grep -c dd file`、`ls patch/`、`sed -n '1,5p' a` 都放行），`2>&1` 与 `>/dev/null` / `2>/dev/null` / `&>/dev/null` 这类空汇重定向也不算；没有会话身份的调用不拦。
- **反死锁**：`requiredSkills` 里写了当前 catalog 里不存在的名字（skill 改名或删除）时，这个名字本轮被忽略并记一行 warning；取不到 catalog（`skills` 服务缺席或调用失败）时保持严格，按原名单要求。

## 已知边界

- 门禁只能证明**加载动作发生过**，证明不了模型真的读了正文 —— 这是提示词之外唯一能机械判定的东西。
- catalog 软化是 best-effort：它按当前 workspace 的 skill 视图判断；缓存过期时可能多拦或少拦一次。
- bash 判定基于命令文本的正则，没有 shell 解析器，判据只覆盖**命令位置**：写操作藏在参数或字符串里就判不了 —— `node -e '…writeFileSync…'`、`sh -c 'rm -rf x'`、`./install.sh`（脚本文件自身干什么看不出来）都会放行。重定向到 `/dev/null` 先按空白抹掉再判，所以 `cmd >/dev/null` 不会被误拦，而同一条命令里还有别的写操作时照样拦。
- 判定状态在进程内，按会话 id 记录；进程重启即清空。

## License

MIT
