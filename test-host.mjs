// Host bundle 测试：mock 一个 Cline 网关 + mock DSH ctx，端到端跑守卫逻辑。
//
// 覆盖：挂钩、按策略注入、auto 模式的能力门槛、真实请求观测、漂移检测、
//       strict 预检拦截、非目标 URL 透传、凭据不回传浏览器。
//
// 用独立的 DSH_HOME（.test-home）隔离，绝不碰真实 ~/.dsh。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const HOME = path.join(root, '.test-home')
fs.rmSync(HOME, { recursive: true, force: true })
fs.mkdirSync(path.join(HOME, 'profiles', 'desktop'), { recursive: true })
// 真实 .credentials.yaml 的条目是缩进的（插件正则要求行首有空白）
fs.writeFileSync(path.join(HOME, '.credentials.yaml'), '  CLINE_API_KEY: sk_test_key_do_not_leak\n', 'utf8')
fs.writeFileSync(path.join(HOME, 'profiles', 'desktop', 'cordis.patch.yml'), [
  '      cline:',
  '        models:',
  '          - id: cline-pass/deepseek-v4.1-flash',
  '          - id: cline-pass/deepseek-v4-pro',
  '          - id: cline-pass/kimi-k3',
  '',
].join('\n'), 'utf8')

process.env.DSH_HOME = HOME

// ── 断言 ──────────────────────────────────────────────────────────────────
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

// ── mock 网关 ─────────────────────────────────────────────────────────────
// 每个测试可以改这些旋钮，模拟网关的不同行为。
const gateway = {
  canonicalSlug: 'private/deepseek-v4p1-flash-contributor',
  finalProvider: 'openai-compatible-private',
  fallbacks: [],
  cost: '0',
  promptTokens: 100,
  cachedTokens: 80,
  completionTokens: 10,
  vendorHit: 80,
  vendorMiss: 20,
  probeOnlyRejects: false,     // true = only:['__probe__'] 报错（=可钉）
  probeOtherError: false,      // true = 返回与 only 过滤无关的失败
  seenBodies: [],
  passthrough: [],
  delayMs: 0,
}

function routingPayload() {
  return {
    id: 'chatcmpl-test',
    model: 'vmc/deepseek-v4p1-flash-contributor-fallbacks',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'ok',
        provider_metadata: {
          gateway: {
            cost: gateway.cost,
            gatewayCost: gateway.cost,
            routing: {
              canonicalSlug: gateway.canonicalSlug,
              finalProvider: gateway.finalProvider,
              fallbacksAvailable: gateway.fallbacks,
              affinity: { outcome: 'confirmed', pinnedProvider: gateway.finalProvider },
            },
          },
          deepseek: { promptCacheHitTokens: gateway.vendorHit, promptCacheMissTokens: gateway.vendorMiss },
        },
      },
    }],
    usage: {
      prompt_tokens: gateway.promptTokens,
      completion_tokens: gateway.completionTokens,
      prompt_tokens_details: { cached_tokens: gateway.cachedTokens },
    },
  }
}

function sseFrames() {
  // 真实网关的流式帧是 delta 形状，provider_metadata 嵌在 delta 里 ——
  // 只查顶层的解析器会漏掉流式请求的全部费用，这里刻意复现该形状。
  const first = { id: 'c1', choices: [{ index: 0, delta: { content: 'o' } }] }
  const full = routingPayload()
  const last = Object.assign({}, full, {
    choices: [{ index: 0, delta: full.choices[0].message, finish_reason: 'stop' }],
  })
  return 'data: ' + JSON.stringify(first) + '\n\ndata: ' + JSON.stringify(last) + '\n\ndata: [DONE]\n\n'
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(text) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const realFetch = globalThis.fetch
globalThis.fetch = async function mockGateway(input, init) {
  const url = typeof input === 'string' ? input : input.url
  // 测试全程离线：非目标请求记一笔就返回，不真的打网络
  if (url.indexOf('api.cline.bot') === -1) { gateway.passthrough.push(url); return jsonResponse({ passthrough: true }) }
  if (url.indexOf('/chat/completions') === -1) { gateway.passthrough.push(url); return jsonResponse({ passthrough: true }) }
  if (url.indexOf('usage-limits') !== -1) {
    return jsonResponse({ data: { limits: [{ type: 'five_hour', percentUsed: 12, resetsAt: '2026-10-15T12:00:00Z' }] } })
  }
  let body = null
  try { body = JSON.parse(init && init.body ? init.body : '{}') } catch (_) { }
  gateway.seenBodies.push(body)
  const only = body && body.providerOptions && body.providerOptions.gateway && body.providerOptions.gateway.only
  if (only && only.indexOf('__probe__') !== -1) {
    if (gateway.probeOnlyRejects) {
      return jsonResponse({
        error: "inference request failed: No available providers match the 'only' filter: __probe__. " +
          'Available providers are: alibaba, azure, baseten, deepinfra, deepseek, novita',
      }, 500)
    }
    // 与 only 过滤无关的失败（例如推理模型把 max_tokens 花光导致 content 为空）
    if (gateway.probeOtherError) return jsonResponse({ error: 'empty response content' }, 500)
    return jsonResponse(routingPayload(), 200)
  }
  if (body && body.stream) return sseResponse(sseFrames())
  return jsonResponse(routingPayload(), 200)
}

// ── mock DSH ctx ──────────────────────────────────────────────────────────
const routes = new Map()
const tools = []
const disposers = []
const ctx = {
  effect(fn) { const d = fn(); disposers.push(d); return d },
  webServer: { register(opts) { routes.set(opts.path, opts); return () => { } } },
  tools: {
    // 与真实宿主同构的严格校验。曾经这里只做 tools.push(t)，于是「工具漏声明 output」
    // 这个会让 apply 整体失败的真实错误被测试完全掩盖。
    register(t) {
      if (!t || typeof t !== 'object') throw new TypeError('tool must be an object')
      if (!t.output || typeof t.output !== 'object') {
        throw new TypeError('tool "' + (t && t.name) + '" must declare output { schema, render, presentationMeta? }')
      }
      if (!t.output.schema || typeof t.output.schema !== 'object') {
        throw new TypeError('tool "' + t.name + '" output.schema must be an object')
      }
      if (t.output.schema.type === 'json') {
        throw new TypeError('tool "' + t.name + '" output.schema.type "json" is not a valid JSON-Schema type')
      }
      if (typeof t.output.render !== 'function') {
        throw new TypeError('tool "' + t.name + '" output.render must be a function')
      }
      if (typeof t.execute !== 'function') {
        throw new TypeError('tool "' + t.name + '" must expose execute(args)')
      }
      tools.push(t)
      return () => { }
    },
  },
}

const mod = await import(pathToFileURL(path.join(root, 'dist', 'native', 'index.js')).href)
console.log('\n== 挂钩与注册 ==')
eq(mod.name, 'clinepass-guard-host', 'export name')
ok(Array.isArray(mod.inject) && mod.inject.indexOf('webServer') !== -1, 'inject 含 webServer')
ok(mod.inject.indexOf('tools') !== -1, 'inject 含 tools')

mod.apply(ctx)
ok(globalThis.fetch.__dshClinepassGuard === true, 'globalThis.fetch 已被包裹')
ok(routes.has('/clinepass-guard/api/state'), 'state 路由已注册')
ok(routes.has('/clinepass-guard/api/config'), 'config 路由已注册')
ok(tools.length === 1 && tools[0].name === 'clinepass_guard', '工具已注册')

// ── 调用路由的小工具 ──────────────────────────────────────────────────────
async function callRoute(path_, method, body) {
  const route = routes.get(path_)
  if (!route) throw new Error('no route ' + path_)
  const req = {
    method,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(JSON.stringify(body))
      if (event === 'end') queueMicrotask(cb)
      return req
    },
  }
  let out = null
  const res = {
    writeHead() { },
    end(s) { out = JSON.parse(s) },
  }
  await route.handler(req, res)
  return out
}

async function chat(body, asStream) {
  const payload = Object.assign({ model: 'cline-pass/deepseek-v4.1-flash', messages: [], max_tokens: 2048 }, body)
  if (asStream) payload.stream = true
  const res = await globalThis.fetch('https://api.cline.bot/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  // 像真实调用方那样把原响应读完
  await res.text()
  await new Promise((r) => setTimeout(r, 60))
  return res
}

// ── 1. 未配 pin：不注入 ───────────────────────────────────────────────────
console.log('\n== 1. 未配 pin ==')
gateway.seenBodies.length = 0
await chat({}, false)
eq(gateway.seenBodies[0].providerOptions, undefined, '没有 pin 时不注入 providerOptions')

// ── 2. auto 模式：配了 pin 但未探测 -> 仍不注入 ───────────────────────────
console.log('\n== 2. auto + 未探测 ==')
await callRoute('/clinepass-guard/api/config', 'POST', { pins: { 'cline-pass/deepseek-v4.1-flash': 'deepseek' } })
gateway.seenBodies.length = 0
await chat({}, false)
eq(gateway.seenBodies[0].providerOptions, undefined, 'auto 模式下未探测的模型不注入')

// ── 3. 观测：真实请求的元数据被读回 ───────────────────────────────────────
console.log('\n== 3. 真实请求观测 ==')
await callRoute('/clinepass-guard/api/clear', 'POST', {})   // 从零开始统计
await chat({}, false)
let st = await callRoute('/clinepass-guard/api/state', 'GET')
const liveFlash = (st.live || []).find((v) => v.model === 'cline-pass/deepseek-v4.1-flash')
ok(!!liveFlash, 'live 里有 v4.1-flash')
eq(liveFlash && liveFlash.lastProvider, 'openai-compatible-private', '读回 finalProvider')
eq(liveFlash && liveFlash.lastSlug, 'private/deepseek-v4p1-flash-contributor', '读回 canonicalSlug')
eq(liveFlash && liveFlash.cachedTokens, 80, '累计缓存命中 token')
eq(liveFlash && liveFlash.cost, 0, '累计费用（contributor 免费 = 0）')
// 输出 token 必须累加，否则「一共花了多少 token」算不出来（以前只加了 prompt/cached）
eq(liveFlash && liveFlash.completionTokens, gateway.completionTokens, '累计输出 token')
const tot = st.totals || {}
eq(tot.total, (tot.prompt || 0) + (tot.completion || 0), 'totals.total = 输入 + 输出（不是三者相加）')
ok(typeof tot.since === 'string' && tot.since.length >= 10, 'totals 带统计起点 since')

// ── 4. 探测：不可钉的模型（假上游返回 200）───────────────────────────────
console.log('\n== 4. 探测：钉不动 ==')
gateway.probeOnlyRejects = false
let pr = await callRoute('/clinepass-guard/api/probe', 'POST', { model: 'cline-pass/deepseek-v4.1-flash' })
if (!pr.ok) console.log('        探测返回：' + JSON.stringify(pr))
eq(pr.result && pr.result.pinHonored, false, '假上游返回 200 -> pinHonored=false')
eq(pr.result.fallbacks, [], 'fallbacks 为空')
st = await callRoute('/clinepass-guard/api/state', 'GET')
let cap = (st.capabilities || []).find((c) => c.model === 'cline-pass/deepseek-v4.1-flash')
eq(cap && cap.pinnable, false, '能力表标记 pinnable=false')

console.log('\n== 5. auto 模式：确认不可钉后仍不注入 ==')
gateway.seenBodies.length = 0
await chat({}, false)
eq(gateway.seenBodies[0].providerOptions, undefined, '不可钉的模型 auto 不注入')

// ── 6. 可钉的模型：探测 + 注入生效 ───────────────────────────────────────
console.log('\n== 6. 可钉模型注入 ==')
gateway.probeOnlyRejects = true
pr = await callRoute('/clinepass-guard/api/probe', 'POST', { model: 'cline-pass/deepseek-v4-pro' })
eq(pr.result.pinHonored, true, '假上游报错 -> pinHonored=true')
eq(pr.result.availableProviders, ['alibaba', 'azure', 'baseten', 'deepinfra', 'deepseek', 'novita'], '解析出候选上游清单')
await callRoute('/clinepass-guard/api/config', 'POST', { pins: { 'cline-pass/deepseek-v4-pro': 'deepseek' } })
gateway.seenBodies.length = 0
gateway.canonicalSlug = 'deepseek/deepseek-v4-pro'
gateway.finalProvider = 'deepseek'
gateway.fallbacks = ['alibaba', 'baseten', 'azure', 'novita', 'deepinfra']
gateway.cost = '0.00018744'
await chat({ model: 'cline-pass/deepseek-v4-pro' }, true)
eq(gateway.seenBodies[0].providerOptions, { gateway: { only: ['deepseek'] } }, '可钉模型被注入 only=["deepseek"]')
st = await callRoute('/clinepass-guard/api/state', 'GET')
const livePro = (st.live || []).find((v) => v.model === 'cline-pass/deepseek-v4-pro')
eq(livePro && livePro.injected, 1, '统计到 1 次注入')
eq(livePro && livePro.matched, 1, '注入目标与实际命中一致 -> matched=1')
eq(livePro && livePro.streams, 1, '识别为流式请求')
eq(livePro && livePro.lastProvider, 'deepseek', '流式帧里也读回了 finalProvider')
// 流式帧的 provider_metadata 嵌在 delta 里，费用解析必须递归才拿得到
eq(livePro && livePro.cost, 0.00018744, '流式响应里也读回了真实费用（嵌套在 delta 中）')

// ── 6b. 探测假阳性防护 ────────────────────────────────────────────────────
console.log('\n== 6b. 探测假阳性防护 ==')
// 实测踩到过：假上游探测用 max_tokens=16 时，字段被丢弃 -> 请求真跑起来 ->
// 推理模型把额度花光 -> 网关报 empty response content -> 非 200 被误判成「可钉」。
gateway.probeOnlyRejects = false
gateway.probeOtherError = true
const prOther = await callRoute('/clinepass-guard/api/probe', 'POST', { model: 'cline-pass/kimi-k3' })
eq(prOther.result.pinHonored, null, '与 only 过滤无关的失败 -> pinHonored=null（不误判为可钉）')
ok(String(prOther.result.note || '').indexOf('无法据此判断') !== -1, '给出「结论未知」的说明')
st = await callRoute('/clinepass-guard/api/state', 'GET')
cap = (st.capabilities || []).find((c) => c.model === 'cline-pass/kimi-k3')
eq(cap && cap.pinnable, false, '结论未知时能力表不标记为可钉')
gateway.probeOtherError = false

// ── 7. 漂移检测 ───────────────────────────────────────────────────────────
console.log('\n== 7. 漂移检测 ==')
// 基线此刻是 private/deepseek-v4p1-flash-contributor；把它换成另一个管道，
// 模拟 Cline 侧把模型迁走（2026-10-14→15 真实发生过的那次）。
gateway.canonicalSlug = 'deepseek/deepseek-v4.1-flash'
gateway.finalProvider = 'deepseek'
gateway.fallbacks = ['novita']
await chat({}, false)
st = await callRoute('/clinepass-guard/api/state', 'GET')
// 管道换了 + fallback 数量从 0 变 1，两条漂移都该记下来
const dFlash = (st.drifts || []).filter((d) => d.model === 'cline-pass/deepseek-v4.1-flash')
ok(dFlash.length >= 1, '记录到 v4.1-flash 的漂移事件')
const dSlug = dFlash.filter((d) => d.field === 'canonicalSlug')[0]
ok(!!dSlug, '有 canonicalSlug 漂移')
eq(dSlug && dSlug.to, 'deepseek/deepseek-v4.1-flash', '漂移的 to 是新 slug')
ok(!!dSlug && String(dSlug.from).indexOf('deepseek-v4p1-flash') !== -1, '漂移的 from 是旧 slug')
ok(!!dFlash.filter((d) => d.field === 'fallbacksAvailable')[0], '同时记下 fallback 数量变化')

// ── 8. strict 预检拦截 ────────────────────────────────────────────────────
console.log('\n== 8. strict 拦截 ==')
await callRoute('/clinepass-guard/api/config', 'POST', { mode: 'strict', pins: { 'cline-pass/deepseek-v4.1-flash': 'deepseek' } })
const blocked = await globalThis.fetch('https://api.cline.bot/api/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'cline-pass/deepseek-v4.1-flash', messages: [], max_tokens: 2048 }),
})
eq(blocked.status, 409, '历史命中过允许列表外上游 -> 409')
ok(blocked.headers.get('x-clinepass-guard') === 'blocked', '带拦截标记头')
const blockedBody = await blocked.json()
ok(String(blockedBody.error.message).indexOf('provider_pin_violation') !== -1 || blockedBody.error.type === 'provider_pin_violation', '错误类型是 provider_pin_violation')
await callRoute('/clinepass-guard/api/config', 'POST', { mode: 'warn' })

// ── 9. 非目标 URL 透传 ────────────────────────────────────────────────────
console.log('\n== 9. 透传 ==')
gateway.passthrough.length = 0
const seenBefore = (await callRoute('/clinepass-guard/api/state', 'GET')).hook.seen
const other = await globalThis.fetch('https://example.com/whatever', { method: 'POST', body: '{"model":"x"}' })
eq(other.status, 200, '非 cline 请求被原样交给下层 fetch')
eq(gateway.passthrough, ['https://example.com/whatever'], '下层 fetch 收到了该请求')
const modelsPath = await globalThis.fetch('https://api.cline.bot/api/v1/models', { method: 'GET' })
eq(modelsPath.status, 200, 'cline 的非 chat/completions 路径直接透传')
const seenAfter = (await callRoute('/clinepass-guard/api/state', 'GET')).hook.seen
eq(seenAfter, seenBefore, '透传请求不计入守卫统计')

// ── 10. 凭据不回传 ────────────────────────────────────────────────────────
console.log('\n== 10. 凭据安全 ==')
st = await callRoute('/clinepass-guard/api/state', 'GET')
ok(JSON.stringify(st).indexOf('sk_test_key_do_not_leak') === -1, 'state 里不含 API key')
eq(st.credentialRef, 'CLINE_API_KEY', '只回传引用名')

// ── 11. 工具 ──────────────────────────────────────────────────────────────
console.log('\n== 11. 工具 ==')
// 回归：这个工具曾经漏声明 output，导致 ctx.tools.register() 抛错、apply 被整体判失败，
// 连已经注册的 HTTP 路由都被 Cordis 回收（表现为所有路由 404）。
ok(tools[0].output && typeof tools[0].output === 'object', '工具声明了 output（宿主强制要求）')
ok(tools[0].output.schema && typeof tools[0].output.schema === 'object', 'output.schema 存在')
eq(tools[0].output.schema.type, 'object', 'output.schema.type 为 object（不能是 json）')
eq(typeof tools[0].output.render, 'function', 'output.render 是函数')
const rendered = tools[0].output.render({}, { ok: true })
ok(Array.isArray(rendered) && rendered[0].type === 'text', 'output.render 返回 text 块')
eq(typeof tools[0].execute, 'function', '工具暴露 execute（不是 run）')
const toolStatus = await tools[0].execute({ action: 'status' })
eq(toolStatus.ok, true, '工具 status 可用')
ok(Array.isArray(toolStatus.live), '工具返回 live 数组')
const toolProbe = await tools[0].execute({ action: 'probe', model: 'cline-pass/kimi-k3' })
eq(toolProbe.model, 'cline-pass/kimi-k3', '工具 probe 可用')

// ── 12. 配置落盘 ──────────────────────────────────────────────────────────
console.log('\n== 12. 配置持久化 ==')
const cfgFile = path.join(HOME, 'dsh-clinepass-guard.json')
await new Promise((r) => setTimeout(r, 1200))
ok(fs.existsSync(cfgFile), '配置文件已写出')
const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
eq(saved.config.injection, 'auto', '落盘 injection=auto')
ok(Object.keys(saved.capabilities).length >= 2, '落盘了能力表')
ok(Array.isArray(saved.drifts) && saved.drifts.length >= 1, '落盘了漂移记录')
ok(fs.readFileSync(cfgFile)[0] !== 0xEF, '配置文件无 BOM')

console.log('\n────────────────────────────────')
console.log('host: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f) }
process.exit(fail ? 1 : 0)
