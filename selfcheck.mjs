// dsh-skill-gate 的判定逻辑自检：不依赖 dsh 运行时，用假 ctx 喂事件，逐条断言。
// 退出码即判据：0 = 全过。
import assert from 'node:assert/strict'
import plugin, { apply, Config } from './index.js'

let checks = 0
function ok(cond, label) {
  checks++
  assert.ok(cond, label)
  console.log('  ok  ' + label)
}

/** 假 ctx：手写 on / tools.guard / tools.register / get / logger，config 可在运行中替换。
 *  `configThrows` 复刻 Cordis 代理的行为：未 inject 的属性**抛错**，不是 undefined。 */
function makeCtx(opts = {}) {
  const handlers = new Map()
  const registered = []
  const warnings = []
  const services = opts.services ?? {}
  let guardFn = null
  const ctx = {
    on(event, fn) { handlers.set(event, fn) },
    get(name) { return services[name] },
    logger: { warn: (m) => { warnings.push(String(m)) }, info() {}, error() {} },
    tools: {
      guard(fn) { guardFn = fn },
      register(def) { registered.push(def) },
    },
  }
  if (opts.configThrows) {
    Object.defineProperty(ctx, 'config', {
      get() { throw new Error('cannot get property "config" without inject') },
    })
  } else {
    ctx.config = opts.config
  }
  apply(ctx, opts.applyConfig)
  return {
    ctx,
    registered,
    warnings,
    guard: (exec) => guardFn(exec),
    step: (agent, turn) =>
      handlers.get('agent/pre-step')({ agent, turn, signal: undefined }, async () => ({ kind: 'enter', messages: [] })),
    result: (agent, skillName, isError = false) =>
      handlers.get('tools/result')({ name: 'skill', agent, arguments: { name: skillName } }, { isError }),
    resultVia: (agent, toolName, args = {}) =>
      handlers.get('tools/result')({ name: toolName, agent, arguments: args }, { isError: false }),
    dispose: (agent) => handlers.get('agent/disposed')({ agent }),
    hasGuard: () => typeof guardFn === 'function',
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
const L = { id: 'agent-L' }
const M = { id: 'agent-M' }

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

console.log('# 1. 默认（requiredSkills: []）：加载任意一份前，写类工具被拒')
{
  const h = ctxOf({ config: { requiredSkills: [] } })
  ok(h.hasGuard(), '注册了 tools.guard')
  await h.step(A, 1)
  ok(typeof h.guard({ name: 'write', agent: A, arguments: {} }) === 'string', '1. write 被拒')
  ok(typeof h.guard({ name: 'edit', agent: A, arguments: {} }) === 'string', '1. edit 被拒')
  ok(typeof h.guard({ name: 'plugin_manager', agent: A, arguments: {} }) === 'string', '1. plugin_manager 被拒')
  ok(typeof h.guard({ name: 'bash', agent: A, arguments: { command: 'echo x > /tmp/f' } }) === 'string', '1. 写 bash 被拒')
  h.result(A, 'any-skill')
  ok(h.guard({ name: 'write', agent: A, arguments: {} }) === undefined, '1. 加载任意一份后放行')
}

console.log('# 2. 只读不误伤')
{
  const h = ctxOf({ config: { requiredSkills: [] } })
  await h.step(B, 1)
  ok(h.guard({ name: 'read', agent: B, arguments: {} }) === undefined, '2. read 放行')
  ok(h.guard({ name: 'grep', agent: B, arguments: {} }) === undefined, '2. grep 放行')
  ok(h.guard({ name: 'glob', agent: B, arguments: {} }) === undefined, '2. glob 放行')
  ok(h.guard({ name: 'skill', agent: B, arguments: {} }) === undefined, '2. skill 自身放行')
  ok(
    h.guard({ name: 'bash', agent: B, arguments: { command: 'ls -la /tmp && git status --short' } }) === undefined,
    '2. 只读 bash 放行',
  )
  ok(
    h.guard({ name: 'bash', agent: B, arguments: { command: 'head -5 f 2>&1' } }) === undefined,
    '2. 2>&1 重定向不算写',
  )
  ok(h.guard({ name: 'write', arguments: {} }) === undefined, '2. 无 agent 身份不拦')
}

console.log("# 3. requiredSkills: ['a','b']：逐个加载才放行")
{
  const h = ctxOf({ config: { requiredSkills: ['a', 'b'] }, services: { skills: catalog('a', 'b') } })
  await h.step(C, 1)
  const first = h.guard({ name: 'write', agent: C, arguments: {} })
  ok(typeof first === 'string' && first.includes('a') && first.includes('b'), '3. 一个都没加载时点名 a 与 b')
  ok(first.includes('skill({ name: "a" })') && first.includes('skill({ name: "b" })'), '3. 拒绝文案给出逐个加载的下一步')
  h.result(C, 'a')
  const second = h.guard({ name: 'write', agent: C, arguments: {} })
  ok(typeof second === 'string' && second.includes('b') && !second.includes('"a"'), '3. 只加载 a 后仍拒，且只点名缺的 b')
  h.result(C, 'b')
  ok(h.guard({ name: 'write', agent: C, arguments: {} }) === undefined, '3. a + b 都加载后放行')

  await h.step(D, 1)
  h.result(D, 'b')
  const onlyB = h.guard({ name: 'write', agent: D, arguments: {} })
  ok(typeof onlyB === 'string' && onlyB.includes('"a"'), '3. 只加载 b 不认，仍点名 a')
}

console.log('# 4. 失败的加载不算数')
{
  const h = ctxOf({ config: { requiredSkills: [] } })
  await h.step(E, 1)
  h.result(E, 'any-skill', true)
  ok(typeof h.guard({ name: 'write', agent: E, arguments: {} }) === 'string', '4. isError 的 skill 调用不算判定')
  h.resultVia(E, 'read')
  ok(typeof h.guard({ name: 'write', agent: E, arguments: {} }) === 'string', '4. 别的工具的成功结果不算判定')

  const h2 = ctxOf({ config: { requiredSkills: ['a'] }, services: { skills: catalog('a') } })
  await h2.step(F, 1)
  h2.result(F, 'a', true)
  ok(typeof h2.guard({ name: 'write', agent: F, arguments: {} }) === 'string', '4. 必读名单里的失败加载不算数')
  h2.result(F, 'a')
  ok(h2.guard({ name: 'write', agent: F, arguments: {} }) === undefined, '4. 随后成功加载才放行')
}

console.log('# 5. 换 turn 重置 + agent/disposed 回收')
{
  const h = ctxOf({ config: { requiredSkills: [] } })
  await h.step(G, 1)
  h.result(G, 'x')
  ok(h.guard({ name: 'write', agent: G, arguments: {} }) === undefined, '5. turn 1 加载后放行')
  await h.step(G, 2)
  ok(typeof h.guard({ name: 'write', agent: G, arguments: {} }) === 'string', '5. 新 turn 重新要求判定')
  h.result(G, 'y')
  ok(h.guard({ name: 'write', agent: G, arguments: {} }) === undefined, '5. 新 turn 再加载后放行')
  h.dispose(G)
  await h.step(G, 3)
  ok(typeof h.guard({ name: 'write', agent: G, arguments: {} }) === 'string', '5. disposed 后状态被回收')
}

console.log('# 6. 软化：catalog 里没有的必读名本轮忽略；取不到 catalog 时严格')
{
  const h = ctxOf({ config: { requiredSkills: ['a', 'b'] }, services: { skills: catalog('a') } })
  await h.step(H, 1)
  ok(h.warnings.length === 1 && h.warnings[0].includes('b'), '6. catalog 里没有 b：记一行 warning')
  h.result(H, 'a')
  ok(h.guard({ name: 'write', agent: H, arguments: {} }) === undefined, '6. 只加载 a 就放行（b 被忽略）')

  const strict = ctxOf({ config: { requiredSkills: ['a', 'b'] }, services: {} })
  await strict.step(I, 1)
  strict.result(I, 'a')
  const stillDenied = strict.guard({ name: 'write', agent: I, arguments: {} })
  ok(typeof stillDenied === 'string' && stillDenied.includes('"b"'), '6. skills 服务缺失：保持严格，仍拒')
  strict.result(I, 'b')
  ok(strict.guard({ name: 'write', agent: I, arguments: {} }) === undefined, '6. 服务缺失时两个都加载才放行')

  const throwing = ctxOf({
    config: { requiredSkills: ['a', 'b'] },
    services: { skills: { list: async () => { throw new Error('boom') } } },
  })
  await throwing.step(J, 1)
  throwing.result(J, 'a')
  ok(typeof throwing.guard({ name: 'write', agent: J, arguments: {} }) === 'string', '6. list 抛错：按取不到 catalog 处理，保持严格')

  const nullish = ctxOf({ config: { requiredSkills: ['a', 'b'] }, services: { skills: { list: async () => null } } })
  await nullish.step(K, 1)
  ok(typeof nullish.guard({ name: 'write', agent: K, arguments: {} }) === 'string', '6. list 返回非数组：保持严格')

  const allUnknown = ctxOf({ config: { requiredSkills: ['zzz'] }, services: { skills: catalog('a') } })
  await allUnknown.step(L, 1)
  ok(allUnknown.guard({ name: 'write', agent: L, arguments: {} }) === undefined, '6. 名单里的名字全不在 catalog：本轮不锁死')
}

console.log('# 7. 宿主把 config 读成抛错（Cordis 代理）时，守卫与 pre-step 都不炸')
{
  // 真宿主：`ctx.config` 不是 undefined 而是抛 `cannot get property "config" without inject`，
  // 只有 `apply(ctx, config)` 的那份配置可用。
  const h = ctxOf({
    configThrows: true,
    applyConfig: { requiredSkills: ['a', 'b'] },
    services: { skills: catalog('a', 'b') },
  })
  let stepError = null
  try {
    await h.step(M, 1)
  } catch (e) {
    stepError = e
  }
  ok(stepError === null, '7. agent/pre-step 现读配置不抛错')
  const denied = h.guard({ name: 'plugin_manager', agent: M, arguments: {} })
  ok(typeof denied === 'string', '7. plugin_manager 仍给出判定，而不是被异常带走')
  ok(denied.includes('"a"') && denied.includes('"b"'), '7. 兜底读 apply(ctx, config) 的名单，点名 a 与 b')
  h.result(M, 'a')
  h.result(M, 'b')
  ok(h.guard({ name: 'write', agent: M, arguments: {} }) === undefined, '7. 两名字加载齐全后放行')
}

console.log('# 8. 插件不注册任何工具')
ok(allCtxs.every((h) => h.registered.length === 0), '8. tools.register 零调用')

console.log('# 9. agent/pre-step 决策原样交回')
{
  const h = ctxOf({ config: { requiredSkills: [] } })
  const handlers = h
  const decision = await handlers.step(A, 9)
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  ok(true, '9. waterfall 决策逐字段原样交回')
}

console.log(`\nskill-gate 自检：${checks} 条断言全过（插件不注册任何工具）`)
