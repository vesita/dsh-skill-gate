# dsh-skill-gate

A DeepSeek Harness plugin that loads the skills listed in `requiredSkills` once, automatically, at session start — the bodies go into the system prompt (the model sees them; the conversation shows only a one-line notice). With an empty list it does nothing.

`dsh-skill-gate` 是一个 DeepSeek Harness 插件：会话一开始，把**必读名单**（`requiredSkills`）里的 skill **自动加载**一遍 —— 正文进**系统提示**（模型照旧逐字看得到，对话里看不到），对话里只留一行短说明。不靠模型记得去调 `skill`；**没配名单就什么都不做**。

## 它解决什么问题

模型经常跳过 skill catalog，直接动手改文件。把「先看 skill、再干活」写进提示词靠自觉；写成门禁（拦到加载过为止）又能被绕过、还会误拦纯探查。这个插件换一条路：**机制自己把该加载的 skill 加载掉** —— 模型不需要记得，也不会有人被拦。

## 为什么用插件机制，而不是靠自觉或拦截

判据只有一句：**AI 不遵守时会发生什么？**

- 写在提示词里的规则：什么都不发生，只是概率低一点；
- 拦截面（**不做**）：AI 不做就被拒 —— 有效，但要付假阳性与「忘了就卡住」的死锁面，受保护面越大越糟；
- **自动触发执行**（现在）：机制自己把事做掉。没有假阳性，也没有死锁面。

本插件**不拦任何工具调用**，也**不注册任何工具**：自动加载成立之后，同一条判定不留第二处实现（`tools.guard` 一处也不注册）。

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
| `requiredSkills` | `string[]` | `[]` | 会话开始自动加载的 skill 名单；**留空 = 不生效**。 |
| `announce` | `string` | `marker` | 是否在对话里留一条**可见的短说明**：`marker`（留）/ `off`（不留）。认不出的取值按 `marker`。 |

- `requiredSkills: []`（默认）：什么都不做，一次加载也不发生。
- `requiredSkills: ["a", "b"]`：会话开始自动加载 `a` 与 `b`（各自真执行一次原生 `skill` 工具），把正文注入本会话的第一步。
- `announce: off` **只关掉「全部加载成功」那条说明**；没加载齐（含一份都没成）仍然出声 —— 那是状态，不是装饰。

### 在插件页里改

侧边栏「插件」页 → 本插件那张卡：组合包页与包内那一行各有一处配置区，两处编辑的是同一份配置。

- 配置区列出当前 catalog 里的 skill（名字 + 描述），**勾选即加入自动加载名单**；顶部过滤框按名字或描述筛。
- 候选来自宿主半边的只读路由 `GET /dsh-skill-gate/skill-index`。它按**当前会话（agent）的 scope** 列 catalog —— 与原生 `skill` 工具同一个视角，所以用户级（`~/.dsh/skills`）与项目级（`<项目>/.dsh/skills`）都列得出来。
- 没有可用会话时它退回全局层（只有插件运行时注册的那几份），载荷标 `partial: true`，配置区上方显示一行警示说明为什么不全。
- **配置里有、但 catalog 里没有的名字**（改名 / 删除 / 项目级看不到）单独一组保留并标警示色，默认勾选；取消勾选即从名单里去掉 —— 不会被静默丢弃。
- **一个都不勾 = 名单为空 = 不生效**（刻意如此）。
- 名单区下面那个复选框就是 `announce`：默认勾选「在对话里留一条自动加载说明」；取消勾选 = `off`。
- 路由取不到数据（老版本宿主 / 非 web profile / `skills` 服务缺失）时退回「一行一个名字」的文本框，并在界面上说明原因 —— 不会白屏。
- `requiredSkills` 是 volatile 字段：**值改完保存即生效**，不需要重载插件；但**已经开着的会话不会回头补加载**，下一次会话开始才生效。
- 客户端半边（`lib/client.js`）的代码改动要**重启 dsh** 才生效 —— 浏览器里的插件代码在启动时装载。

## 两个例子

开启自动加载：会话一开始先把这几份 skill 读进上下文。

```json
{ "requiredSkills": ["your-team-required-skill"] }
```

关掉（默认）：不配名单，插件什么都不做。

```json
{ "requiredSkills": [] }
```

## 行为细节

- **触发时机**：`agent/created`（每个会话一次），**不是**第一次 `agent/pre-step`。这是时序要求：宿主在 `agent/pre-step` **之前**就装配好这一步的系统提示，所以在 pre-step 才加载的话，正文要等到第二步才进提示词。
- **怎么加载**：真执行一次原生 `skill` 工具（`ctx.tools.execute({ name: 'skill', … })`），走完 `tools/pre-execute` → guards → 工具体 → `tools/post-execute` → **`tools/result` 广播**。合成的 callId 带 `skill-autoload:` 前缀，与模型发起的调用可区分。
- **正文走系统提示**：拼好的正文注册成 `systemPrompt` 的一个 **section**（`name: 'skill-autoload'`、`order: 700`、**`interpolate: false`**），按 agent 取值。模型照旧逐字看得到，**对话里看不到**。
  - `interpolate: false` 是硬要求：宿主默认把 section 文本当模板解析，`{{name}}` 不命中已注册变量就**抛错**，整条提示词注入失败。skill 正文里出现 `{{` 完全正常（`arch-canvas` 就专门为它写了守卫）。
- **对话里只留一条短说明**（`announce` 默认 `marker` 时）：一条 `source.form='notice'` 的消息，点名这次加载了哪几份、说明是机制触发而不是模型调用、正文走了哪条路；没加载齐就点名缺哪份与原因。
- **它在对话里长什么样**：说明的来源不是 `user`，所以 dsh 对话界面把它渲染成**注入的上下文行**（不是用户气泡），生产者标签是 `source.kind`（`skill-autoload`）。正文进的是系统提示 —— 只有展开「系统提示」卡片才看得到，它不是对话里的一行。依据：宿主侧 `dsh-agent-loop` 把 `decision.messages` 逐条 `session.append('user/message', …)` 并渲染系统提示（`SystemPromptProjection.project`）；客户端侧非 `user` 来源一律走 `contextMessage`。断言在 `selfcheck.mjs` 第 2/16 节。
- **「已加载」对谁可见**：没有「标记已加载」的 API —— 它就是**一次成功的 `skill` 工具执行**。所以本插件保留 `tools/result` 观察者作为**只读观测**（谁都能听这条广播），并在加载完那一趟汇总一行 info 日志：`skill-gate: 会话开始自动加载（正文走系统提示）—— 已加载 a、b`。
- **失败路径**（都不许静默）：
  - 名字不在 catalog（改名 / 删除 / 项目级看不到）→ 忽略它、记一行 warning，并在那条可见说明里点名（`未加载：<名字>（不在当前 catalog）`）；
  - 取不到 catalog（`skills` 服务缺席 / `list` 抛错 / 拿不到 cwd）→ **不标记已加载，下一步重试**（读不到 ≠ 没有）；同一个会话只出声一次，不刷屏；
  - 单个 skill 执行失败（被别的守卫拒了 / provider 读不到）→ 不注入正文，改成说明里点名 + 原因；
  - **一条都没成功也留说明** —— 否则「配了名单」看起来就像「已经加载过了」；
  - `skill` 工具在该 scope 不可见（被 restrict / PTC 模式）→ 退回 `ctx.skills.get()` + 宿主提供的 `renderSkillContent()`；
  - **降级（两条交付通道）**：拿不到 `systemPrompt`（老版本宿主 / 非 web 形态），或这次加载只能等到 `agent/pre-step` 才补做（会话开始时 catalog 还没就绪）→ 正文**退回本步消息**注入（`form: 'instructions'`，对话里看得见），说明里点明是哪种原因。宁可噪声，也不能让名单里的 skill 悄悄不在上下文里。
  - 两条通道都没有（没有 `systemPrompt`、也拿不到 `createUserMessage`）→ 出声一次、本会话不加载（不做注定看不见的执行），不抛错。
- **反死锁**：名单里的名字当前 catalog 里不存在时按上面第一条处理；本插件不会因为配错名字而卡住任何工具调用（它本来也不拦）。

## 已知边界

- 能证明的只是**加载动作发生过**，证明不了模型真的读了正文。
- catalog 是 best-effort：按当前 workspace 的 skill 视图判断，视图没就绪时会顺延到下一步重试。
- **正文进的是系统提示**：它在每一轮请求里都在，但不会作为对话里的一行出现（要看得展开「系统提示」卡片）。这也意味着它随提示词一起占用上下文，长名单 / 长正文会一直计费。
- **降级时会看得见正文**：没有 `systemPrompt`、或加载只能在 `agent/pre-step` 补做的会话，正文退回消息注入 —— 那是刻意的取舍（噪声 < 静默丢纪律），说明行里会点明原因。
- 名单在会话开始后才改（volatile 字段）：本次会话不受影响，下一次会话开始才生效。
- **out-of-band 执行待实机验证**：`ctx.tools.execute` 不是模型发起的调用，所以它**不产生** `tool/call` 那条 durable 记录（只发 `tools/result` 广播）；对话里那条说明照旧是 durable 的 `user/message`。GUI 上会不会出现「没有对应调用行」的孤立结果行，需要在真宿主里跑一次看。若确实会污染，切到「方案 B」：把 `src/index.ts` 的 `loadSkill()` 里 `ctx.tools.execute` 那段删掉、直接走它的退化分支（代价：`tools/result` 观察者看不到这次加载）。
- 本插件不把 `@deepseek-ai/dsh-llm` / `dsh-skill` 写进依赖：`createUserMessage` 与 `renderSkillContent` 由**宿主**提供（运行时从插件安装目录解析到的就是宿主那一份），拿不到时走上表的失败路径；**不会**在本仓手抄一份构造函数副本。

## License

MIT
