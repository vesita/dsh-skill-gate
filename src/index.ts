/**
 * dsh-skill-gate — 动手前的 skill 阅读门禁。
 *
 * 受保护的工具在调用前，本轮必须成功加载过 `requiredSkills` 里列出的每一份 skill：
 *   - `requiredSkills` 为空（默认）：**不拦** —— 没配必读名单时门禁不生效，直接放行；
 *   - `requiredSkills` 非空：名单里的**每一个**都要在本轮成功加载过，缺哪个就拒绝哪个。
 *
 * 判定只认原生 `skill` 工具的成功调用（`tools/result` 且 `isError` 假）。
 * 本插件**不提供任何工具**：解除门禁的唯一动作是真的加载一份 skill，没有可以空手调用的
 * 「声明」接口。
 *
 * 反死锁：配置里写了 catalog 里不存在的名字（skill 改名 / 删掉）时，这个名字本轮被忽略并记
 * 一行 warning；取不到 catalog（skills 服务缺席或调用失败）时保持严格。
 */

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
})

/**
 * 受保护的工具：真正改变状态、且事后难挽回的那几个。
 * 往这个名单里加名字之前，先问一句：拦错了会不会挡住纯探查？
 */
const GUARDED_TOOLS = new Set(['write', 'edit', 'plugin_manager'])

/**
 * bash 的写操作信号。只拦明确会改东西的命令；ls / cat / rg / git status
 * 这类读命令一律放行，否则每个任务开头都会撞门禁。
 */
const BASH_WRITE_SIGNAL = new RegExp(
  [
    '(^|[^<])>{1,2}(?!&)',
    '\\btee\\b',
    '\\brm\\b',
    '\\bmv\\b',
    '\\bcp\\b',
    '\\bmkdir\\b',
    '\\btouch\\b',
    '\\btruncate\\b',
    '\\bdd\\b',
    '\\bchmod\\b',
    '\\bchown\\b',
    '\\bln\\b',
    '\\bsed\\s+-i',
    '\\bpatch\\b',
    '\\binstall\\b',
    '\\bgit\\s+(commit|push|reset|checkout|clean|rebase|merge|apply|stash|switch|restore|branch)\\b',
    '\\b(systemctl|apt|apt-get|dpkg|pip|pipx|npm|pnpm|yarn|cargo|uv)\\s+(install|add|remove|uninstall|upgrade|update|publish|sync)\\b',
    '\\bsudo\\b',
  ].join('|'),
)

/** agentId -> 本轮成功加载过的 skill 名。 */
const loadedSkills = new Map()

/** agentId -> 当前 turn。turn 一变就作废上一轮的判定。 */
const turnOf = new Map()

/** agentId -> 本轮的 catalog 名字集合；null = 取不到 catalog（按严格处理）。 */
const catalogOf = new Map()

/**
 * `>/dev/null` 是空汇：它不改变任何状态。判定前先把它当作空白抹掉，
 * 否则 `cmd 2>/dev/null`、`dsh --dump-config >/dev/null` 这类纯读取会被当成写操作拦住。
 */
const NULL_SINK = /(^|[^<])(?:\d?|&)>{1,2}\s*\/dev\/null\b/g

function isGuarded(exec) {
  if (GUARDED_TOOLS.has(exec.name)) return true
  if (exec.name !== 'bash') return false
  const command = exec.arguments?.command
  if (typeof command !== 'string') return false
  return BASH_WRITE_SIGNAL.test(command.replace(NULL_SINK, ' '))
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
 * 那个错误在参数求值时就炸，`readRequiredSkills` 里的 try/catch 根本接不住，
 * 于是守卫与 pre-step 双双抛错 —— 写类工具与 plugin_manager 全被这个异常带走。
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

/**
 * best-effort 取一次当前 workspace 的 catalog 名字集合。
 * `skills` 是可选服务：缺席、拿不到 cwd、调用抛错都返回 null，由调用方按严格处理。
 */
async function fetchCatalog(ctx, agent, signal) {
  try {
    const skills = ctx.get('skills')
    if (!skills || typeof skills.list !== 'function') return null
    let cwd
    try {
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory && typeof workingDirectory.ensure === 'function') {
        cwd = await workingDirectory.ensure(agent, signal)
      }
    } catch {
      cwd = undefined
    }
    const list = await skills.list({ cwd, scope: agent })
    if (!Array.isArray(list)) return null
    const names = new Set()
    for (const item of list) {
      if (item && typeof item.name === 'string' && item.name !== '') names.add(item.name)
    }
    return names
  } catch {
    return null
  }
}

function warnUnknown(ctx, names) {
  try {
    const message =
      `skill-gate: requiredSkills 里的 ${names.join('、')} 不在当前 catalog 中，本轮忽略；` +
      '请检查配置里的 skill 名是否已改名或删除。'
    ctx.logger?.warn?.(message)
  } catch {
    // 记日志失败不影响门禁
  }
}

function denyMissing(toolName, missing) {
  const calls = missing.map((item) => `skill({ name: "${item}" })`).join('、')
  return (
    `${toolName} 被 skill-gate 拦下：本轮还没成功加载过必读 skill：${missing.join('、')}。` +
    `请先逐个调用 ${calls} 并加载成功。` +
    '只读工具（read / grep / glob 等）与只读 bash 不受限制。'
  )
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
 * 挂在**按 agent 的 scope 层**里，`skills.list({})` 只会看到全局层（插件运行时注册的那几份）。
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
          if (agent) {
            try {
              const workingDirectory = ctx.get('workingDirectory')
              if (workingDirectory && typeof workingDirectory.ensure === 'function') {
                lookup.cwd = await workingDirectory.ensure(agent, undefined)
              }
            } catch (e) {
              lookup.cwd = undefined
            }
          }
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

export function apply(ctx, config) {
  const requiredNow = () => readRequiredSkills([liveConfig(ctx), config])

  // 换 turn 就作废上一轮的判定：粒度是「一轮一次」，不是「一会话一次」。
  // agent/pre-step 是 waterfall —— 观察者只记录，决策必须原样交回去。
  ctx.on('agent/pre-step', async (payload, next) => {
    const id = payload?.agent?.id
    if (id !== undefined && turnOf.get(id) !== payload?.turn) {
      turnOf.set(id, payload?.turn)
      loadedSkills.delete(id)
      catalogOf.delete(id)

      const required = requiredNow()
      if (required.length > 0) {
        const catalog = await fetchCatalog(ctx, payload.agent, payload?.signal)
        catalogOf.set(id, catalog)
        if (catalog) {
          const unknown = required.filter((item) => !catalog.has(item))
          if (unknown.length > 0) warnUnknown(ctx, unknown)
        }
      }
    }
    return next()
  })

  // 观察成功的 skill 加载，记名。tools/result 是只读广播，不改结果本身。
  // 只有原生的 `skill` 工具算数：失败的加载（isError）不算，插件也不提供任何「声明」工具。
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
    loadedSkills.delete(id)
    turnOf.delete(id)
    catalogOf.delete(id)
  })

  // 门禁：同步、与其它 guard 的注册顺序无关
  ctx.tools.guard((exec) => {
    const id = exec.agent?.id
    if (id === undefined) return undefined // 无会话身份，不拦
    if (!isGuarded(exec)) return undefined

    // 没配必读名单 = 门禁不生效：直接放行。
    // （判定看的是「必读名单读全了没有」，不是「有没有加载过 skill」——后者是旧语义，已去掉。）
    const required = requiredNow()
    if (required.length === 0) return undefined

    // 非空名单：catalog 在场的名字逐个要求加载过；不在场的名字本轮忽略（反死锁）。
    // catalog 取不到（catalogOf 缺项或为 null）时保持严格；名单全不在场则本轮不锁死。
    const catalog = catalogOf.get(id)
    const effective = catalog instanceof Set ? required.filter((item) => catalog.has(item)) : required
    if (effective.length === 0) return undefined
    const loaded = loadedSkills.get(id)
    const missing = effective.filter((item) => !loaded || !loaded.has(item))
    return missing.length === 0 ? undefined : denyMissing(exec.name, missing)
  })

  // 本插件**不注册任何工具**：解除门禁的唯一动作是成功的原生 `skill` 加载。

  // 浏览器读 catalog 的只读路由：拿不到 webServer（非 web profile）时静默跳过。
  installClientRoute(ctx)
}

export default { name, inject, apply, Config }
