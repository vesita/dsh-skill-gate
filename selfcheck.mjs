// dsh-skill-gate 的判定逻辑自检：不依赖 dsh 运行时，用假 ctx 喂事件，逐条断言。
// 判据是**构建产物**（`lib/index.js`），不是源码 —— 发布出去的就是它。
// 先 `pnpm run build`（`pnpm test` 已经带上了），退出码即判据：0 = 全过。
//
// 本插件现在的语义是「会话开始自动执行加载」，所以假 ctx 必须提供 `tools.execute`
// （并在返回前像真注册表那样广播一次 `tools/result`）：那是自动加载的**唯一**交付面。
import assert from 'node:assert/strict'
import plugin, { apply, Config } from './lib/index.js'

let checks = 0
function ok(cond, label) {
  checks++
  assert.ok(cond, label)
  console.log('  ok  ' + label)
}

let msgSeq = 0 /** 假的消息构造器：只为断言看得见 id 递增。 */
const createUserMessage = (input) => ({ ...input, id: `msg-${++msgSeq}`, role: 'user' })
const renderSkillContent = (skill) => `<skill_content name="${skill.name}">${skill.content}</skill_content>`

// 复刻宿主 `dsh-system-prompt` 的模板渲染（`renderPrompt()` / `interpolate()`）：
// `interpolate === false` 的 section **原样返回**；否则 `{{name}}` 必须命中已注册变量，**不命中就抛错**。
// 这是「skill 正文里的 `{{` 会不会把整条提示词注入搞崩」这条判据的伪宿主实现。
const GROUP_AT = /^\{\{([^{}]*)\}\}/
function interpolateLikeHost(section) {
  const text = section.text
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) throw new Error(`malformed prompt variable reference in section "${section.name}"`)
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2)
    throw new Error(`unknown prompt variable "{{${name}}}" in section "${section.name}"`)
  }
  return result + text.slice(last)
}
function renderLikeHost(section, text) {
  return section.interpolate === false ? text : interpolateLikeHost({ name: section.name, text })
}
/** section 的 text 可能是函数（装配时才求值）：按宿主那样把装配上下文（带 agent）传进去。 */
function sectionTextOf(def, agent) {
  return typeof def.text === 'function' ? def.text({ agent, scope: agent }) : def.text
}

/** 假 ctx：手写 on / tools / get / logger / inject，config 可在运行中替换。
 *  `configThrows` 复刻 Cordis 代理的行为：未 inject 的属性**抛错**，不是 undefined。 */
function makeCtx(opts = {}) {
  const handlers = new Map()
  const registered = []
  const warnings = []
  const infos = []
  const injects = []
  const sections = []
  const executed = []
  let guardRegistered = false
  const services = opts.services ?? {}
  if (opts.systemPrompt) {
    services.systemPrompt = { section(def) { sections.push(def); return () => {} } }
  }
  const ctx = {
    on(event, fn) { handlers.set(event, fn) },
    get(name) { return services[name] },
    inject(names, callback) { injects.push({ names, callback }); return () => {} },
    effect(fn) {
      const dispose = fn()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    logger: {
      warn: (m) => { warnings.push(String(m)) },
      info: (m) => { infos.push(String(m)) },
      error() {},
    },
    tools: {
      guard() { guardRegistered = true },
      register(def) { registered.push(def) },
      // 自动加载先问「这个 scope 里 skill 工具可不可见」；`skillToolVisible: false` 复刻被 restrict 的现场。
      get(name) { return opts.skillToolVisible === false ? undefined : { name } },
      async execute(input) {
        executed.push(input)
        const result = opts.executeResult
          ? opts.executeResult(input)
          : { isError: false, content: [{ type: 'text', text: `<skill_content name="${input.arguments.name}">body</skill_content>` }] }
        // 真注册表 execute 的最后一站就是 tools/result 广播（dsh-tools 的 notifyResult）。
        const notify = handlers.get('tools/result')
        if (typeof notify === 'function') {
          notify({ name: input.name, agent: input.agent, arguments: input.arguments }, result)
        }
        return result
      },
    },
  }
  if (opts.configThrows) {
    Object.defineProperty(ctx, 'config', {
      get() { throw new Error('cannot get property "config" without inject') },
    })
  } else {
    ctx.config = opts.config
  }
  // 消息构造器由宿主提供（见 src/index.ts 的 resolveHostHelpers）：自检把它当依赖注入。
  // `opts.hostDeps === false` 时不注入 —— 复刻「宿主里拿不到官方构造器」的现场。
  const deps = opts.hostDeps === false ? {} : { createUserMessage, renderSkillContent, ...(opts.hostDeps ?? {}) }
  apply(ctx, opts.applyConfig, deps)
  return {
    ctx,
    registered,
    warnings,
    infos,
    injects,
    sections,
    executed,
    hasGuard: () => guardRegistered,
    // 会话创建：真宿主在这里、且在第一条请求装配提示词**之前**触发。
    created: (agent) => handlers.get('agent/created')({ agent, source: 'startup', signal: undefined }),
    step: (agent, turn = 1, decision = { kind: 'enter', messages: [] }) =>
      handlers.get('agent/pre-step')({ agent, turn, step: 1, signal: undefined }, async () => decision),
    result: (agent, skillName, isError = false) =>
      handlers.get('tools/result')({ name: 'skill', agent, arguments: { name: skillName } }, { isError }),
    resultVia: (agent, toolName, args = {}) =>
      handlers.get('tools/result')({ name: toolName, agent, arguments: args }, { isError: false }),
    dispose: (agent) => handlers.get('agent/disposed')({ agent }),
  }
}

const catalog = (...names) => ({ list: async () => names.map((name) => ({ name })) })

const A = { id: 'agent-A' }
const B = { id: 'agent-B' }
const C = { id: 'agent-C' }
const D = { id: 'agent-D' }
const E = { id: 'agent-E' }
const F = { id: 'agent-F' }
const G = { id: 'agent-G' }
const H = { id: 'agent-H' }
const I = { id: 'agent-I' }
const J = { id: 'agent-J' }
const K = { id: 'agent-K' }
const N = { id: 'agent-N' }
const O = { id: 'agent-O' }
const P = { id: 'agent-P' }
const Q = { id: 'agent-Q' }
const R = { id: 'agent-R' }
const S = { id: 'agent-S' }
const T = { id: 'agent-T' }
const U = { id: 'agent-U' }
const V = { id: 'agent-V' }
const W = { id: 'agent-W' }
const X = { id: 'agent-X' }
const Y = { id: 'agent-Y' }

const allCtxs = []
function ctxOf(opts) {
  const made = makeCtx(opts)
  allCtxs.push(made)
  return made
}

console.log('# 0. 导出形状与 Config 默认值')
ok(typeof plugin.apply === 'function', '默认导出带 apply')
ok(plugin.Config === Config, '默认导出带 Config（漏了插件页配置表单会整张空白）')
ok(Array.isArray(plugin.inject) && plugin.inject.join(',') === 'tools', "inject 是 ['tools']")
{
  const parsed = Config['~standard'].validate({}).value
  const raw = parsed.requiredSkills
  const value = raw && typeof raw.get === 'function' ? raw.get() : raw
  ok(Array.isArray(value) && value.length === 0, 'Config 默认 requiredSkills 为 []')
}

console.log('# 1. 默认（requiredSkills: []）：什么都不做 —— 没配名单就不生效')
{
  const h = ctxOf({ config: { requiredSkills: [] } })
  await h.step(A, 1)
  ok(h.executed.length === 0, '1. 空名单：一次 tools.execute 都没有')
  ok(h.infos.length === 0, '1. 空名单：不记自动加载日志')
}

console.log('# 2. 首次 agent/pre-step：逐个**真执行**一次加载 + 一条可见说明 + 正文进本步消息')
{
  const h = ctxOf({ config: { requiredSkills: ['a', 'b'] }, services: { skills: catalog('a', 'b') } })
  const decision = await h.step(B, 1)
  ok(h.executed.length === 2, '2. execute 恰好 N 次（N = 名单 ∩ catalog = 2）')
  ok(h.executed.every((e) => e.name === 'skill'), "2. 执行的都是 skill 工具")
  ok(h.executed.every((e) => typeof e.callId === 'string' && e.callId.startsWith('skill-autoload:')),
    '2. callId 带可区分的 skill-autoload: 前缀')
  ok(h.executed.map((e) => e.arguments.name).join(',') === 'a,b', '2. 逐个按名单顺序执行')

  const markers = decision.messages.filter((m) => m.source.form === 'notice')
  const bodies = decision.messages.filter((m) => m.source.form === 'instructions')
  ok(decision.kind === 'enter' && decision.messages.length === 3, '2. 本步消息 = 1 条说明 + 2 条正文')
  ok(markers.length === 1, '2. 可见说明**恰好一条**（这就是对话里能看见的那一行）')
  ok(decision.messages[0] === markers[0], '2. 说明排在正文之前（先看到发生了什么）')
  ok(markers[0].content[0].text.includes('已加载 a、b'), '2. 说明点名这次自动加载了哪几份')
  ok(markers[0].content[0].text.includes('机制触发'), '2. 说明点明是机制触发、不是模型调用')
  ok(typeof markers[0].source.summary === 'string' && markers[0].source.summary.length <= 120,
    '2. 说明带 ≤120 字的 summary（客户端按 form=notice 呈现）')
  ok(bodies.length === 2 && bodies.every((m) => m.role === 'user' && m.source.kind === 'skill-autoload'),
    "2. 正文 role=user 且 source.kind='skill-autoload'")
  ok(bodies.map((m) => m.source.name).join(',') === 'a,b', '2. 每条正文点名它加载的 skill')
  ok(bodies[0].content[0].text.includes('<skill_content name="a">'), '2. 注入的是工具执行返回的正文')
  ok(h.infos.length === 1 && h.infos[0].includes('已加载 a、b'), '2. 只读观测汇总成一行 info 日志')
}

console.log('# 3. 会话一次：第二次 pre-step 不再执行')
{
  const h = ctxOf({ config: { requiredSkills: ['a'] }, services: { skills: catalog('a') } })
  await h.step(C, 1)
  const second = await h.step(C, 2)
  ok(h.executed.length === 1, '3. 第二个 pre-step 不再 execute')
  ok(second.messages.length === 0, '3. 第二个 pre-step 不再注入')
}

console.log('# 4. 名单里 catalog 没有的名字：不执行它 + 说明行点名')
{
  const h = ctxOf({ config: { requiredSkills: ['a', 'b'] }, services: { skills: catalog('a') } })
  const decision = await h.step(D, 1)
  ok(h.executed.length === 1 && h.executed[0].arguments.name === 'a', '4. 只执行 catalog 里有的 a')
  ok(h.warnings.some((w) => w.includes('b')), '4. 不在 catalog 的 b 记一行 warning')
  const note = decision.messages.find((m) => m.source.form === 'notice')
  ok(note !== undefined && note.content[0].text.includes('b'), '4. 说明行点名 b')
  ok(note.content[0].text.includes('未加载') && note.content[0].text.includes('不在当前 catalog'),
    '4. 说明行说清 b 是「未加载（不在当前 catalog）」')
}

console.log('# 5. 一条都没成功也注入说明行（不许让人以为已经加载过）')
{
  const h = ctxOf({ config: { requiredSkills: ['zzz'] }, services: { skills: catalog('a') } })
  const decision = await h.step(E, 1)
  ok(h.executed.length === 0, '5. 全不在 catalog：一次也不执行')
  ok(decision.messages.length === 1 && decision.messages[0].source.form === 'notice',
    '5. 仍然注入恰好一条说明行')
  ok(decision.messages[0].content[0].text.includes('zzz'), '5. 说明行点名 zzz')
}

console.log('# 6. 执行失败（isError）不算成功：正文不注入，进说明行')
{
  const h = ctxOf({
    config: { requiredSkills: ['a'] },
    services: { skills: catalog('a') },
    executeResult: () => ({ isError: true, error: { message: '被别的守卫拒了' } }),
  })
  const decision = await h.step(F, 1)
  ok(h.executed.length === 1, '6. 仍然尝试执行了一次')
  ok(decision.messages.length === 1 && decision.messages[0].source.form === 'notice', '6. 只有说明行，没有正文')
  ok(decision.messages[0].content[0].text.includes('被别的守卫拒了'), '6. 说明行带上失败原因')
}

console.log('# 7. skill 工具在该 scope 不可见：退回 skills.get + renderSkillContent')
{
  const h = ctxOf({
    config: { requiredSkills: ['a'] },
    skillToolVisible: false,
    services: { skills: { list: async () => [{ name: 'a' }], get: async (name) => ({ name, content: '正文' }) } },
  })
  const decision = await h.step(G, 1)
  ok(h.executed.length === 0, '7. 工具不可见时不做注定 UNKNOWN_TOOL 的执行')
  const body = decision.messages.find((m) => m.source.form === 'instructions')
  ok(body !== undefined && body.source.kind === 'skill-autoload', '7. 仍然注入正文（走 service）')
  ok(body.content[0].text === '<skill_content name="a">正文</skill_content>',
    '7. 用的是宿主的 renderSkillContent')

  const noRenderer = ctxOf({
    config: { requiredSkills: ['a'] },
    hostDeps: { renderSkillContent: undefined },
    skillToolVisible: false,
    services: { skills: { list: async () => [{ name: 'a' }], get: async (name) => ({ name, content: '正文' }) } },
  })
  const fallback = await noRenderer.step(H, 1)
  ok(fallback.messages.length === 1 && fallback.messages[0].source.form === 'notice',
    '7. 拿不到 renderSkillContent 时如实进说明行，不伪造正文')
}

console.log('# 8. catalog 读不到：**不标记**、下一步重试（读不到 ≠ 没有）')
{
  let attempts = 0
  const flaky = {
    list: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('catalog 还没就绪')
      return [{ name: 'a' }]
    },
  }
  const h = ctxOf({ config: { requiredSkills: ['a'] }, services: { skills: flaky } })
  const first = await h.step(I, 1)
  ok(h.executed.length === 0 && first.messages.length === 0, '8. 第一次读不到：不执行、不注入')
  ok(h.warnings.some((w) => w.includes('下一步重试')), '8. 出声说明会重试')
  const second = await h.step(I, 2)
  ok(h.executed.length === 1, '8. 第二次 pre-step 真的重试并加载成功')
  ok(second.messages.filter((m) => m.source.form === 'instructions').length === 1, '8. 第二次注入正文')
  ok(h.warnings.filter((w) => w.includes('下一步重试')).length === 1, '8. 重试提示不刷屏（同 agent 只出声一次）')

  const missing = ctxOf({ config: { requiredSkills: ['a'] }, services: {} })
  await missing.step(J, 1)
  await missing.step(J, 2)
  ok(missing.executed.length === 0 && missing.warnings.length === 1, '8. skills 服务缺席：每步重试但不刷屏')
}

console.log('# 9. 拿不到宿主的 createUserMessage：出声一次、不执行、不抛')
{
  const h = ctxOf({ config: { requiredSkills: ['a'] }, hostDeps: false, services: { skills: catalog('a') } })
  let threw = null
  try {
    await h.step(K, 1)
  } catch (e) {
    threw = e
  }
  ok(threw === null, '9. 不抛穿')
  ok(h.executed.length === 0, '9. 没有交付面就不做执行（避免每步重复执行）')
  ok(h.warnings.length === 1 && h.warnings[0].includes('createUserMessage'), '9. 出声一次点名原因')
  await h.step(K, 2)
  ok(h.warnings.length === 1, '9. 本会话不再重复出声')
}

console.log('# 10. 无会话身份 / 只读观测不触发执行 / dispose 回收')
{
  const h = ctxOf({ config: { requiredSkills: ['a'] }, services: { skills: catalog('a') } })
  await h.step({}, 1)
  ok(h.executed.length === 0, '10. 没有 agent.id：不做事')

  // 模型自己加载过的 skill：只落进只读观测，不会让插件再执行一次。
  h.result(O, 'x')
  ok(h.executed.length === 0, '10. 只读观测不触发执行')

  await h.step(N, 1)
  ok(h.executed.length === 1, '10. 新会话照常自动加载一次')
  await h.step(N, 2)
  ok(h.executed.length === 1, '10. 同一会话第二次不重复')
  h.dispose(N)
  await h.step(N, 3)
  ok(h.executed.length === 2, '10. dispose 回收标记后重新加载一趟')
}

console.log('# 11. 本插件不注册工具、不注册 guard（拦截面整体删除）')
ok(allCtxs.every((h) => h.registered.length === 0), '11. tools.register 零调用')
ok(allCtxs.every((h) => h.hasGuard() === false), '11. tools.guard 零调用')
{
  const h = ctxOf({ config: { requiredSkills: ['a'] }, services: { skills: catalog('a') } })
  await h.step(P, 7)
  ok(h.executed.length === 1 && h.executed[0].name === 'skill', '11. 唯一会被本插件执行的工具就是 skill')
}

console.log('# 12. agent/pre-step 决策原样交回，只在末尾追加消息')
{
  const h = ctxOf({ config: { requiredSkills: ['a'] }, services: { skills: catalog('a') } })
  const incoming = { kind: 'enter', messages: [{ id: 'msg-0', role: 'user', content: [], source: { kind: 'user' } }], startsRequestSeries: true }
  const decision = await h.step(Q, 9, incoming)
  ok(decision.kind === 'enter' && decision.startsRequestSeries === true, '12. 决策字段原样交回')
  ok(decision.messages.length === 3 && decision.messages[0].id === 'msg-0', '12. 原有消息在前，注入在后（说明 + 正文）')

  const rejecting = ctxOf({ config: { requiredSkills: ['a'] }, services: { skills: catalog('a') } })
  const rejected = await rejecting.step(Q, 9, { kind: 'reject' })
  ok(rejected.kind === 'reject' && rejecting.executed.length === 0, '12. reject 原样交回，且不加载')
}

console.log('# 13. 宿主只读路由：不起浏览器也能验注册与返回形状')
{
  /** 假 res：只实现 handler 用到的那几个方法（writeHead / setHeader / end）。 */
  function fakeRes() {
    return {
      statusCode: 200,
      headersSent: false,
      headers: {},
      body: undefined,
      setHeader(key, value) { this.headers[key.toLowerCase()] = value },
      writeHead(code, headers) {
        this.statusCode = code
        this.headersSent = true
        if (headers) for (const key of Object.keys(headers)) this.headers[key.toLowerCase()] = headers[key]
      },
      end(body) { if (body !== undefined) this.body = String(body) },
    }
  }
  /** 把一个 ctx 的 webServer 订阅召唤起来，返回捕获到的路由表。 */
  function mountRoutes(h) {
    const routes = []
    const subscribed = h.injects.filter((entry) => entry.names.includes('webServer'))
    for (const entry of subscribed) {
      entry.callback({
        webServer: { register(route) { routes.push(route); return () => {} } },
        effect(fn) { return fn() },
      })
    }
    return { routes, subscribed: subscribed.length }
  }

  const longDescription = 'x'.repeat(200)
  const h = ctxOf({
    config: { requiredSkills: [] },
    services: {
      connection: { requestRejection: () => undefined },
      skills: {
        list: async () => [
          { name: 'zeta-skill', description: longDescription },
          { name: 'alpha-skill', description: '第一份' },
          { name: '', description: '没有名字，应被丢掉' },
        ],
      },
    },
  })
  const { routes, subscribed } = mountRoutes(h)
  ok(subscribed === 1, '13. 只对 webServer 订阅一次（拿不到服务就不会注册路由）')
  ok(routes.length === 1, '13. webServer 在场时注册恰好一条路由')
  ok(routes[0] && routes[0].kind === 'exact', "13. 路由 kind 是 'exact'")
  ok(routes[0] && routes[0].path === '/dsh-skill-gate/skill-index', '13. 路由路径是 /dsh-skill-gate/skill-index')

  const res = fakeRes()
  await routes[0].handler({ method: 'GET' }, res)
  const body = JSON.parse(res.body)
  ok(res.statusCode === 200, '13. GET 返回 200')
  ok(Array.isArray(body.skills) && body.skills.length === 2, '13. 丢掉没有名字的条目后剩两条')
  ok(body.skills[0].name === 'alpha-skill' && body.skills[1].name === 'zeta-skill', '13. 按名字排序')
  ok(body.skills[1].description.length === 121 && body.skills[1].description.endsWith('…'),
    '13. 长描述截断到 120 字加省略号')
  ok(typeof body.skills[0].description === 'string' && !('content' in body.skills[0]),
    '13. 载荷只有名字与描述，没有正文')

  const post = fakeRes()
  await routes[0].handler({ method: 'POST' }, post)
  ok(post.statusCode === 405 && post.headers.allow === 'GET', '13. 非 GET 返回 405 且带 Allow: GET')

  // 围栏：拿不到 connection 就不服务（fail-closed）。
  const noFence = ctxOf({ config: { requiredSkills: [] }, services: { skills: { list: async () => [] } } })
  const noFenceRoutes = mountRoutes(noFence).routes
  const fenced = fakeRes()
  await noFenceRoutes[0].handler({ method: 'GET' }, fenced)
  ok(fenced.statusCode === 503 && JSON.parse(fenced.body).error.includes('fail-closed'),
    '13. 拿不到 connection.requestRejection：503 且不服务')

  // 围栏拒绝：把 connection 给的状态码原样交回。
  const rejecting = ctxOf({
    config: { requiredSkills: [] },
    services: { connection: { requestRejection: () => 403 }, skills: { list: async () => [] } },
  })
  const rejectRes = fakeRes()
  await mountRoutes(rejecting).routes[0].handler({ method: 'GET' }, rejectRes)
  ok(rejectRes.statusCode === 403, '13. 围栏拒绝时把状态码原样交回')

  // skills 服务缺席 / list 抛错：明确错误形状，不抛穿。
  const noSkills = ctxOf({ config: { requiredSkills: [] }, services: { connection: { requestRejection: () => undefined } } })
  const noSkillsRes = fakeRes()
  await mountRoutes(noSkills).routes[0].handler({ method: 'GET' }, noSkillsRes)
  ok(noSkillsRes.statusCode === 503 && typeof JSON.parse(noSkillsRes.body).error === 'string',
    '13. skills 服务缺席：503 + { error }')

  const boom = ctxOf({
    config: { requiredSkills: [] },
    services: {
      connection: { requestRejection: () => undefined },
      skills: { list: async () => { throw new Error('boom') } },
    },
  })
  const boomRes = fakeRes()
  let handlerThrew = null
  try {
    await mountRoutes(boom).routes[0].handler({ method: 'GET' }, boomRes)
  } catch (e) {
    handlerThrew = e
  }
  ok(handlerThrew === null && boomRes.statusCode === 502 && JSON.parse(boomRes.body).error.includes('boom'),
    '13. list 抛错：502 + { error }，异常不抛穿')

  // 非 web profile：webServer 缺席（订阅从不触发）时 apply 不报错，也不注册路由。
  const noWeb = ctxOf({ config: { requiredSkills: [] } })
  ok(noWeb.injects.length === 1 && noWeb.injects[0].names.join(',') === 'webServer',
    '13. 只留一条 webServer 订阅，订阅未触发时不注册路由（非 web profile 优雅降级）')
  let badWebThrew = null
  try {
    noWeb.injects[0].callback({ webServer: {}, effect(fn) { return fn() } })
  } catch (e) {
    badWebThrew = e
  }
  ok(badWebThrew === null, '13. webServer 形状不对时静默跳过，不抛')

  // ── agent scope：列 catalog 必须与原生 `skill` 工具同一视角 ──────────────
  // 文件型 provider 挂在按 agent 的 scope 层；不带 scope 就只剩全局层那几份。
  const agentA = { id: 'agent-A' }
  const agentB = { id: 'agent-B' }
  const ensuredCwd = '/tmp/workspace-probe'

  /** 记录 skills.list 的入参，其余用假 agents / workingDirectory 喂。 */
  function scopedCtx(opts) {
    const calls = []
    const services = {
      connection: { requestRejection: () => undefined },
      skills: {
        list: async (options) => {
          calls.push(options)
          return [{ name: 'only-one', description: '' }]
        },
      },
    }
    if (opts.agents !== undefined) services.agents = opts.agents
    if (opts.workingDirectory !== undefined) services.workingDirectory = opts.workingDirectory
    const h = ctxOf({ config: { requiredSkills: [] }, services })
    return { h, calls }
  }

  // 有 agent：scope 就是它，cwd 来自 workingDirectory.ensure，载荷标 scope:'agent'。
  {
    const { h, calls } = scopedCtx({
      agents: { roots: () => [agentA], list: () => [agentA], currentInitiator: () => agentA },
      workingDirectory: { ensure: async (agent) => (agent === agentA ? ensuredCwd : undefined) },
    })
    const res = fakeRes()
    await mountRoutes(h).routes[0].handler({ method: 'GET', url: '/dsh-skill-gate/skill-index' }, res)
    const body = JSON.parse(res.body)
    ok(calls.length === 1 && calls[0].scope === agentA, '13. 有 agent 时把它原样作为 scope 传给 skills.list')
    ok(calls[0].cwd === ensuredCwd, '13. cwd 来自 workingDirectory.ensure(agent)')
    ok(body.scope === 'agent' && body.partial === undefined, "13. 正常路径载荷 scope='agent' 且不标 partial")
  }

  // ?session= 命中：用它指定的 agent，而不是 roots()[0]。
  {
    const { h, calls } = scopedCtx({
      agents: {
        get: (id) => (id === 'session-target' ? agentA : undefined),
        roots: () => [agentB],
        list: () => [agentB],
        currentInitiator: () => agentB,
      },
      workingDirectory: { ensure: async () => ensuredCwd },
    })
    await mountRoutes(h).routes[0].handler(
      { method: 'GET', url: '/dsh-skill-gate/skill-index?session=session-target' }, fakeRes())
    ok(calls[0].scope === agentA, '13. ?session= 命中时用它指定的 agent 当 scope')
  }

  // ?session= 未命中：退回 roots()[0]。
  {
    const { h, calls } = scopedCtx({
      agents: { get: () => undefined, roots: () => [agentA], list: () => [agentB], currentInitiator: () => agentB },
      workingDirectory: { ensure: async () => undefined },
    })
    await mountRoutes(h).routes[0].handler(
      { method: 'GET', url: '/dsh-skill-gate/skill-index?session=missing' }, fakeRes())
    ok(calls[0].scope === agentA, '13. ?session= 未命中时退回 roots()[0]')
  }

  // roots/list 都空：退回 currentInitiator()。
  {
    const { h, calls } = scopedCtx({
      agents: { get: () => undefined, roots: () => [], list: () => [], currentInitiator: () => agentA },
      workingDirectory: { ensure: async () => undefined },
    })
    await mountRoutes(h).routes[0].handler({ method: 'GET', url: '/dsh-skill-gate/skill-index' }, fakeRes())
    ok(calls[0].scope === agentA, '13. roots/list 都空时退回 currentInitiator()')
  }

  // 没有 agents 服务：退回 list({})，并在载荷里标 partial + reason。
  {
    const { h, calls } = scopedCtx({})
    const res = fakeRes()
    await mountRoutes(h).routes[0].handler(
      { method: 'GET', url: '/dsh-skill-gate/skill-index?session=whatever' }, res)
    const body = JSON.parse(res.body)
    ok(calls.length === 1 && Object.keys(calls[0]).length === 0, '13. 没有 agents 服务时退回 list({})：入参是空对象')
    ok(body.partial === true && typeof body.reason === 'string' && body.reason !== '',
      '13. 退化路径标 partial:true + 非空 reason')
    ok(body.scope === 'global', "13. 退化路径 scope='global'")
  }
}

console.log('# 14. 宿主把 config 读成抛错（Cordis 代理）时，pre-step 不炸且仍能自动加载')
{
  // 真宿主：`ctx.config` 不是 undefined 而是抛 `cannot get property "config" without inject`，
  // 只有 `apply(ctx, config)` 的那份配置可用。
  const h = ctxOf({
    configThrows: true,
    applyConfig: { requiredSkills: ['a'] },
    services: { skills: catalog('a') },
  })
  let stepError = null
  let decision = null
  try {
    decision = await h.step(R, 1)
  } catch (e) {
    stepError = e
  }
  ok(stepError === null, '14. agent/pre-step 现读配置不抛错')
  ok(h.executed.length === 1 && h.executed[0].arguments.name === 'a', '14. 兜底读 apply(ctx, config) 的名单并自动加载')
  ok(decision.messages.length === 2, '14. 注入说明 + 正文')
}

console.log('# 15. announce 开关：`off` 只关掉「全部加载成功」那条说明（没加载齐仍然出声）')
{
  const off = ctxOf({ config: { requiredSkills: ['a', 'b'], announce: 'off' }, services: { skills: catalog('a', 'b') } })
  const decision = await off.step(S, 1)
  ok(off.executed.length === 2, '15. off 不影响加载本身（照样逐个执行）')
  ok(decision.messages.filter((m) => m.source.form === 'notice').length === 0, '15. off：全部成功时一条说明都不产生')
  ok(decision.messages.filter((m) => m.source.form === 'instructions').length === 2, '15. off：正文照旧注入')

  const offMissing = ctxOf({ config: { requiredSkills: ['a', 'zzz'], announce: 'off' }, services: { skills: catalog('a') } })
  const partial = await offMissing.step(T, 1)
  const stillSpoken = partial.messages.filter((m) => m.source.form === 'notice')
  ok(stillSpoken.length === 1 && stillSpoken[0].content[0].text.includes('zzz'),
    '15. off + 没加载齐：仍然出声并点名 zzz（状态不是装饰）')

  const typo = ctxOf({ config: { requiredSkills: ['a'], announce: 'mk' }, services: { skills: catalog('a') } })
  const typed = await typo.step(U, 1)
  ok(typed.messages.filter((m) => m.source.form === 'notice').length === 1, '15. 认不出的取值按默认 marker 处理')
  const parsed = Config['~standard'].validate({}).value.announce
  ok((parsed && typeof parsed.get === 'function' ? parsed.get() : parsed) === 'marker', '15. Config 默认 announce 为 marker')
}

console.log('# 16. 正文走系统提示 section（对话里只留说明）；装配发生在 pre-step 之前，所以 created 期加载')
{
  const h = ctxOf({
    config: { requiredSkills: ['a', 'b'] },
    systemPrompt: true,
    services: { skills: catalog('a', 'b') },
  })
  ok(h.sections.length === 1, '16. 注册了恰好一个 systemPrompt section')
  const def = h.sections[0]
  ok(def.name === 'skill-autoload', '16. section 名是 skill-autoload')
  ok(typeof def.order === 'number' && Number.isFinite(def.order), '16. section 带有限 order')
  ok(def.interpolate === false, "16. section 显式 interpolate:false（否则正文里的 {{ 会被当模板）")
  ok(sectionTextOf(def, V) === '', '16. 还没加载过：section 是空串（不进提示词）')

  await h.created(V) // 真宿主在装配第一条请求的提示词之前触发
  ok(h.executed.length === 2, '16. created 期就把两份都加载了（赶在 pre-step 的 assemble 之前）')
  const text = sectionTextOf(def, V)
  ok(text.includes('<skill_content name="a">body</skill_content>'), '16. section 正文就是这次加载的正文（a）')
  ok(text.includes('<skill_content name="b">body</skill_content>'), '16. 两份都在同一个 section 里（b）')
  ok(sectionTextOf(def, W) === '', '16. 按 agent 归属：别的会话拿到的是空串')

  const decision = await h.step(V, 1)
  ok(decision.messages.filter((m) => m.source.form === 'instructions').length === 0,
    "16. 正文**不再**是 messages 里的 form:'instructions'（对话里看不到正文）")
  const notices = decision.messages.filter((m) => m.source.form === 'notice')
  ok(notices.length === 1 && decision.messages.length === 1, '16. 本步消息只剩那一条说明')
  ok(notices[0].content[0].text.includes('正文在系统提示里'), '16. 说明点明正文走了系统提示、不占对话')
  ok(renderLikeHost(def, text) === text, '16. 传了 interpolate:false：宿主原样返回，不抛')

  // 降级：拿不到 systemPrompt → 正文退回消息（对话里看得见），说明里点明
  const noPrompt = ctxOf({ config: { requiredSkills: ['a'] }, services: { skills: catalog('a') } })
  const fallback = await noPrompt.step(X, 1)
  ok(fallback.messages.filter((m) => m.source.form === 'instructions').length === 1,
    '16. 没有 systemPrompt：正文仍作消息注入（宁可噪声也不丢正文）')
  const fallbackNotice = fallback.messages.find((m) => m.source.form === 'notice')
  ok(fallbackNotice.content[0].text.includes('本部署没有 systemPrompt'),
    '16. 降级说明里点明原因')

  // 降级：有 systemPrompt，但加载发生在 pre-step（created 没做成）→ 这一轮仍走消息
  const late = ctxOf({ config: { requiredSkills: ['a'] }, systemPrompt: true, services: { skills: catalog('a') } })
  const lateDecision = await late.step(Y, 1)
  ok(lateDecision.messages.filter((m) => m.source.form === 'instructions').length === 1,
    '16. created 没做成时：正文这一轮仍作消息注入')
  ok(lateDecision.messages.find((m) => m.source.form === 'notice').content[0].text.includes('会话开始时还没就绪'),
    '16. 并点明是「会话开始时还没就绪」')
}

console.log('# 17. 负向对照：正文里的 {{hexagon}} 在没传 interpolate:false 的实现下会抛错')
{
  const h = ctxOf({
    config: { requiredSkills: ['a'] },
    systemPrompt: true,
    services: { skills: catalog('a') },
    executeResult: () => ({
      isError: false,
      content: [{ type: 'text', text: '<skill_content name="a">{{hexagon}}</skill_content>' }],
    }),
  })
  await h.created(W)
  const def = h.sections[0]
  const text = sectionTextOf(def, W)
  ok(text.includes('{{hexagon}}'), '17. 正文原样带着 {{hexagon}}')
  let err = null
  try {
    renderLikeHost({ ...def, interpolate: undefined }, text)
  } catch (e) {
    err = e
  }
  ok(err !== null && /unknown prompt variable/.test(err.message),
    '17. 没传 interpolate:false 的实现在伪宿主里抛错（这个开关有牙）')
  const rendered = renderLikeHost(def, text)
  ok(rendered.includes('{{hexagon}}'), '17. 本实现（interpolate:false）不抛，且字面保留 {{hexagon}}')
}

console.log(`\nskill-gate 自检：${checks} 条断言全过（插件不注册任何工具、不注册任何守卫）`)
