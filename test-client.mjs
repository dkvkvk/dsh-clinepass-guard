// Client bundle 测试：mock 宿主（__ModuleLoader__ / React / document / slots），
// 真跑一遍渲染，断言面板内容与交互。
//
// 关键：React mock 必须**真正维护 hook 状态并在渲染后执行 useEffect 队列**，
// 否则 load() 永远不会发起、状态永远是 null，测试会假绿（这条教训来自
// 2026-10-15 写 dsh-filmcraft-progress 时的实测）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

let pass = 0, fail = 0
const failures = []
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok   ' + label) }
  else { fail++; failures.push(label); console.log('  FAIL ' + label) }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected)
  if (a === b) { pass++; console.log('  ok   ' + label) }
  else { fail++; failures.push(label + ' (got ' + a + ', want ' + b + ')'); console.log('  FAIL ' + label + '\n         got  ' + a + '\n         want ' + b) }
}

// ── mock React ────────────────────────────────────────────────────────────
const instances = new Map()
let current = null
let dirty = 0

const React = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    // 真实 React 会把第三参起并进 props.children（单个 child 不包数组）。
    // 不这么做的 mock 会让「用 props.children 传内容的包装组件」整块消失，
    // 而测试却以为面板只是少了几段文字 —— 必须与真实语义一致。
    const merged = Object.assign({}, props || {})
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged, children }
  },
  useState(initial) {
    const inst = current
    const i = inst.index++
    if (!(i in inst.hooks)) inst.hooks[i] = (typeof initial === 'function') ? initial() : initial
    const set = (next) => {
      const value = (typeof next === 'function') ? next(inst.hooks[i]) : next
      if (inst.hooks[i] !== value) { inst.hooks[i] = value; dirty++ }
    }
    return [inst.hooks[i], set]
  },
  useEffect(fn, deps) {
    const inst = current
    const i = inst.index++
    const prev = inst.deps[i]
    const changed = !prev || !deps || deps.length !== prev.length || deps.some((d, k) => d !== prev[k])
    if (changed) { inst.deps[i] = deps; inst.pending.push({ slot: i, fn }) }
  },
  useCallback(fn) { current.index++; return fn },
}

function makeInstance(key) {
  let inst = instances.get(key)
  if (!inst) { inst = { hooks: [], deps: [], index: 0, pending: [], cleanups: [] }; instances.set(key, inst) }
  return inst
}

// 把元素树展开成纯数据树；函数组件用 hook 上下文真调用一遍
function expand(node, keyPath) {
  if (node === null || node === undefined || node === false || node === true) return null
  if (Array.isArray(node)) return node.map((n, i) => expand(n, keyPath + '.' + i)).filter((n) => n !== null)
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
  if (typeof node.type === 'function') {
    const inst = makeInstance(keyPath + ':' + (node.type.name || 'Anon'))
    const prev = current
    current = inst
    inst.index = 0
    inst.pending = []
    let out
    try { out = node.type(node.props) } finally { current = prev }
    // 收集本次 render 期间新登记的 effect（去重后延迟执行）
    inst.lastPending = inst.pending
    return expand(out, keyPath)
  }
  return {
    tag: node.type,
    props: node.props || {},
    children: (node.children || []).map((c, i) => expand(c, keyPath + '.' + i)).filter((c) => c !== null),
  }
}

// 跑一轮：渲染 -> 执行 effect -> 等微任务 -> 若 state 变了再渲染
async function flush(rootEl, rounds) {
  let tree = null
  for (let i = 0; i < (rounds || 8); i++) {
    const before = dirty
    tree = expand(rootEl, 'root')
    for (const inst of instances.values()) {
      for (const p of (inst.lastPending || [])) {
        const r = p.fn()
        if (typeof r === 'function') inst.cleanups.push(r)
      }
      inst.lastPending = []
    }
    await new Promise((r) => setTimeout(r, 10))
    if (dirty === before && i > 0) break
  }
  return tree
}

// ── mock document / window ────────────────────────────────────────────────
const styleTags = []
globalThis.document = {
  createElement(tag) { return { tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, textContent: '', remove() { } } },
  head: { appendChild(el) { styleTags.push(el) } },
}

let loaded = null
globalThis.window = { __ModuleLoader__: { load(options) { loaded = options } } }

// ── mock slots ────────────────────────────────────────────────────────────
const registrations = []
const injectedNames = []
const slots = {
  inject(name, factory) { injectedNames.push(name); return factory() },
  register(spec, component) { registrations.push({ spec, component }); return () => { } },
}

// ── mock host.call ────────────────────────────────────────────────────────
const calls = []
const STATE = {
  ok: true, now: Date.now(),
  gateway: 'https://api.cline.bot/api/v1',
  configFile: 'C:\\Users\\x\\.dsh\\dsh-clinepass-guard.json',
  hook: { installed: true, installedAt: '2026-10-15T09:00:00.000Z', seen: 12, injected: 3, blocked: 0, observed: 12, errors: 0 },
  config: { injection: 'auto', mode: 'warn', pins: { 'cline-pass/deepseek-v4-pro': ['deepseek'] }, observe: true },
  credentialConfigured: true, credentialRef: 'CLINE_API_KEY', credentialError: null,
  modelsSource: 'profile patch',
  models: ['cline-pass/deepseek-v4.1-flash', 'cline-pass/deepseek-v4-pro', 'cline-pass/kimi-k3'],
  modelsNote: null,
  usage: {
    ok: true, keyRef: 'CLINE_API_KEY',
    limits: [
      { type: 'five_hour', percentUsed: 12, remaining: 88, resetsAt: '2026-10-15T12:00:00Z' },
      { type: 'weekly', percentUsed: 47, remaining: 53, resetsAt: '2026-10-18T00:00:00Z' },
      { type: 'monthly', percentUsed: 58, remaining: 42, resetsAt: '2026-11-01T00:00:00Z' },
    ],
  },
  capabilities: [
    { model: 'cline-pass/deepseek-v4.1-flash', pinnable: false, pinHonored: false, providers: [], fallbackCount: 0, canonicalSlug: 'private/deepseek-v4p1-flash-contributor', finalProvider: 'openai-compatible-private', checkedAt: '2026-10-15T09:00:00.000Z' },
    { model: 'cline-pass/deepseek-v4-pro', pinnable: true, pinHonored: true, providers: ['alibaba', 'azure', 'baseten', 'deepinfra', 'deepseek', 'novita'], fallbackCount: 5, canonicalSlug: 'deepseek/deepseek-v4-pro', finalProvider: 'deepseek', checkedAt: '2026-10-15T09:00:00.000Z' },
  ],
  probes: [],
  live: [
    {
      model: 'cline-pass/deepseek-v4.1-flash', requests: 9, ok: 9, errors: 0, streams: 9,
      injected: 0, injectTarget: null, matched: 0, unmatched: 0,
      providers: { 'openai-compatible-private': 9 }, slugs: { 'private/deepseek-v4p1-flash-contributor': 9 },
      lastProvider: 'openai-compatible-private', lastSlug: 'private/deepseek-v4p1-flash-contributor',
      lastFallbacks: [], lastAffinity: { outcome: 'confirmed' }, lastAt: '2026-10-15T09:08:12.315Z',
      latencyLast: 3000, latencySum: 27000, latencyN: 9,
      prompt: 9000, cachedTokens: 8000, vendorHit: 8000, vendorMiss: 1000, cost: 0, costKnown: true,
    },
    {
      model: 'cline-pass/deepseek-v4-pro', requests: 3, ok: 3, errors: 0, streams: 3,
      injected: 3, injectTarget: ['deepseek'], matched: 2, unmatched: 1,
      providers: { deepseek: 2, novita: 1 }, slugs: { 'deepseek/deepseek-v4-pro': 3 },
      lastProvider: 'novita', lastSlug: 'deepseek/deepseek-v4-pro',
      lastFallbacks: ['alibaba'], lastAffinity: { outcome: 'no_pin' }, lastAt: '2026-10-15T09:09:00.000Z',
      latencyLast: 6587, latencySum: 19761, latencyN: 3,
      prompt: 300, cachedTokens: 30, vendorHit: 30, vendorMiss: 270, cost: 0.001234, costKnown: true,
    },
  ],
  baseline: [
    { model: 'cline-pass/deepseek-v4.1-flash', canonicalSlug: 'private/deepseek-v4p1-flash-contributor', finalProvider: 'openai-compatible-private', fallbacks: [], fallbackCount: 0, firstSeenAt: '2026-10-15T08:00:00.000Z', lastSeenAt: '2026-10-15T09:08:12.315Z', samples: 9 },
  ],
  drifts: [
    { at: '2026-10-15T09:08:12.315Z', model: 'cline-pass/deepseek-v4.1-flash', field: 'canonicalSlug', from: 'deepseek/deepseek-v4.1-flash', to: 'private/deepseek-v4p1-flash-contributor' },
  ],
  history: [{ at: '2026-10-15T09:00:00.000Z', action: '挂钩', detail: 'globalThis.fetch 已包裹' }],
}

// bundle 里的 host.call 是**构建时硬编码**的，它真的去 fetch 本地路由
// （/clinepass-guard/api/...），所以必须 mock 全局 fetch —— 顺带验证客户端
// 路由表与 host 侧注册的路径是否一致。
const fetchCalls = []
function jsonResponse(value, status) {
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    async json() { return JSON.parse(JSON.stringify(value)) },
  }
}
globalThis.fetch = async function mockLocalRoute(url, init) {
  const method = (init && init.method) || 'GET'
  let body = null
  try { body = (init && init.body) ? JSON.parse(init.body) : null } catch (_) { }
  fetchCalls.push({ url, method, body })
  calls.push({ name: url, arg: body })
  if (url === '/clinepass-guard/api/state') return jsonResponse(STATE)
  return jsonResponse({ ok: true })
}

// ── 加载 bundle ───────────────────────────────────────────────────────────
const bundlePath = path.join(root, 'dist', 'native', 'client.js')
const code = fs.readFileSync(bundlePath, 'utf8')
// bundle 顶层就是 window.__ModuleLoader__.load(...)，直接求值
new Function('window', 'document', code)(globalThis.window, globalThis.document)
ok(!!loaded, '__ModuleLoader__.load 被调用')
eq(loaded.id, 'dsh-clinepass-guard', 'bundle id')

const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
eq(plugin.name, 'clinepass-guard-client', 'plugin name')

const ctx = { get(name) { return name === 'slots' ? slots : undefined } }
plugin.apply(ctx)

console.log('\n== 槽位注册 ==')
eq(injectedNames, ['settings.section'], '注册到 settings.section')
eq(registrations.length, 1, '注册了一个面板')
eq(registrations[0].spec.id, 'clinepass-guard', '面板 id')
eq(registrations[0].spec.label, '上游守卫', '面板标题')
eq(registrations[0].spec.order, 14, '面板 order')

// ── 渲染 ──────────────────────────────────────────────────────────────────
console.log('\n== 渲染 ==')
const rootEl = registrations[0].component()
let tree = await flush(rootEl)

function texts(node, out) {
  out = out || []
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const n of node) texts(n, out); return out }
  if (node.text !== undefined) { out.push(node.text); return out }
  for (const c of (node.children || [])) texts(c, out)
  return out
}
function allNodes(node, out) {
  out = out || []
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const n of node) allNodes(n, out); return out }
  out.push(node)
  for (const c of (node.children || [])) allNodes(c, out)
  return out
}
function findButton(node, label) {
  return allNodes(node).filter((n) => n.tag === 'button' && texts(n).join('') === label)[0]
}
function findInputs(node) {
  return allNodes(node).filter((n) => n.tag === 'input')
}

ok(tree !== null, '面板渲染成功')
const body = texts(tree).join(' | ')

eq(calls.filter((c) => c.name === '/clinepass-guard/api/state').length >= 1, true, '渲染时按路由拉取了 guard.state')
ok(fetchCalls.every((c) => c.url.indexOf('/clinepass-guard/api/') === 0), '客户端所有请求都打在 /clinepass-guard/api/ 下')
ok(fetchCalls.some((c) => c.url === '/clinepass-guard/api/state' && c.method === 'GET'), 'state 走 GET')

ok(body.indexOf('钉住结果') !== -1, '有「钉住结果」卡片（合并了原来的实时流量 + 可钉性）')
ok(body.indexOf('用量') !== -1, '有「用量」卡片')
ok(body.indexOf('上游漂移') !== -1, '有「上游漂移」卡片')
ok(body.indexOf('钉选目标') !== -1, '有「钉选目标」列')
ok(body.indexOf('守卫配置') !== -1, '有「守卫配置」卡片')

console.log('\n== 数据渲染 ==')
ok(body.indexOf('累计 token') !== -1, '显示累计 token KPI')
ok(body.indexOf('已见 12') !== -1, '工具栏显示钩子计数')
ok(body.indexOf('2/3') !== -1, '显示注入命中 2/3')
ok(body.indexOf('钉住·有漏') !== -1, '配置了钉选但有漏 → 结论标红')
ok(body.indexOf('88%') !== -1 && body.indexOf('53%') !== -1 && body.indexOf('42%') !== -1, '显示三窗口剩余用量')
ok(body.indexOf('deepseek-v4.1-flash') !== -1 && body.indexOf('deepseek-v4-pro') !== -1, '列出模型')
ok(body.indexOf('private/deepseek-v4p1-flash-contributor') !== -1, '显示 v4.1-flash 的管道')
ok(body.indexOf('deepseek/deepseek-v4-pro') !== -1, '显示 v4-pro 的管道')
ok(body.indexOf('钉不住·正常') !== -1, 'v4.1-flash 标为「钉不住·正常」')
ok(body.indexOf('可钉·未钉') !== -1, 'v4-pro 标为「可钉·未钉」')
ok(body.indexOf('deepseek/deepseek-v4.1-flash') !== -1, '漂移行显示旧 slug')
ok(body.indexOf('canonicalSlug') !== -1, '漂移行显示字段名')
ok(body.indexOf('88.9%') !== -1, '算出 v4.1-flash 缓存率 88.9%（8000/9000）')
ok(body.indexOf('openai-compatible-private') !== -1, '显示实际上游')
ok(body.indexOf('挂钩') !== -1, '显示操作历史')
ok(body.indexOf('0.001234') !== -1, '显示累计费用')
ok(styleTags.length >= 1, 'CSS 已插入')

console.log('\n== 上游分布告警 ==')
const multiNode = allNodes(tree).filter((n) => /deepseek×2/.test(texts(n).join('')))
ok(multiNode.length >= 1, 'v4-pro 的多上游分布被标出（deepseek×2 novita×1）')
ok(multiNode.some((n) => String(n.props.className || '').indexOf('cpg-sub-warn') !== -1), '多上游分布用告警色')

console.log('\n== 钉选输入框 ==')
const inputs = findInputs(tree)
ok(inputs.length >= 3, '每个模型一个输入框')
eq(inputs[1].props.value, 'deepseek', 'v4-pro 输入框预填了已保存的 deepseek')
eq(inputs[0].props.value, '', 'v4.1-flash 输入框为空')

console.log('\n== 交互 ==')
calls.length = 0
inputs[0].props.onChange({ target: { value: 'deepseek' } })
tree = await flush(rootEl)
eq(findInputs(tree)[0].props.value, 'deepseek', '输入框受控更新为 deepseek')
const saveBtn = findButton(tree, '保存钉选')
ok(!!saveBtn, '找到「保存钉选」按钮')
saveBtn.props.onClick()
await new Promise((r) => setTimeout(r, 20))
const pinCall = calls.filter((c) => c.name === '/clinepass-guard/api/config')[0]
ok(!!pinCall, '点击后 POST 了 guard.config')
// 客户端提交的是逗号分隔字符串（输入框的原生形态），归一化成数组由 host 侧负责
// —— 那条路径在 test-host.mjs 里已断言。
eq(pinCall && pinCall.arg.pins['cline-pass/deepseek-v4.1-flash'], 'deepseek', '提交的 pins 含刚输入的 deepseek')
eq(pinCall && pinCall.arg.pins['cline-pass/deepseek-v4-pro'], 'deepseek', '提交的 pins 保留了原有配置')

// 清理 effect 里的定时器，否则进程不退出
for (const inst of instances.values()) for (const c of inst.cleanups) { try { c() } catch (_) { } }

console.log('\n────────────────────────────────')
console.log('client: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f) }
process.exit(fail ? 1 : 0)
