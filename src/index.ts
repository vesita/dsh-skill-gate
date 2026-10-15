/**
 * dsh-skill-gate — 会话开始自动加载必读 skill（**不再拦截任何工具调用**）。
 *
 * `agent/created` 时，把 `requiredSkills` 里的 skill 逐个**真执行一次加载**：
 * `ctx.tools.execute({ name: 'skill', … })` 走完 `tools/pre-execute` → guards → 工具体 →
 * `tools/post-execute` → `tools/result` 广播。放在 created 而不是 pre-step 是**时序要求**：
 * `systemPrompt.assemble()` 在 `agent/pre-step` 之前跑，想让正文进**第一条**模型请求就得先加载完。
 *   - `requiredSkills` 为空（默认）：什么都不做 —— 没配名单 = 不生效；
 *   - 非空：catalog 里有的逐个加载；不在 catalog 的忽略并出声；**一条都没成功也留说明**。
 *
 * 正文与说明走**两条不同的通道**：
 *   - **正文**走 `systemPrompt.section({ interpolate: false })` —— 进系统提示，模型看得到、
 *     对话里看不到（`interpolate: false` 是硬要求：正文里的 `{{` 会被宿主当模板解析并抛错）；
 *   - **一行短的说明**走本步消息（`source.form = 'notice'`）—— 它就是用户在对话里看得见的那一行：
 *     点名这次加载了哪几份、说明是机制触发而不是模型调用，失败时点名缺哪份，并点明正文走了哪条路。
 *     `announce: 'off'` 只关掉「全部成功」那条；**没加载齐是状态，出声不受开关影响**。
 *
 * 降级（拿不到 `systemPrompt`，或加载发生在 pre-step 才补做）时，正文退回**本步消息**注入
 * （`form: 'instructions'`，对话里看得见），说明里点明原因 —— 宁可噪声，也不能让名单里的 skill
 * 悄悄不在上下文里。
 *
 * 「已加载」不是服务状态（`skills` 服务没有 isLoaded）：它就是**一次成功的 `skill` 工具执行**，
 * 所以本插件保留 `tools/result` 观察者作为**只读观测**（记录「这个会话加载过哪些」并汇总一行日志），
 * 而不是把同一条判定再实现一遍 —— 自动加载成立之后，拦截面（`tools/pre-execute` 守卫）已整体删除。
 *
 * 本插件**不注册任何工具**：名单里的 skill 由本插件自己真执行加载，没有可以空手调用的「声明」接口。
 *
 * 反死锁：配置里写了 catalog 里不存在的名字（skill 改名 / 删掉）时忽略并记一行 warning；
 * 取不到 catalog（skills 服务缺席或调用失败）时**不标记已加载、下一步重试**（读不到 ≠ 没有）。
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'

export const name = 'skill-gate'
export const inject = ['tools']

/** 浏览器读 catalog 的只读路由。浏览器拿不到 catalog，这条路由是双方唯一的共享事实。 */
export const SKILL_INDEX_ROUTE = '/dsh-skill-gate/skill-index'

/** 描述过网前截断到多少字符 —— 整份正文没有理由进浏览器。 */
const DESCRIPTION_LIMIT = 120

/** 插件配置。默认导出必须带上它，Loader 才投影得出条目配置、插件页才渲染配置表单。 */
export const Config = z.object({
  requiredSkills: z.array(z.string()).default([]).volatile(),
  /** 是否在会话里留一条**可见**的自动加载说明：`marker`（默认）/ `off`；认不出的取值按 `marker`。 */
  announce: z.string().default('marker').volatile(),
})

/** 自动加载那次执行的 callId 前缀：与模型发起的调用可区分，日志里一眼可辨。 */
const AUTOLOAD_CALL_PREFIX = 'skill-autoload:'

/** 系统提示里承载自动加载正文的 section 名。 */
export const AUTOLOAD_SECTION_NAME = 'skill-autoload'

/**
 * section 的排序位（越小越靠前）。取 700：在策略段（persona 0 / plan 500 / team 600）之后、
 * 工具说明段（1000 起）之前 —— 这几份正文是「这次会话的背景」，不该挤在工具契约中间。
 */
const AUTOLOAD_SECTION_ORDER = 700

/**
 * agentId -> 这个会话自动加载的结果。
 *
 * **只前进**（catalog 读不到是唯一的例外，见 pre-step）；`channel` 记正文这一轮走了哪条路，
 * 说明行里会点明 —— 降级也要看得见。
 */
const autoLoads = new Map()

/** agentId -> 说明行已经注入过。正文是否已交付由 `autoLoads` 记，两件事分开。 */
const announced = new Set()

/** agentId -> 本会话加载过的 skill 名。`tools/result` 只读观测的记录，也是日志汇总的来源。 */
const loadedSkills = new Map()

/** agentId -> 已经为「catalog 读不到」warn 过（不刷屏；**每一步仍会重试**）。 */
const catalogWarned = new Set()

/** 宿主提供的官方构造函数 / 渲染器；缺失时走各自的失败路径，**绝不在本仓手抄副本**。 */
interface HostHelpers {
  createUserMessage?: (input: any) => any
  renderSkillContent?: (skill: any) => string
}

function errorMessageOf(error) {
  return String((error && error.message) || error)
}

/**
 * 取宿主的官方 `createUserMessage` / `renderSkillContent`。
 *
 * **本插件不把 `@deepseek-ai/dsh-llm` / `dsh-skill` 写进 package.json**：它们由 dsh 本体提供，
 * 从插件安装目录解析到的就是宿主那一份。两处 `import` 用**变量 specifier** 是刻意的：
 * ① 本仓没有这两个包的类型，写字面量会让 `tsc` 直接 TS2307；
 * ② 「拿不到」应当是运行期的失败路径，而不是编译期把依赖声明偷偷加进来。
 * 手抄一份 `createUserMessage` / `renderSkillContent` 的副本是明确禁止的 —— 它会随上游
 * 消息形状静默腐烂（判据与先例见 dsh-collab 的 AGENTS.md §1）。
 */
async function resolveHostHelpers(deps: HostHelpers): Promise<HostHelpers> {
  const helpers: HostHelpers = {
    createUserMessage: deps.createUserMessage,
    renderSkillContent: deps.renderSkillContent,
  }
  if (typeof helpers.createUserMessage !== 'function') {
    try {
      const spec = '@deepseek-ai/dsh-llm'
      const mod: any = await import(spec)
      if (typeof mod.createUserMessage === 'function') helpers.createUserMessage = mod.createUserMessage
    } catch (error) {
      // 交给调用方按「拿不到」处理（warn 一次 + 本会话不再重试）
    }
  }
  if (typeof helpers.renderSkillContent !== 'function') {
    try {
      const spec = '@deepseek-ai/dsh-skill'
      const mod: any = await import(spec)
      if (typeof mod.renderSkillContent === 'function') helpers.renderSkillContent = mod.renderSkillContent
    } catch (error) {
      // 只在「skill 工具不可见」那条退化路径上才需要它
    }
  }
  return helpers
}

/** 配置里可能存着一个 volatile 引用（`{ get() }`），也可能就是普通数组。 */
function unwrap(value) {
  if (value && typeof value.get === 'function') {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

function normalizeNames(value) {
  const raw = unwrap(value)
  if (!Array.isArray(raw)) return []
  return raw.filter((item) => typeof item === 'string' && item.trim() !== '')
}

/**
 * 现读宿主的入口配置，拿不到就给 undefined。
 *
 * 坑：Cordis 的 ctx 是**代理**，未 inject 的属性不是 undefined 而是**抛错** ——
 * 直接写 `ctx.config` 会得到 `cannot get property "config" without inject`（`config` 不是服务，
 * 官方读法是 `apply(ctx, config)` 的那个参数，或 `<service>.config.<field>`）。
 * 那个错误在参数求值时就炸，包住读取的 try/catch 根本接不住。
 * `ctx.get('config')` 是可选取用（拿不到给 undefined），迷你宿主把 config 挂成普通字段时才退回读属性。
 */
function liveConfig(ctx) {
  try {
    const viaGet = ctx?.get?.('config')
    if (viaGet !== undefined) return viaGet
  } catch {
    // 取不到就走下面的兜底
  }
  try {
    return ctx?.config
  } catch {
    return undefined
  }
}

/**
 * 现读必读名单：优先宿主现读的那一份，退回 `apply(ctx, config)` 拿到的那一份。
 * volatile 字段是稳定引用，Loader 就地更新它的内容而不重载插件，所以这里每次都重新读。
 */
function readRequiredSkills(sources) {
  for (const source of sources) {
    if (!source) continue
    let raw
    try {
      raw = source.requiredSkills
    } catch {
      raw = undefined
    }
    const value = unwrap(raw)
    if (Array.isArray(value)) return normalizeNames(value)
  }
  return []
}

/** `announce` 的合法取值。 */
const ANNOUNCE_MODES = new Set(['marker', 'off'])

function normalizeAnnounce(value) {
  const raw = unwrap(value)
  return typeof raw === 'string' && ANNOUNCE_MODES.has(raw.trim()) ? raw.trim() : 'marker'
}

/**
 * 现读 `announce`：与必读名单同一套读法（宿主现读的那份优先，退回 `apply(ctx, config)` 那份）。
 * 认不出的取值一律按默认的 `marker` 处理 —— 显示开关不该因为拼错而变成静默关闭。
 */
function readAnnounce(sources) {
  for (const source of sources) {
    if (!source) continue
    let raw
    try {
      raw = source.announce
    } catch {
      raw = undefined
    }
    const value = unwrap(raw)
    if (typeof value === 'string') return normalizeAnnounce(value)
  }
  return 'marker'
}

/**
 * 当前 workspace 的 cwd，拿不到就 undefined。
 * `skill` 工具的 lookup 与只读路由共用这一份，别各写一遍。
 */
async function workingDirectoryOf(ctx, agent, signal) {
  try {
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory && typeof workingDirectory.ensure === 'function') {
      return await workingDirectory.ensure(agent, signal)
    }
  } catch (error) {
    // 拿不到 cwd 是正常的退化（迷你宿主 / 还没落盘的工作目录）
  }
  return undefined
}

/**
 * best-effort 取一次当前 workspace 的 catalog 名字集合。
 * `skills` 是可选服务：缺席、拿不到 cwd、调用抛错都返回 null —— 调用方据此**不标记、下一步重试**。
 */
async function fetchCatalog(ctx, agent, signal) {
  try {
    const skills = ctx.get('skills')
    if (!skills || typeof skills.list !== 'function') return null
    const cwd = await workingDirectoryOf(ctx, agent, signal)
    const list = await skills.list({ cwd, scope: agent })
    if (!Array.isArray(list)) return null
    const names = new Set()
    for (const item of list) {
      if (item && typeof item.name === 'string' && item.name !== '') names.add(item.name)
    }
    return names
  } catch (error) {
    return null
  }
}

/** 记一行 warning；同一个 agentId 上的同一类事只出声一次，别刷屏。 */
function warnOnce(ctx, seen, id, message) {
  if (seen.has(id)) return
  seen.add(id)
  try {
    ctx.logger?.warn?.(`skill-gate: ${message}`)
  } catch (error) {
    // 记日志失败不影响加载
  }
}

function warnUnknown(ctx, names) {
  try {
    const message =
      `skill-gate: requiredSkills 里的 ${names.join('、')} 不在当前 catalog 中，本次忽略；` +
      '请检查配置里的 skill 名是否已改名或删除。'
    ctx.logger?.warn?.(message)
  } catch (error) {
    // 记日志失败不影响加载
  }
}

/**
 * 加载一份 skill，返回要注入的内容块（或失败原因）。
 *
 * **切到方案 B（不产生一次 out-of-band 工具执行）只改这一个函数**：删掉 `ctx.tools.execute`
 * 那一段，直接走下面的「工具不可见」分支 —— 代价是 `tools/result` 观察者看不到这次加载。
 */
async function loadSkill(ctx, agent, signal, name, helpers: HostHelpers) {
  const tools = ctx.tools
  const skillTool = tools && typeof tools.get === 'function' ? tools.get('skill', agent) : undefined
  if (skillTool !== undefined && typeof tools.execute === 'function') {
    try {
      const exec = await tools.execute({
        callId: AUTOLOAD_CALL_PREFIX + randomUUID(),
        name: 'skill',
        arguments: { name },
        agent,
        signal,
      })
      if (exec && exec.isError !== true && Array.isArray(exec.content) && exec.content.length > 0) {
        return { content: exec.content, via: 'tool' }
      }
      const reason = (exec && exec.error && exec.error.message) || '工具执行没有返回内容'
      return { content: null, reason: String(reason) }
    } catch (error) {
      return { content: null, reason: errorMessageOf(error) }
    }
  }

  // `skill` 工具在这个 scope 不可见（被 restrict，或这个 agent 跑在 PTC 模式）：直接读正文。
  try {
    const skills = ctx.get('skills')
    if (!skills || typeof skills.get !== 'function') {
      return { content: null, reason: '没有可用的 skills 服务，且 skill 工具不可见' }
    }
    const skill = await skills.get(name, {
      cwd: await workingDirectoryOf(ctx, agent, signal),
      scope: agent,
      signal,
    })
    if (!skill) return { content: null, reason: '不在 catalog 或 provider 读不到' }
    if (typeof helpers.renderSkillContent !== 'function') {
      return { content: null, reason: '拿不到宿主的 renderSkillContent，无法渲染正文' }
    }
    return { content: [{ type: 'text', text: helpers.renderSkillContent(skill) }], via: 'service' }
  } catch (error) {
    return { content: null, reason: errorMessageOf(error) }
  }
}

/**
 * 会话里那条**可见且短**的说明。
 *
 * 它同时是模型与本步输入里的收尾句：点名这次自动加载了哪几份、说明是机制触发而不是模型调用；
 * 没加载齐（含一条都没成功）时点名缺哪份 —— 后者是**状态**，不是装饰，所以 `announce: off` 也拦不住它。
 * `channel` / `why` 用来点明**正文这一轮走了哪条路**（系统提示 / 随消息注入），降级不许静默。
 */
function autoloadMarkerText(loadedNames, missing, channel, why) {
  const head = 'skill-gate：会话开始自动加载（机制触发，不是模型调用）'
  const where = channel === 'section'
    ? '（正文在系统提示里，不占对话）'
    : `（正文随消息注入：${why || '会话开始时还没就绪'}）`
  if (loadedNames.length === 0) {
    return `${head}未完成 —— 未加载：${missing.join('；')}。不要假定这些纪律已在上下文中。`
  }
  const done = `已加载 ${loadedNames.join('、')}`
  return missing.length === 0
    ? `${head}：${done}${where}。`
    : `${head}：${done}；未加载：${missing.join('；')}${where}。`
}

/** 把工具返回的内容块折成纯文本：系统提示的 section 只吃字符串。 */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => (block && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}

/** 取宿主 `systemPrompt` 服务：**可选**（不进 inject —— 没有它的形态里不该让插件永远 park）。 */
function getSystemPrompt(ctx) {
  try {
    const service = ctx.get('systemPrompt')
    return service && typeof service === 'object' ? service : undefined
  } catch (error) {
    return undefined
  }
}

/**
 * section 的 text 提供者：按**这一步的 agent** 取这次自动加载的正文（`systemPrompt.assemble`
 * 传进来的装配上下文带 `agent`）。
 *
 * 没加载过、或这一轮正文走的是消息通道（降级）时返回空串 —— 空 section 不会进提示词。
 */
function autoloadTextOf(asctx) {
  const id = asctx && asctx.agent ? asctx.agent.id : undefined
  if (id === undefined) return ''
  const record = autoLoads.get(id)
  return record && record.channel === 'section' ? record.text : ''
}

/**
 * 从 `req.url` 里取 `?session=<id>`：没有查询串、参数为空、解析失败都返回 undefined。
 */
function sessionIdFromUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined
  const at = url.indexOf('?')
  if (at === -1) return undefined
  try {
    const value = new URLSearchParams(url.slice(at + 1)).get('session')
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch (e) {
    return undefined
  }
}

/**
 * 挑一个 agent 当 scope，优先级：`?session=` 指定的 → `roots()[0]` → `list()[0]` → `currentInitiator()`。
 * `agents` 是**可选**服务：缺席或调用抛错都返回 undefined，由调用方退回全局层并标 partial。
 */
function resolveAgent(ctx, sessionId: string | undefined) {
  let agents
  try {
    agents = ctx.get('agents')
  } catch (e) {
    return undefined
  }
  if (!agents) return undefined
  try {
    if (sessionId !== undefined && typeof agents.get === 'function') {
      const bySession = agents.get(sessionId)
      if (bySession) return bySession
    }
    if (typeof agents.roots === 'function') {
      const roots = agents.roots()
      if (Array.isArray(roots) && roots.length > 0) return roots[0]
    }
    if (typeof agents.list === 'function') {
      const list = agents.list()
      if (Array.isArray(list) && list.length > 0) return list[0]
    }
    if (typeof agents.currentInitiator === 'function') {
      const initiator = agents.currentInitiator()
      if (initiator) return initiator
    }
  } catch (e) {
    return undefined
  }
  return undefined
}

/**
 * 浏览器读 catalog 的只读路由（`GET /dsh-skill-gate/skill-index`）。
 *
 * 形状照 dsh 生态里同类的只读 loopback 路由：`ctx.inject(['webServer'], …)` 拿可选服务，
 * `webServer.register({ kind: 'exact', path, handler })` 挂上去，返回的 disposer 交给 `effect`；
 * 拿不到 `connection` 时 fail-closed 不服务。
 *
 * **列 catalog 的视角必须与原生 `skill` 工具一致**：文件型 provider（`~/.dsh/skills`、项目级）
 * 挂在**按 agent 的 scope** 层里，`skills.list({})` 只会看到全局层（插件运行时注册的那几份）。
 * 所以这里 `?session=` → `agents.get` / `roots()[0]` / `list()[0]` / `currentInitiator()` 选一个
 * agent 当 `scope`，cwd 走 `workingDirectory.ensure`；选不到 agent 才退回 `list({})`，并在载荷里
 * 标 `partial: true` + `reason`，让客户端显示警示而不是假装列表是全的。
 *
 * `webServer` 是**可选**服务：非 web profile（没有 web server）时整段静默跳过，宿主半边绝不
 * 因此报错。载荷只有名字与截断后的描述，不含路径、不含正文。
 */
function installClientRoute(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const webServer = webCtx.webServer
      if (!webServer || typeof webServer.register !== 'function') return
      webCtx.effect(() => webServer.register({
        kind: 'exact',
        path: SKILL_INDEX_ROUTE,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          // 围栏：拿不到 connection 就不服务（fail-closed）。这条载荷不含路径，但先例如此，
          // 少一道闸就少一道 —— 静默 fail-open 是要单独论证的例外，这里不给自己开。
          const connection = ctx.get('connection')
          let rejection: number | undefined
          try {
            if (!connection || typeof connection.requestRejection !== 'function') {
              sendJson(res, 503, { error: '围栏缺席：拿不到 connection.requestRejection，拒绝服务（fail-closed）' })
              return
            }
            rejection = connection.requestRejection(req)
          } catch (e) {
            sendJson(res, 503, { error: '围栏检查失败，拒绝服务（fail-closed）' })
            return
          }
          if (rejection !== undefined) {
            res.statusCode = rejection
            res.end()
            return
          }
          if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET')
            sendJson(res, 405, { error: '仅支持 GET' })
            return
          }

          const skills = ctx.get('skills')
          if (!skills || typeof skills.list !== 'function') {
            sendJson(res, 503, { error: '这个部署没有可用的 skills 服务，无法列出 catalog' })
            return
          }

          // 与原生 `skill` 工具同一个视角：agent 直接当 scope 传（文件型 provider 挂在这一层），
          // 不带 scope 就只剩全局层。选不到 agent 才退回全局层，并把这件事标进载荷。
          const agent = resolveAgent(ctx, sessionIdFromUrl(req.url))
          const lookup: any = { cwd: undefined, signal: undefined, scope: agent }
          if (agent) lookup.cwd = await workingDirectoryOf(ctx, agent, undefined)
          let list
          try {
            list = await (agent ? skills.list(lookup) : skills.list({}))
          } catch (e) {
            sendJson(res, 502, { error: '读取 catalog 失败：' + String((e && e.message) || e) })
            return
          }
          if (!Array.isArray(list)) {
            sendJson(res, 502, { error: 'catalog 返回的不是列表' })
            return
          }
          const payload: any = buildSkillIndex(list)
          payload.scope = agent ? 'agent' : 'global'
          if (!agent) {
            payload.partial = true
            payload.reason = '只列出全局层：当前没有可用的会话，项目级/用户级 skill 可能不在列表里'
          }
          sendJson(res, 200, payload)
        }
      }), `dsh-skill-gate: GET ${SKILL_INDEX_ROUTE}`)
    } catch (e) {}
  })
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.headersSent) return
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(payload))
}

/** 截断过网的说明文字；非字符串按空串处理。 */
function clipText(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : ''
  return text.length <= limit ? text : text.slice(0, limit) + '…'
}

/** 把 catalog 列表折成过网的形状：只有名字与截断后的描述，按名字排序。 */
export function buildSkillIndex(list: unknown): { skills: Array<{ name: string; description: string }> } {
  const items = Array.isArray(list) ? list : []
  const skills = items
    .filter((item) => item && typeof item.name === 'string' && item.name !== '')
    .map((item) => ({ name: item.name, description: clipText(item.description, DESCRIPTION_LIMIT) }))
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return { skills }
}

/**
 * @param ctx - host 上下文（`tools` 是硬依赖，`skills` / `workingDirectory` / `logger` / `webServer` 都可选）。
 * @param config - Loader 投影出来的条目配置。
 * @param deps - 宿主的官方构造器注入点（自检用）；生产留空，由 `resolveHostHelpers` 现读。
 */
export function apply(ctx, config, deps: HostHelpers = {}) {
  const requiredNow = () => readRequiredSkills([liveConfig(ctx), config])
  const announceNow = () => readAnnounce([liveConfig(ctx), config])
  const helpersPromise = resolveHostHelpers(deps)

  // 正文的交付通道：**系统提示的 section** 优先（模型看得到、对话里看不到）。section 的 text 是
  // 在 `systemPrompt.assemble()` 里取的，所以注册一次就够，按 agent 取值。
  // `interpolate: false` 是**硬要求**：skill 正文里可能出现 `{{`（arch-canvas 就专门写了守卫），
  // 不传这个开关宿主会按模板解析、引用不成立就**抛错**，整条提示词注入失败、会话起不来。
  const prompt = getSystemPrompt(ctx)
  let useSection = typeof prompt?.section === 'function'
  if (useSection) {
    try {
      ctx.effect(() => prompt.section({
        name: AUTOLOAD_SECTION_NAME,
        order: AUTOLOAD_SECTION_ORDER,
        interpolate: false,
        text: (asctx) => autoloadTextOf(asctx),
      }), 'skill-gate: skill-autoload section')
    } catch (error) {
      useSection = false
      try {
        ctx.logger?.warn?.('skill-gate: 注册 systemPrompt section 失败，正文退回消息注入：' + errorMessageOf(error))
      } catch (logError) {
        // 日志失败不影响降级
      }
    }
  }

  /**
   * 把一个会话的必读 skill 加载掉（同一个会话只做一次）。
   *
   * `when` 决定正文走哪条路：**在 `agent/created` 加载完**的会话走系统提示 section。
   * 原因是时序 —— `systemPrompt.assemble()` 发生在 `agent/pre-step` **之前**
   * （`dsh-agent-loop` 的 `preStep`：先 assemble、再跑 waterfall），所以想让正文进**第一条**请求，
   * 只能在 created 就加载完；到 pre-step 才加载的话，section 要到第二步才生效。
   * created 没做成（catalog 未就绪等）时退回 pre-step 补做，那时正文只能走消息通道（对话里看得见）
   * —— 宁可噪声，也不能让名单里的 skill 悄悄不在上下文里。
   */
  const ensureAutoLoaded = async (agent, signal, when) => {
    const id = agent?.id
    if (id === undefined) return null
    const cached = autoLoads.get(id)
    if (cached !== undefined) return cached
    const required = requiredNow()
    if (required.length === 0) return null // 没配名单 = 不生效

    const catalog = await fetchCatalog(ctx, agent, signal)
    if (catalog === null) {
      // 读不到 ≠ 没有：**不标记**，下一步重试（catalog 往往只是还没就绪）。
      warnOnce(ctx, catalogWarned, id, '取不到 skill catalog，本次不自动加载，下一步重试')
      return null
    }
    const unknown = required.filter((item) => !catalog.has(item))
    if (unknown.length > 0) warnUnknown(ctx, unknown)

    const helpers = await helpersPromise
    const names = []
    const missing = unknown.map((item) => `${item}（不在当前 catalog）`)
    const bodies = []
    for (const skillName of required) {
      if (!catalog.has(skillName)) continue
      const loaded = await loadSkill(ctx, agent, signal, skillName, helpers)
      if (loaded.content === null) {
        missing.push(`${skillName}（${loaded.reason}）`)
        continue
      }
      names.push(skillName)
      bodies.push({ name: skillName, content: loaded.content })
    }

    // created 期一份都没成：不回存 —— 留给 pre-step 在**运行期**再试一次（那时执行工具更稳），
    // 仍不成才如实记下来。
    if (when === 'created' && names.length === 0 && missing.length > 0) return null

    const record = {
      names,
      missing,
      bodies,
      text: bodies.map((body) => blocksToText(body.content)).filter((text) => text.length > 0).join('\n\n'),
      channel: useSection && when === 'created' ? 'section' : 'message',
      why: !useSection ? '本部署没有 systemPrompt' : when === 'created' ? '' : '会话开始时还没就绪',
    }
    autoLoads.set(id, record)
    return record
  }

  // 会话开始：赶在第一条模型请求装配提示词**之前**把正文准备好（见 ensureAutoLoaded 的注释）。
  // `agent/created` 的监听器是 serial 的：抛错会让这次创建整体失败，所以这里自己吞掉异常。
  ctx.on('agent/created', async (payload) => {
    try {
      // 两条交付通道都没有（没有 systemPrompt、也拿不到消息构造器）时，不执行注定看不见的加载。
      if (!useSection && typeof (await helpersPromise).createUserMessage !== 'function') return
      await ensureAutoLoaded(payload?.agent, payload?.signal, 'created')
    } catch (error) {
      try {
        ctx.logger?.warn?.('skill-gate: 会话开始自动加载失败：' + errorMessageOf(error))
      } catch (logError) {
        // 日志失败不影响创建
      }
    }
  })

  // 说明行（以及降级时的正文）在这里注入：消息只能从这个缝进本步输入。
  // waterfall —— 决策必须原样交回，只允许往后追加消息。
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision

    const agent = payload?.agent
    const id = agent?.id
    if (id === undefined) return decision // 无会话身份：不做事
    if (announced.has(id)) return decision // 说明一行一次

    const required = requiredNow()
    if (required.length === 0) return decision // 没配名单 = 不生效

    const announce = announceNow()
    const helpers = await helpersPromise
    // 没有 systemPrompt、也拿不到宿主的消息构造器：两条交付通道都没有。出声一次、本会话不再重试
    // （否则每步都会重复执行注定看不见的加载）。
    if (!useSection && typeof helpers.createUserMessage !== 'function') {
      announced.add(id)
      warnOnce(ctx, catalogWarned, id, '拿不到宿主的 createUserMessage 且没有 systemPrompt：本会话不自动加载')
      return decision
    }
    const record = await ensureAutoLoaded(agent, payload?.signal, 'pre-step')
    if (record === null) return decision // catalog 读不到：不标记，下一步重试

    announced.add(id)
    const messages = []
    const canMessage = typeof helpers.createUserMessage === 'function'
    if (!canMessage && record.names.length > 0 && record.channel === 'message') {
      warnOnce(ctx, catalogWarned, id, '拿不到宿主的 createUserMessage：说明与正文都进不了本步输入，本次会话读不到自动加载的内容')
    }

    // 一条**可见且短**的说明，排在正文之前（读起来先看到「发生了什么」）。
    // 它进的是 durable 会话（agent-loop 把 decision.messages 逐条 append 成 user/message），
    // 客户端把非 `user` 来源的这类行渲染成**注入的上下文行**。
    // `announce: off` 只关掉「全部加载成功」那条；没加载齐是状态，出声不受开关影响。
    if (canMessage && (announce !== 'off' || record.missing.length > 0)) {
      const text = autoloadMarkerText(record.names, record.missing, record.channel, record.why)
      messages.unshift(helpers.createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'skill-autoload', name: '*', form: 'notice', summary: clipText(text, 120) },
      }))
    }

    // 正文：**只有消息通道**才进对话。section 通道由系统提示承担，这里一条都不注入 ——
    // 否则就是同一份正文既在提示词里、又在对话里的双重噪声（这正是本次要修的问题）。
    if (record.channel === 'message' && canMessage) {
      for (const body of record.bodies) {
        messages.push(helpers.createUserMessage({
          content: body.content,
          source: { kind: 'skill-autoload', name: body.name, form: 'instructions' },
        }))
      }
    }

    try {
      const where = record.channel === 'section' ? '系统提示' : '消息'
      ctx.logger?.info?.(
        'skill-gate: 会话开始自动加载（正文走' + where + '）—— 已加载 ' +
        (record.names.length > 0 ? record.names.join('、') : '无') +
        (record.missing.length > 0 ? `；未加载 ${record.missing.join('；')}` : ''),
      )
    } catch (error) {
      // 日志失败不影响注入
    }
    if (messages.length === 0) return decision
    return { ...decision, messages: [...decision.messages, ...messages] }
  })

  // 只读观测：记下这个会话加载过哪些 skill（自动加载的那次执行同样会经过这里 —— `tools/result`
  // 是 execute 的最后一站）。它**不参与任何判定**，只用来汇总日志、供后续消费者读。
  ctx.on('tools/result', (exec, result) => {
    if (!result || result.isError) return
    if (!exec || exec.name !== 'skill') return
    const id = exec.agent?.id
    if (id === undefined) return
    const loadedName = exec.arguments?.name
    if (typeof loadedName !== 'string' || loadedName === '') return
    let names = loadedSkills.get(id)
    if (!names) {
      names = new Set()
      loadedSkills.set(id, names)
    }
    names.add(loadedName)
  })

  // 会话结束即回收，别让这几张表一直长
  ctx.on('agent/disposed', ({ agent }) => {
    const id = agent?.id
    if (id === undefined) return
    autoLoads.delete(id)
    announced.delete(id)
    loadedSkills.delete(id)
    catalogWarned.delete(id)
  })

  // 本插件**不拦任何工具调用**（守卫已删除：自动加载成立之后，同一条判定不再有第二处实现），
  // 也**不注册任何工具**：名单里的 skill 由上面的 pre-step 自己执行加载。

  // 浏览器读 catalog 的只读路由：拿不到 webServer（非 web profile）时静默跳过。
  installClientRoute(ctx)
}

export default { name, inject, apply, Config }
