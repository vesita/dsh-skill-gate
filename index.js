/**
 * dsh-skill-gate — 动手前的 skill 阅读门禁。
 *
 * 受保护的工具在调用前，本轮必须成功加载过 skill：
 *   - `requiredSkills` 为空（默认）：本轮成功加载过**任意一份** skill 即可；
 *   - `requiredSkills` 非空：名单里的**每一个**都要成功加载过。
 *
 * 判定只认原生 `skill` 工具的成功调用（`tools/result` 且 `isError` 假）。
 * 本插件**不提供任何工具**：解除门禁的唯一动作是真的加载一份 skill，没有可以空手调用的
 * 「声明」接口。
 *
 * 反死锁：配置里写了 catalog 里不存在的名字（skill 改名 / 删掉）时，这个名字本轮被忽略并记
 * 一行 warning；取不到 catalog（skills 服务缺席或调用失败）时保持严格。
 */

import z from '@deepseek-ai/schemastery'

export const name = 'skill-gate'
export const inject = ['tools']

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

function isGuarded(exec) {
  if (GUARDED_TOOLS.has(exec.name)) return true
  if (exec.name !== 'bash') return false
  const command = exec.arguments?.command
  return typeof command === 'string' && BASH_WRITE_SIGNAL.test(command)
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

function denyAny(toolName) {
  return (
    `${toolName} 被 skill-gate 拦下：本轮还没成功加载过任何 skill。` +
    '先按任务内容扫一遍 skill catalog，命中就调 skill({ name: "<命中项>" }) 加载；' +
    '确认没有匹配项时，也要真实加载一份 skill 来完成本轮判定。' +
    '只读工具（read / grep / glob 等）与只读 bash 不受限制。'
  )
}

function denyMissing(toolName, missing) {
  const calls = missing.map((item) => `skill({ name: "${item}" })`).join('、')
  return (
    `${toolName} 被 skill-gate 拦下：本轮还没成功加载过必读 skill：${missing.join('、')}。` +
    `请先逐个调用 ${calls} 并加载成功。` +
    '只读工具（read / grep / glob 等）与只读 bash 不受限制。'
  )
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

    const required = requiredNow()
    const loaded = loadedSkills.get(id)

    if (required.length === 0) {
      // 默认语义：本轮成功加载过任意一份 skill 即放行
      return loaded && loaded.size > 0 ? undefined : denyAny(exec.name)
    }

    // 非空名单：catalog 在场的名字逐个要求加载过；不在场的名字本轮忽略（反死锁）。
    // catalog 取不到（catalogOf 缺项或为 null）时保持严格。
    const catalog = catalogOf.get(id)
    const effective = catalog instanceof Set ? required.filter((item) => catalog.has(item)) : required
    const missing = effective.filter((item) => !loaded || !loaded.has(item))
    return missing.length === 0 ? undefined : denyMissing(exec.name, missing)
  })

  // 本插件**不注册任何工具**：解除门禁的唯一动作是成功的原生 `skill` 加载。
}

export default { name, inject, apply, Config }
