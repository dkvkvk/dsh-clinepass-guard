// 端到端验证：把构建好的 host bundle 挂上真实 globalThis.fetch，
// 对 **真实 Cline 网关** 发请求，验证守卫在真实流量下的行为。
//
// 会消耗极少量额度：v4.1-flash 是 contributor 免费模型（cost=0），
// v4-pro 约 $0.0002/次。总计远低于 1 分钱。
//
// 用真实的 DSH_HOME（只读凭据与 patch；只写本插件自己的配置文件）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.DSH_HOME || (process.env.USERPROFILE + '\\.dsh')
const CONFIG_FILE = path.join(HOME, 'dsh-clinepass-guard.json')

let pass = 0, fail = 0
const failures = []
function ok(cond, label) {
  if (cond) { pass++; console.log('  ok   ' + label) }
  else { fail++; failures.push(label); console.log('  FAIL ' + label) }
}
function eq(a, b, label) {
  const x = JSON.stringify(a), y = JSON.stringify(b)
  if (x === y) { pass++; console.log('  ok   ' + label) }
  else { fail++; failures.push(label + ' (got ' + x + ', want ' + y + ')'); console.log('  FAIL ' + label + '\n         got  ' + x + '\n         want ' + y) }
}

console.log('DSH_HOME = ' + HOME)
ok(fs.existsSync(path.join(HOME, '.credentials.yaml')), '凭据库存在')
ok(fs.existsSync(path.join(HOME, 'profiles', 'desktop', 'cordis.patch.yml')), 'profile patch 存在')

// 从干净状态开始（只删本插件自己的配置）
fs.rmSync(CONFIG_FILE, { force: true })

const routes = new Map()
const tools = []
const ctx = {
  effect(fn) { return fn() },
  webServer: { register(opts) { routes.set(opts.path, opts); return () => { } } },
  tools: { register(t) { tools.push(t); return () => { } } },
}

const mod = await import(pathToFileURL(path.join(root, 'dist', 'native', 'index.js')).href)
mod.apply(ctx)

async function callRoute(path_, method, body) {
  const route = routes.get(path_)
  const req = {
    method,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(JSON.stringify(body))
      if (event === 'end') queueMicrotask(cb)
      return req
    },
  }
  let out = null
  await route.handler(req, { writeHead() { }, end(s) { out = JSON.parse(s) } })
  return out
}

// 用守卫包裹后的全局 fetch 发一条真实流式请求，并像 DSH 那样把响应读完
async function realChat(model, extra) {
  const t0 = Date.now()
  const res = await globalThis.fetch('https://api.cline.bot/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + fs.readFileSync(path.join(HOME, '.credentials.yaml'), 'utf8')
        .match(/^\s*CLINE_API_KEY:\s*(\S+)\s*$/m)[1],
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(Object.assign({
      model, messages: [{ role: 'user', content: '只回复 ok' }], max_tokens: 2048, stream: true,
    }, extra || {})),
  })
  let bytes = 0
  if (res.body) {
    const reader = res.body.getReader()
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length }
  }
  await new Promise((r) => setTimeout(r, 150))   // 等旁路观测读完 clone
  return { status: res.status, ms: Date.now() - t0, bytes }
}

console.log('\n== 挂钩 ==')
ok(globalThis.fetch.__dshClinepassGuard === true, 'globalThis.fetch 已包裹')

console.log('\n== 真实探测（打真网关）==')
const probeFlash = await callRoute('/clinepass-guard/api/probe', 'POST', { model: 'cline-pass/deepseek-v4.1-flash' })
console.log('     v4.1-flash: pinHonored=' + probeFlash.result.pinHonored +
  ' slug=' + probeFlash.result.canonicalSlug +
  ' final=' + probeFlash.result.finalProvider +
  ' fallbacks=' + JSON.stringify(probeFlash.result.fallbacks))
if (probeFlash.result.probedViaError) console.log('     假上游回报：' + probeFlash.result.probedViaError.slice(0, 200))
if (probeFlash.result.note) console.log('     提示：' + probeFlash.result.note)
ok(probeFlash.result.ok === true, 'v4.1-flash 探测成功')
eq(probeFlash.result.pinHonored, false, 'v4.1-flash 钉选字段被网关丢弃（pinHonored=false）')
ok(Array.isArray(probeFlash.result.fallbacks) && probeFlash.result.fallbacks.length === 0, 'v4.1-flash fallbacks 为空（单一上游）')

const probePro = await callRoute('/clinepass-guard/api/probe', 'POST', { model: 'cline-pass/deepseek-v4-pro' })
console.log('     v4-pro: pinHonored=' + probePro.result.pinHonored +
  ' slug=' + probePro.result.canonicalSlug +
  ' final=' + probePro.result.finalProvider +
  ' 候选=' + JSON.stringify(probePro.result.availableProviders))
ok(probePro.result.ok === true, 'v4-pro 探测成功')
eq(probePro.result.pinHonored, true, 'v4-pro 钉选字段被采纳（pinHonored=true）')
ok((probePro.result.availableProviders || []).indexOf('deepseek') !== -1, '候选上游里含 deepseek')

console.log('\n== 配置：只给 v4-pro 配钉选，策略 auto ==')
await callRoute('/clinepass-guard/api/config', 'POST', {
  injection: 'auto', mode: 'warn',
  pins: { 'cline-pass/deepseek-v4-pro': 'deepseek', 'cline-pass/deepseek-v4.1-flash': 'deepseek' },
})

console.log('\n== 真实流量：v4.1-flash（auto 应判定不可钉 -> 不注入）==')
const r1 = await realChat('cline-pass/deepseek-v4.1-flash')
console.log('     HTTP ' + r1.status + '  ' + r1.ms + 'ms  ' + r1.bytes + 'B')
ok(r1.status === 200, 'v4.1-flash 真实请求成功')

console.log('\n== 真实流量：v4-pro（auto 应注入 only=["deepseek"]）==')
const r2 = await realChat('cline-pass/deepseek-v4-pro')
console.log('     HTTP ' + r2.status + '  ' + r2.ms + 'ms  ' + r2.bytes + 'B')
ok(r2.status === 200, 'v4-pro 真实请求成功')

console.log('\n== 观测结果 ==')
const st = await callRoute('/clinepass-guard/api/state', 'GET')
console.log('     钩子：' + JSON.stringify(st.hook))
const flash = (st.live || []).find((v) => v.model === 'cline-pass/deepseek-v4.1-flash')
const pro = (st.live || []).find((v) => v.model === 'cline-pass/deepseek-v4-pro')

ok(!!flash, '观测到 v4.1-flash 的真实请求')
eq(flash && flash.injected, 0, 'v4.1-flash 未被注入（auto 判定不可钉）')
eq(flash && flash.lastSlug, 'private/deepseek-v4p1-flash-contributor', 'v4.1-flash 真实管道被读回')
eq(flash && flash.lastProvider, 'openai-compatible-private', 'v4.1-flash 真实上游被读回')
eq(flash && flash.cost, 0, 'v4.1-flash 费用为 0（contributor 免费）')
ok(flash && flash.prompt > 0, 'v4.1-flash 读回 prompt token')

ok(!!pro, '观测到 v4-pro 的真实请求')
eq(pro && pro.injected, 1, 'v4-pro 被注入了一次 only')
eq(pro && pro.injectTarget, ['deepseek'], '注入目标 = deepseek')
eq(pro && pro.matched, 1, '注入目标与真实命中一致 -> 钉选在真实流量里生效')
eq(pro && pro.unmatched, 0, '没有未命中')
eq(pro && pro.lastProvider, 'deepseek', 'v4-pro 真实命中 deepseek')
ok(pro && pro.cost > 0, 'v4-pro 有真实计费（' + (pro && pro.cost) + '）')

console.log('\n== 漂移基线 ==')
ok((st.baseline || []).length >= 2, '两个模型都建立了基线')
const baseFlash = (st.baseline || []).find((b) => b.model === 'cline-pass/deepseek-v4.1-flash')
eq(baseFlash && baseFlash.canonicalSlug, 'private/deepseek-v4p1-flash-contributor', 'v4.1-flash 基线 slug 正确')
eq(baseFlash && baseFlash.fallbackCount, 0, 'v4.1-flash 基线 fallback 数 = 0')

console.log('\n== 配置回读 ==')
// 注意：本进程跑在 DSH 的文件沙箱里（workspace-write），写不进 ~/.dsh，
// 所以这里只验证内存态回读；**落盘**由 test-host.mjs（工作区内的临时 DSH_HOME）
// 断言，并在装好插件、重启 DSH 之后实地核验 ~/.dsh/dsh-clinepass-guard.json。
const st2 = await callRoute('/clinepass-guard/api/state', 'GET')
eq(st2.config.injection, 'auto', '内存态 injection=auto')
eq(st2.config.mode, 'warn', '内存态 mode=warn')
eq(st2.config.pins['cline-pass/deepseek-v4-pro'], ['deepseek'], '内存态 pin 已归一化成数组')
ok(JSON.stringify(st2).indexOf('sk_') === -1, 'state 里不含 API key')

console.log('\n== 工具 ==')
const t = await tools[0].run({ action: 'status' })
ok(t.ok === true, 'clinepass_guard 工具可用')
console.log('     工具视角：' + JSON.stringify(t.live.map((v) => ({ m: v.model, req: v.requests, prov: v.lastProvider, inj: v.injected }))))

console.log('\n────────────────────────────────')
console.log('e2e: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail) { console.log('失败项：'); for (const f of failures) console.log('  - ' + f) }
process.exit(fail ? 1 : 0)
