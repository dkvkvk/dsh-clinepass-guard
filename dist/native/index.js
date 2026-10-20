import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname as pathDirname } from 'node:path'

function defineTool(options) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(options.parameters)) {
    const { required: isRequired, ...schema } = value
    properties[key] = schema
    if (isRequired) required.push(key)
  }
  return {
    ...options,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  }
}

function createPlugin(harness) {
  // Cline Pass 上游守卫 — Host 半边。
  //
  // 它做两件事：
  //   ① 守卫（写入侧）—— 在发往 api.cline.bot 的 /chat/completions 请求体上，
  //      按模型注入 providerOptions.gateway.only。**只在实测确认可钉的模型上注入**
  //      （auto 模式），因为对单一上游的模型（如 deepseek-v4.1-flash）该字段会被
  //      网关静默丢弃，注入纯属噪音。
  //   ② 观测（读取侧）—— 用 res.clone() 旁路读回每条真实请求的路由元数据：
  //      canonicalSlug / finalProvider / fallbacksAvailable / affinity / 缓存命中 / 费用。
  //      并据此做**漂移检测**：同一个模型的管道或上游一旦变化，立刻记一条漂移事件。
  //
  // 为什么「漂移检测」才是真正的钉住：网关的钉选字段是未公开行为，Cline 一次更新
  // 就可能悄悄失效且不报错（实测 2026-10-14→10-15 之间 deepseek-v4.1-flash 就从
  // deepseek/deepseek-v4.1-flash 变成了 private/deepseek-v4p1-flash-contributor）。
  // 钉不住的时候，至少要知道它什么时候变的。
  //
  // 设计取舍：观测走 res.clone()（不重建 Response 对象），原始响应对象原样交还调用方，
  // 所以对 DSH 的流式消费零侵入。所有 hook 逻辑都在 try/catch 里，绝不把异常抛给调用方。
  //
  // NOTE: readFileSync/writeFileSync/homedir 等由 scripts/build-native.mjs 顶层注入。
  return {
    name: 'clinepass-guard-host',
    inject: ['tools'],
    apply(ctx) {
      // ── 路径与常量 ──────────────────────────────────────────────────────────
      const HOME = (typeof process !== 'undefined' && process.env && process.env.DSH_HOME)
        ? process.env.DSH_HOME
        : ((typeof process !== 'undefined' && process.env && process.env.USERPROFILE)
          ? process.env.USERPROFILE + '\\.dsh'
          : homedir() + '\\.dsh')
      const CRED_FILE = HOME + '\\.credentials.yaml'
      const PATCH_FILE = HOME + '\\profiles\\desktop\\cordis.patch.yml'
      const CONFIG_FILE = HOME + '\\dsh-clinepass-guard.json'
  
      const GATEWAY = 'https://api.cline.bot/api/v1'
      const GATEWAY_HOST = 'api.cline.bot'
      const CHAT_SUFFIX = '/chat/completions'
      const KEY_REFS = ['CLINE_API_KEY', 'CLINE_PASS_API_KEY']
  
      const PROBE_MAX_TOKENS = 2048
      const PROBE_TIMEOUT_MS = 120000
      const OBSERVE_CAP = 4 * 1024 * 1024
  
      const FALLBACK_MODELS = [
        'cline-pass/deepseek-v4-pro',
        'cline-pass/deepseek-v4.1-flash',
        'cline-pass/kimi-k3',
        'cline-pass/glm-5.3',
        'cline-pass/glm-5.3-flash',
        'cline-pass/qwen3.8-max',
        'cline-pass/qwen3.7-max',
        'cline-pass/qwen3.7-plus',
        'cline-pass/mimo-v2.5',
        'cline-pass/mimo-v2.5-pro',
        'cline-pass/minimax-m3',
      ]
  
      // ── 配置（持久化）────────────────────────────────────────────────────────
      // injection: auto    = 只对「探测确认可钉」且「配了 pin」的模型注入（默认，最保守）
      //            always  = 只要配了 pin 就注入（不管探测结论）
      //            never   = 一律不注入，纯观测
      // mode:      observe = 只记录
      //            warn    = 记录 + 漂移/未命中标警告（默认）
      //            strict  = 发请求前检查：该模型历史上出现过允许列表外的上游就**拒绝发出**
      const DEFAULT_CONFIG = {
        injection: 'auto',
        mode: 'warn',
        pins: {},
        observe: true,
      }
  
      function loadPersisted() {
        const empty = { config: Object.assign({}, DEFAULT_CONFIG), capabilities: {}, baseline: {}, drifts: [] }
        if (!existsSync(CONFIG_FILE)) return empty
        try {
          const j = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
          return {
            config: Object.assign({}, DEFAULT_CONFIG, j.config || {}),
            capabilities: j.capabilities && typeof j.capabilities === 'object' ? j.capabilities : {},
            baseline: j.baseline && typeof j.baseline === 'object' ? j.baseline : {},
            drifts: Array.isArray(j.drifts) ? j.drifts.slice(-60) : [],
          }
        } catch (e) {
          return empty
        }
      }
  
      const persisted = loadPersisted()
      let config = persisted.config
      const capStore = new Map(Object.entries(persisted.capabilities))
      const baseline = new Map(Object.entries(persisted.baseline))
      let drifts = persisted.drifts
  
      let persistTimer = null
      function persist() {
        if (persistTimer) return
        persistTimer = setTimeout(() => {
          persistTimer = null
          try {
            const dir = pathDirname(CONFIG_FILE)
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
            writeFileSync(CONFIG_FILE, JSON.stringify({
              version: 1,
              savedAt: new Date().toISOString(),
              config,
              capabilities: Object.fromEntries(capStore),
              baseline: Object.fromEntries(baseline),
              drifts: drifts.slice(-60),
            }, null, 2), 'utf8')
          } catch (_) { /* 落盘失败不影响运行 */ }
        }, 800)
      }
  
      // ── 运行期存储（不落盘）──────────────────────────────────────────────────
      const probeStore = new Map()
      const live = new Map()
      const history = []
      const hookState = { installed: false, installedAt: null, seen: 0, injected: 0, blocked: 0, observed: 0, errors: 0 }
      // 本地累计统计的起点：清空统计时会重置。面板必须标出这个时间，
      // 否则「累计 token」会被误读成「套餐总用量」——网关并不提供后者。
      let statsSince = new Date().toISOString()
  
      function record(entry) {
        history.push(entry)
        if (history.length > 300) history.splice(0, history.length - 300)
      }
  
      function newLive(model) {
        return {
          model, requests: 0, ok: 0, errors: 0, streams: 0,
          injected: 0, injectTarget: null, matched: 0, unmatched: 0,
          providers: {}, slugs: {},
          lastProvider: null, lastSlug: null, lastFallbacks: null, lastAffinity: null, lastAt: null,
          latencyLast: null, latencySum: 0, latencyN: 0,
          prompt: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, vendorHit: 0, vendorMiss: 0,
          cost: 0, costKnown: false,
        }
      }
  
      // ── 凭据 ────────────────────────────────────────────────────────────────
      function readKey() {
        let text
        try { text = readFileSync(CRED_FILE, 'utf8') } catch (e) {
          return { ok: false, error: '读不到凭据库 ' + CRED_FILE + '：' + (e && e.message) }
        }
        for (const ref of KEY_REFS) {
          const m = text.match(new RegExp('^\\s+' + ref + ':\\s*(\\S+)\\s*$', 'm'))
          if (m && m[1]) return { ok: true, ref, key: m[1] }
        }
        return { ok: false, error: '凭据库里没有 ' + KEY_REFS.join(' / ') }
      }
  
      // ── 从 profile patch 读模型清单 ─────────────────────────────────────────
      const modelCache = { at: 0, value: null }
      function readModels() {
        const now = Date.now()
        if (modelCache.value && now - modelCache.at < 60000) return modelCache.value
        let value
        if (!existsSync(PATCH_FILE)) {
          value = { ok: false, models: FALLBACK_MODELS, error: '读不到 cordis.patch.yml' }
        } else {
          let text = ''
          try { text = readFileSync(PATCH_FILE, 'utf8') } catch (_) { }
          const found = []
          for (const m of text.matchAll(/^\s*-\s*id:\s*(cline-pass\/[A-Za-z0-9._-]+)\s*$/gm)) {
            if (!found.includes(m[1])) found.push(m[1])
          }
          value = found.length
            ? { ok: true, models: found, error: null }
            : { ok: false, models: FALLBACK_MODELS, error: 'patch 里没找到 cline-pass/ 模型，用兜底清单' }
        }
        modelCache.at = now
        modelCache.value = value
        return value
      }
  
      // ── 网关调用 ────────────────────────────────────────────────────────────
      // useHook=false（默认）：走原始 fetch，不经过守卫。探测可钉性必须这样——它自己要在
      //   请求体里塞 only:['__probe__']，被守卫再包一层就测不出真相。
      // useHook=true：走被守卫包裹的 fetch，「缓存实测」用这条，才能真实复现
      //   「钉选会不会被注入、最终落到哪个上游」。曾经这里也走 rawFetch，导致缓存实测
      //   永远测的是网关默认路由，钉谁都一样——那个按钮等于在撒谎。
      async function callGateway(key, body, useHook) {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS)
        const t0 = Date.now()
        const send = useHook ? globalThis.fetch : rawFetch
        try {
          const res = await send(GATEWAY + '/chat/completions', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          })
          const text = await res.text()
          let json = null
          try { json = JSON.parse(text) } catch (_) { }
          return { http: res.status, ms: Date.now() - t0, json, text }
        } catch (e) {
          return { http: null, ms: Date.now() - t0, json: null, text: String((e && e.message) || e) }
        } finally {
          clearTimeout(timer)
        }
      }
  
      // ── 元数据解析 ──────────────────────────────────────────────────────────
      function unwrap(json) {
        if (json === null || typeof json !== 'object') return { inner: null, error: null }
        const inner = json.data && typeof json.data === 'object' ? json.data : json
        let error = null
        if (typeof json.error === 'string') error = json.error
        else if (json.error && typeof json.error === 'object') error = json.error.message || JSON.stringify(json.error)
        else if (typeof inner.error === 'string') error = inner.error
        else if (inner.error && typeof inner.error === 'object') error = inner.error.message || JSON.stringify(inner.error)
        return { inner, error }
      }
  
      // 递归收集每一处 routing（非流式在 message.provider_metadata，流式在帧里）
      function collectRouting(node, out) {
        out = out || []
        if (node === null || typeof node !== 'object') return out
        if (Array.isArray(node)) { for (const item of node) collectRouting(item, out); return out }
        if (node.routing && typeof node.routing === 'object') out.push(node.routing)
        for (const key of Object.keys(node)) collectRouting(node[key], out)
        return out
      }
  
      // provider_metadata 里除 gateway 外的键 = 厂商私有块（deepseek 会带 promptCacheHitTokens）
      function vendorBlocks(node, out) {
        out = out || []
        if (node === null || typeof node !== 'object') return out
        if (Array.isArray(node)) { for (const item of node) vendorBlocks(item, out); return out }
        if (node.provider_metadata && typeof node.provider_metadata === 'object') {
          for (const key of Object.keys(node.provider_metadata)) {
            if (key === 'gateway') continue
            const v = node.provider_metadata[key]
            if (v && typeof v === 'object') out.push({ vendor: key, data: v })
          }
        }
        for (const key of Object.keys(node)) vendorBlocks(node[key], out)
        return out
      }
  
      // 递归找 provider_metadata.gateway。**必须递归**：非流式响应里它在
      // message.provider_metadata.gateway，而流式帧里它嵌在 delta 里 ——
      // 只查顶层会漏掉流式请求的全部费用。
      function collectGateway(node, out) {
        out = out || []
        if (node === null || typeof node !== 'object') return out
        if (Array.isArray(node)) { for (const item of node) collectGateway(item, out); return out }
        const pm = node.provider_metadata
        if (pm && typeof pm === 'object' && pm.gateway && typeof pm.gateway === 'object') out.push(pm.gateway)
        for (const key of Object.keys(node)) collectGateway(node[key], out)
        return out
      }
  
      // 从一组 payload（非流式=1 个完整 JSON；流式=每个 data: 帧）里抽出我们要的全部信息
      function extract(payloads) {
        const routings = []
        const vendors = []
        let usage = null
        let gatewayCost = null
        let modelField = null
        for (const p of payloads) {
          if (!p || typeof p !== 'object') continue
          const inner = p.data && typeof p.data === 'object' ? p.data : p
          if (!modelField && typeof inner.model === 'string') modelField = inner.model
          if (inner.usage && typeof inner.usage === 'object') usage = inner.usage
          collectRouting(inner, routings)
          vendorBlocks(inner, vendors)
          for (const gw of collectGateway(inner, [])) {
            if (gw.cost !== undefined || gw.gatewayCost !== undefined) {
              gatewayCost = { cost: gw.cost, gatewayCost: gw.gatewayCost, inferenceCost: gw.inferenceCost }
            }
          }
        }
        const routing = routings.length ? routings[routings.length - 1] : null
        const vend = vendors.find((v) => v.data && (v.data.promptCacheHitTokens !== undefined || v.data.promptCacheMissTokens !== undefined))
        return {
          routing,
          routingCount: routings.length,
          vendor: vend ? vend.vendor : (vendors.length ? vendors[0].vendor : null),
          vendorCache: vend ? { hit: vend.data.promptCacheHitTokens, miss: vend.data.promptCacheMissTokens } : null,
          usage: usage ? {
            prompt: usage.prompt_tokens || 0,
            cached: ((usage.prompt_tokens_details || {}).cached_tokens) || 0,
            completion: usage.completion_tokens || 0,
            reasoning: ((usage.completion_tokens_details || {}).reasoning_tokens) || 0,
          } : null,
          gatewayCost,
          modelField,
        }
      }
  
      // 把 SSE 文本切成 payload 对象
      function parseSSE(text) {
        const out = []
        for (const line of text.split('\n')) {
          const s = line.trim()
          if (!s.startsWith('data:')) continue
          const payload = s.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try { out.push(JSON.parse(payload)) } catch (_) { }
        }
        return out
      }
  
      // ── 漂移检测 ────────────────────────────────────────────────────────────
      function checkDrift(model, routing) {
        if (!routing) return
        const slug = typeof routing.canonicalSlug === 'string' ? routing.canonicalSlug : null
        const fp = typeof routing.finalProvider === 'string' ? routing.finalProvider : null
        const fb = Array.isArray(routing.fallbacksAvailable) ? routing.fallbacksAvailable : null
        const now = new Date().toISOString()
        const base = baseline.get(model)
        if (!base) {
          baseline.set(model, {
            model, canonicalSlug: slug, finalProvider: fp,
            fallbacks: fb, fallbackCount: fb ? fb.length : null,
            firstSeenAt: now, lastSeenAt: now, samples: 1,
          })
          persist()
          return
        }
        const changes = []
        if (base.canonicalSlug !== slug) changes.push({ field: 'canonicalSlug', from: base.canonicalSlug, to: slug })
        if (base.finalProvider !== fp) changes.push({ field: 'finalProvider', from: base.finalProvider, to: fp })
        if (base.fallbackCount !== null && fb !== null && base.fallbackCount !== fb.length) {
          changes.push({ field: 'fallbacksAvailable', from: base.fallbackCount + ' 个', to: fb.length + ' 个' })
        }
        base.lastSeenAt = now
        base.samples = (base.samples || 0) + 1
        if (changes.length) {
          for (const c of changes) {
            drifts.push({ at: now, model, field: c.field, from: c.from, to: c.to })
            record({ at: now, action: '漂移', model, detail: c.field + '：' + c.from + ' → ' + c.to })
          }
          if (drifts.length > 60) drifts = drifts.slice(-60)
          base.canonicalSlug = slug
          base.finalProvider = fp
          base.fallbacks = fb
          base.fallbackCount = fb ? fb.length : null
          persist()
        }
      }
  
      // ── 观测一条真实请求 ────────────────────────────────────────────────────
      function observe(model, info) {
        const st = live.get(model) || newLive(model)
        live.set(model, st)
        st.requests++
        if (info.http === 200) st.ok++; else st.errors++
        if (info.stream) st.streams++
        if (info.injected) {
          st.injected++
          st.injectTarget = info.injectTarget
        }
        st.latencyLast = info.ms
        st.latencySum += info.ms
        st.latencyN++
  
        const e = info.extracted
        if (e && e.routing) {
          const fp = e.routing.finalProvider || null
          const slug = e.routing.canonicalSlug || null
          st.lastProvider = fp
          st.lastSlug = slug
          st.lastFallbacks = Array.isArray(e.routing.fallbacksAvailable) ? e.routing.fallbacksAvailable : null
          st.lastAffinity = e.routing.affinity || null
          st.lastAt = new Date().toISOString()
          if (fp) st.providers[fp] = (st.providers[fp] || 0) + 1
          if (slug) st.slugs[slug] = (st.slugs[slug] || 0) + 1
          // 注入是否真的被采纳：注入目标 vs 实际命中
          if (info.injected && info.injectTarget && info.injectTarget.length) {
            if (info.injectTarget.includes(fp)) st.matched++
            else st.unmatched++
          }
          checkDrift(model, e.routing)
        }
        if (e && e.usage) {
          st.prompt += e.usage.prompt || 0
          st.cachedTokens += e.usage.cached || 0
          // 输出 token 以前采到了却没累加 —— 没有它就算不出「一共花了多少 token」
          st.completionTokens += e.usage.completion || 0
          st.reasoningTokens += e.usage.reasoning || 0
        }
        if (e && e.vendorCache) {
          if (typeof e.vendorCache.hit === 'number') st.vendorHit = e.vendorCache.hit
          if (typeof e.vendorCache.miss === 'number') st.vendorMiss = e.vendorCache.miss
        }
        if (e && e.gatewayCost) {
          const raw = e.gatewayCost.cost !== undefined ? e.gatewayCost.cost : e.gatewayCost.gatewayCost
          const n = typeof raw === 'number' ? raw : parseFloat(raw)
          if (Number.isFinite(n)) { st.cost += n; st.costKnown = true }
        }
      }
  
      // 流式/非流式统一：旁路读 clone，绝不碰原响应
      function observeResponse(res, meta) {
        if (!config.observe) return
        if (!res || !res.body) return
        let clone = null
        try { clone = res.clone() } catch (_) { return }
        hookState.observed++
        const ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '')
        const isSSE = ct.indexOf('text/event-stream') !== -1
        const done = (text) => {
          let extracted = null
          try {
            extracted = isSSE ? extract(parseSSE(text)) : extract([JSON.parse(text)])
          } catch (_) {
            extracted = null
          }
          const model = (meta && meta.model) || (extracted && extracted.modelField) || null
          if (!model) return
          try {
            observe(model, {
              http: res.status, ms: Date.now() - meta.startedAt, stream: isSSE,
              injected: !!(meta && meta.injected), injectTarget: (meta && meta.injectTarget) || null,
              extracted,
            })
          } catch (_) { }
        }
        // 必须把 clone 读到底，否则 tee 的另一半会被背压卡住；只累积到上限。
        ;(async () => {
          try {
            const reader = clone.body.getReader()
            const decoder = new TextDecoder()
            let acc = ''
            let total = 0
            for (;;) {
              const { done: fin, value } = await reader.read()
              if (fin) break
              total += value.length
              if (acc.length < OBSERVE_CAP) acc += decoder.decode(value, { stream: true })
            }
            if (acc.length < OBSERVE_CAP) acc += decoder.decode()
            done(acc)
          } catch (_) {
            hookState.errors++
          }
        })()
      }
  
      // ── 守卫：请求侧 ────────────────────────────────────────────────────────
      // auto 模式下，只有「探测确认该模型能钉（pinHonored === true）」才注入。
      // 对 deepseek-v4.1-flash 这类单一上游模型，注入是纯噪音 —— 网关会静默丢弃。
      function pinFor(model) {
        if (!model || config.injection === 'never') return null
        const target = config.pins[model]
        if (!Array.isArray(target) || target.length === 0) return null
        if (config.injection === 'always') return target
        const cap = capStore.get(model)
        return cap && cap.pinnable === true ? target : null
      }
  
      // strict 模式：发请求前，若该模型历史上出现过允许列表外的上游，直接拒绝发出。
      // 用「历史统计」而不是「事后丢弃响应」，所以完全不碰流式。
      function preflight(model) {
        if (config.mode !== 'strict') return null
        const allow = config.pins[model]
        if (!Array.isArray(allow) || allow.length === 0) return null
        const st = live.get(model)
        if (!st) return null
        const seen = Object.keys(st.providers)
        const bad = seen.filter((p) => allow.indexOf(p) === -1)
        if (bad.length === 0) return null
        return { allowed: allow, seen, bad }
      }
  
      function requestUrl(input) {
        if (typeof input === 'string') return input
        if (input && typeof input.url === 'string') return input.url
        if (typeof URL !== 'undefined' && input instanceof URL) return String(input)
        return null
      }
  
      function buildGuardFetch() {
        return async function guardFetch(input, init) {
          let url = null
          try { url = requestUrl(input) } catch (_) { }
          if (!url || url.indexOf(GATEWAY_HOST) === -1 || url.indexOf(CHAT_SUFFIX) === -1) {
            return rawFetch(input, init)
          }
          hookState.seen++
          const startedAt = Date.now()
  
          // 只处理「字符串 body」这一最常见形态；其余形态原样透传（仍会观测）
          let model = null
          let bodyText = null
          if (init && typeof init.body === 'string') bodyText = init.body
          if (bodyText) {
            try {
              const parsed = JSON.parse(bodyText)
              model = typeof parsed.model === 'string' ? parsed.model : null
            } catch (_) { }
          }
  
          // strict 预检
          if (model) {
            const block = preflight(model)
            if (block) {
              hookState.blocked++
              record({
                at: new Date().toISOString(), action: '拦截', model,
                detail: '允许 ' + block.allowed.join(',') + '，但历史命中过 ' + block.bad.join(','),
              })
              const payload = JSON.stringify({
                error: {
                  message: 'clinepass-guard 已拦截：' + model + ' 的历史命中上游 ' + block.bad.join(',') +
                    ' 不在允许列表 [' + block.allowed.join(',') + '] 内。' +
                    '（运行模式 strict；改成 warn 可只告警不拦截）',
                  type: 'provider_pin_violation',
                },
              })
              return new Response(payload, {
                status: 409,
                statusText: 'Cline Pass Guard Blocked',
                headers: { 'content-type': 'application/json; charset=utf-8', 'x-clinepass-guard': 'blocked' },
              })
            }
          }
  
          // 注入 only
          let patchedInit = init
          let injected = false
          let injectTarget = null
          if (model && bodyText) {
            const target = pinFor(model)
            if (target) {
              try {
                const parsed = JSON.parse(bodyText)
                parsed.providerOptions = Object.assign({}, parsed.providerOptions)
                parsed.providerOptions.gateway = Object.assign({}, parsed.providerOptions.gateway, { only: target.slice() })
                patchedInit = Object.assign({}, init, { body: JSON.stringify(parsed) })
                injected = true
                injectTarget = target
                hookState.injected++
              } catch (_) { patchedInit = init }
            }
          }
  
          const res = await rawFetch(input, patchedInit)
          try {
            observeResponse(res, { model, startedAt, injected, injectTarget })
          } catch (_) { hookState.errors++ }
          return res
        }
      }
  
      // ── 挂钩 / 摘钩 ─────────────────────────────────────────────────────────
      const rawFetch = globalThis.fetch.bind(globalThis)
      function installHook() {
        if (hookState.installed) return
        const existing = globalThis.fetch
        if (existing && existing.__dshClinepassGuard) {
          hookState.installed = true
          hookState.installedAt = hookState.installedAt || new Date().toISOString()
          return
        }
        const guard = buildGuardFetch()
        guard.__dshClinepassGuard = true
        globalThis.fetch = guard
        hookState.installed = true
        hookState.installedAt = new Date().toISOString()
        record({ at: hookState.installedAt, action: '挂钩', detail: 'globalThis.fetch 已包裹' })
      }
      function uninstallHook() {
        if (!hookState.installed) return
        try {
          if (globalThis.fetch && globalThis.fetch.__dshClinepassGuard) globalThis.fetch = rawFetch
        } catch (_) { }
        hookState.installed = false
      }
  
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => {
          installHook()
          return () => uninstallHook()
        }, 'dsh-clinepass-guard: fetch hook')
      } else {
        installHook()
      }
  
      // ── 探测：单模型 ────────────────────────────────────────────────────────
      async function probeModel(key, model, opts) {
        const withProbe = !(opts && opts.skipProbe)
        const out = {
          model, ok: false, probedAt: new Date().toISOString(),
          request: null, availableProviders: [], probedViaError: null,
          pinHonored: null, note: null, error: null,
        }
  
        const a = await callGateway(key, {
          model,
          messages: [{ role: 'user', content: '只回复两个字：可以' }],
          max_tokens: PROBE_MAX_TOKENS,
          stream: false,
        })
        out.request = { http: a.http, ms: a.ms }
        if (a.http !== 200) {
          const { error } = unwrap(a.json)
          out.error = error || ('HTTP ' + a.http + '：' + String(a.text).slice(0, 300))
          return out
        }
        const { inner, error } = unwrap(a.json)
        if (error) { out.error = error; return out }
  
        const e = extract([inner])
        out.ok = true
        out.canonicalSlug = e.routing ? e.routing.canonicalSlug : (inner.model || null)
        out.finalProvider = e.routing ? e.routing.finalProvider : null
        out.resolvedProvider = e.routing && typeof e.routing.resolvedProvider === 'string' ? e.routing.resolvedProvider : null
        out.affinity = e.routing ? e.routing.affinity : null
        out.fallbacks = e.routing && Array.isArray(e.routing.fallbacksAvailable) ? e.routing.fallbacksAvailable : []
        out.routingCount = e.routingCount
        out.modelField = e.modelField
        out.usage = e.usage
        out.vendor = e.vendor
        out.vendorCache = e.vendorCache
        out.gatewayCost = e.gatewayCost
        out.content = String((((inner.choices || [])[0] || {}).message || {}).content || '').slice(0, 40)
  
        if (!out.content && e.usage && e.usage.reasoning > 0) {
          out.note = 'content 为空但用了 ' + e.usage.reasoning + ' 个 reasoning token —— 提高 max_tokens 即可，不是故障'
        }
  
        if (withProbe) {
          // 关键：max_tokens 必须给足。给 16 时，若钉选字段被丢弃、请求真的跑起来，
          // 推理模型会把这点额度全花在 reasoning 上，网关报 `empty response content`，
          // 于是「非 200」被误判成「字段被采纳 = 可钉」。这是实测踩到的假阳性。
          const b = await callGateway(key, {
            model,
            messages: [{ role: 'user', content: '只回复两个字：可以' }],
            max_tokens: PROBE_MAX_TOKENS,
            stream: false,
            providerOptions: { gateway: { only: ['__probe__'] } },
          })
          if (b.http === 200) {
            out.pinHonored = false
            if (!out.note) out.note = '钉选字段被网关静默丢弃（假上游也返回 200）—— 该模型无法钉住上游'
          } else {
            const { error: e2 } = unwrap(b.json)
            const errText = e2 ? String(e2) : ('HTTP ' + b.http + '：' + String(b.text).slice(0, 200))
            out.probedViaError = errText.slice(0, 400)
            // 报错文本可能是整段字符串的结尾（后面没有引号也没有换行），
            // 所以用「非引号非换行」的字符类收尾，不能用 `(.+?)["\n]`。
            const m = errText.match(/Available providers are:\s*([^"\n]+)/i)
            if (m) out.availableProviders = m[1].split(',').map((s) => s.trim()).filter(Boolean)
            // 只有确实是「only 过滤」错误才能断定字段被采纳；其它非 200
            // （超时、限流、额度、内容为空……）一律记 null = 结论未知，不能当可钉。
            const isOnlyFilter = /No available providers match the '?only'? filter/i.test(errText) || !!m
            if (isOnlyFilter) {
              out.pinHonored = true
            } else {
              out.pinHonored = null
              if (!out.note) out.note = '探测请求返回非 200，但不是「only 过滤」错误，无法据此判断可钉性'
            }
          }
        }
  
        // 把「能不能钉」沉淀成能力表，供 auto 注入模式判定
        capStore.set(model, {
          model,
          pinnable: out.pinHonored === true,
          pinHonored: out.pinHonored,
          providers: out.availableProviders || [],
          fallbackCount: out.fallbacks ? out.fallbacks.length : null,
          canonicalSlug: out.canonicalSlug || null,
          finalProvider: out.finalProvider || null,
          checkedAt: out.probedAt,
        })
        persist()
        return out
      }
  
      // ── 缓存实测 ────────────────────────────────────────────────────────────
      async function cacheTest(key, model, rounds) {
        const n = Math.max(2, Math.min(4, Number(rounds) || 2))
        const filler = []
        for (let i = 0; i < 1200; i++) {
          filler.push('第' + String(i).padStart(4, '0') + '条：这是用于测试提示缓存命中率的固定填充文本，仅作占位之用，不含语义信息。')
        }
        const messages = [
          { role: 'system', content: '以下是固定背景资料，请阅读后只回复 ok。\n' + filler.join('\n') },
          { role: 'user', content: '只回复 ok' },
        ]
        const runs = []
        for (let i = 0; i < n; i++) {
          const r = await callGateway(key, { model, messages, max_tokens: 64, stream: false }, true)
          if (r.http !== 200) {
            const { error } = unwrap(r.json)
            runs.push({ round: i + 1, ok: false, http: r.http, ms: r.ms, error: error || ('HTTP ' + r.http) })
            continue
          }
          const { inner } = unwrap(r.json)
          const e = extract([inner])
          const prompt = e.usage ? e.usage.prompt : 0
          const cached = e.usage ? e.usage.cached : 0
          runs.push({
            round: i + 1, ok: true, ms: r.ms,
            finalProvider: e.routing ? e.routing.finalProvider : null,
            prompt, cached,
            hitRate: prompt > 0 ? Math.round((cached / prompt) * 1000) / 10 : 0,
            cost: e.gatewayCost ? e.gatewayCost.cost : null,
            vendorHit: e.vendorCache ? e.vendorCache.hit : null,
            vendorMiss: e.vendorCache ? e.vendorCache.miss : null,
          })
        }
        return { model, rounds: n, runs }
      }
  
      // ── 套餐用量 ────────────────────────────────────────────────────────────
      const usageCache = { at: 0, value: null }
      async function usage(force) {
        const now = Date.now()
        if (!force && usageCache.value && now - usageCache.at < 60000) return usageCache.value
        const cred = readKey()
        if (!cred.ok) return { ok: false, error: cred.error }
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 30000)
        try {
          const res = await rawFetch(GATEWAY + '/users/me/plan/usage-limits', {
            method: 'GET',
            headers: { Authorization: 'Bearer ' + cred.key, Accept: 'application/json' },
            signal: ctrl.signal,
          })
          const text = await res.text()
          if (res.status !== 200) return { ok: false, error: 'HTTP ' + res.status + '：' + text.slice(0, 200) }
          let json = null
          try { json = JSON.parse(text) } catch (_) { }
          const { inner } = unwrap(json)
          const limits = (inner && Array.isArray(inner.limits)) ? inner.limits : []
          const value = {
            ok: true, keyRef: cred.ref,
            limits: limits.map((L) => ({
              type: L.type,
              percentUsed: L.percentUsed,
              remaining: (typeof L.percentUsed === 'number')
                ? Math.max(0, Math.min(100, Math.round((100 - L.percentUsed) * 10) / 10))
                : null,
              resetsAt: L.resetsAt || null,
            })),
          }
          usageCache.at = now
          usageCache.value = value
          return value
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        } finally {
          clearTimeout(timer)
        }
      }
  
      // ── 面板状态 ────────────────────────────────────────────────────────────
      // 全模型合计：回答「这段时间一共花了多少 token / 多少钱」。
      // 注意口径：prompt 与 completion 相加才是总量，cached 是 prompt 的子集，不能重复加。
      function totals() {
        const out = {
          since: statsSince, models: 0, requests: 0,
          prompt: 0, cached: 0, completion: 0, reasoning: 0, total: 0,
          cost: 0, costKnown: false,
        }
        for (const v of live.values()) {
          if (!v.requests) continue
          out.models++
          out.requests += v.requests
          out.prompt += v.prompt || 0
          out.cached += v.cachedTokens || 0
          out.completion += v.completionTokens || 0
          out.reasoning += v.reasoningTokens || 0
          out.cost += v.cost || 0
          if (v.costKnown) out.costKnown = true
        }
        out.total = out.prompt + out.completion
        return out
      }
  
      async function state() {
        const cred = readKey()
        const modelsInfo = readModels()
        const us = await usage(false)
        return {
          ok: true,
          now: Date.now(),
          gateway: GATEWAY,
          configFile: CONFIG_FILE,
          hook: Object.assign({}, hookState),
          config,
          credentialConfigured: cred.ok,
          credentialRef: cred.ok ? cred.ref : null,
          credentialError: cred.ok ? null : cred.error,
          modelsSource: modelsInfo.ok ? 'profile patch' : '兜底清单',
          models: modelsInfo.models,
          modelsNote: modelsInfo.error,
          usage: us,
          totals: totals(),
          capabilities: Array.from(capStore.values()),
          probes: Array.from(probeStore.values()),
          live: Array.from(live.values()),
          baseline: Array.from(baseline.values()),
          drifts: drifts.slice(-40).reverse(),
          history: history.slice(-40).reverse(),
        }
      }
  
      // ── 路由 ────────────────────────────────────────────────────────────────
      harness.handle('guard.state', () => state())
  
      harness.handle('guard.config', (body) => {
        const next = Object.assign({}, config)
        if (body && typeof body.injection === 'string' && ['auto', 'always', 'never'].indexOf(body.injection) !== -1) {
          next.injection = body.injection
        }
        if (body && typeof body.mode === 'string' && ['observe', 'warn', 'strict'].indexOf(body.mode) !== -1) {
          next.mode = body.mode
        }
        if (body && typeof body.observe === 'boolean') next.observe = body.observe
        if (body && body.pins && typeof body.pins === 'object' && !Array.isArray(body.pins)) {
          const pins = {}
          for (const [model, value] of Object.entries(body.pins)) {
            let list = []
            if (Array.isArray(value)) list = value.map((v) => String(v).trim()).filter(Boolean)
            else if (typeof value === 'string') list = value.split(',').map((v) => v.trim()).filter(Boolean)
            if (list.length) pins[model] = list
          }
          next.pins = pins
        }
        config = next
        persist()
        record({ at: new Date().toISOString(), action: '配置', detail: 'injection=' + next.injection + ' mode=' + next.mode })
        return { ok: true, config }
      })
  
      harness.handle('guard.probe', async (body) => {
        const model = body && body.model
        if (!model) return { ok: false, error: '缺少 model' }
        const cred = readKey()
        if (!cred.ok) return { ok: false, error: cred.error }
        const r = await probeModel(cred.key, model, { skipProbe: !!(body && body.skipProbe) })
        probeStore.set(model, r)
        record({ at: new Date().toISOString(), action: '探测', model })
        return { ok: true, result: r }
      })
  
      harness.handle('guard.probeAll', async () => {
        const cred = readKey()
        const modelsInfo = readModels()
        const results = []
        for (const model of modelsInfo.models) {
          if (!cred.ok) { results.push({ model, ok: false, error: cred.error }); continue }
          results.push(await probeModel(cred.key, model))
        }
        for (const r of results) probeStore.set(r.model, r)
        record({ at: new Date().toISOString(), action: '探测全部', detail: results.length + ' 个模型' })
        return { ok: true, results }
      })
  
      harness.handle('guard.cache', async (body) => {
        const model = body && body.model
        if (!model) return { ok: false, error: '缺少 model' }
        const cred = readKey()
        if (!cred.ok) return { ok: false, error: cred.error }
        const r = await cacheTest(cred.key, model, body && body.rounds)
        record({ at: new Date().toISOString(), action: '缓存实测', model })
        return { ok: true, result: r }
      })
  
      harness.handle('guard.baseline', (body) => {
        const model = body && body.model
        if (model) baseline.delete(model)
        else baseline.clear()
        if (!body || body.keepDrifts !== true) drifts = []
        persist()
        record({ at: new Date().toISOString(), action: '重置基线', model: model || '全部' })
        return { ok: true }
      })
  
      harness.handle('guard.clear', () => {
        probeStore.clear()
        live.clear()
        history.splice(0, history.length)
        statsSince = new Date().toISOString()
        return { ok: true }
      })
  
      // ── 工具 ────────────────────────────────────────────────────────────────
      const tool = harness.defineTool({
        name: 'clinepass_guard',
        description:
          '查询 Cline Pass 上游守卫的实时状态：每个模型的管道（canonicalSlug）、实际命中上游、' +
          '注入的钉选目标、缓存命中率、累计费用、上游漂移事件与套餐用量。' +
          'action=probe 时对指定模型做一次可钉性探测（会消耗极少量额度）。',
        parameters: {
          action: { type: 'string', required: true, description: "status（读状态）| probe（探测一个模型）" },
          model: { type: 'string', required: false, description: 'action=probe 时的模型 id，例如 cline-pass/deepseek-v4-pro' },
        },
        // 工具契约要求 output 必须声明，否则 ctx.tools.register() 抛错，
        // 整个插件的 apply 会被判失败，连已经注册好的 HTTP 路由都会被 Cordis 一并回收。
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        },
        async execute(args) {
          if (args && args.action === 'probe') {
            if (!args.model) return { ok: false, error: '缺少 model' }
            const cred = readKey()
            if (!cred.ok) return { ok: false, error: cred.error }
            const r = await probeModel(cred.key, args.model)
            probeStore.set(args.model, r)
            return r
          }
          const s = await state()
          return {
            ok: true,
            hook: s.hook,
            config: s.config,
            usage: s.usage,
            live: s.live.map((v) => ({
              model: v.model, requests: v.requests, errors: v.errors,
              lastProvider: v.lastProvider, lastSlug: v.lastSlug,
              providers: v.providers, injected: v.injected, matched: v.matched, unmatched: v.unmatched,
              cacheHitRate: v.prompt > 0 ? Math.round((v.cachedTokens / v.prompt) * 1000) / 10 : null,
              cost: v.costKnown ? v.cost : null,
            })),
            baseline: s.baseline,
            drifts: s.drifts.slice(0, 10),
          }
        },
      })
      harness.registerTool(ctx, tool)
    },
  }
}

const plugin = createPlugin({})
export const name = plugin.name
export const inject = [...new Set([...plugin.inject, 'webServer'])]

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1e6) { reject(new Error('request body too large')); req.destroy() }
    })
    req.on('end', () => {
      if (!raw) return resolve(null)
      try { resolve(JSON.parse(raw)) } catch (_) { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

function registerRoute(ctx, route, handler, label) {
  return ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: route.path,
    async handler(req, res) {
      const send = (code, value) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(value))
      }
      if (req.method !== route.method) return send(405, { error: 'method not allowed' })
      try {
        const body = req.method === 'POST' ? await readBody(req) : null
        send(200, await handler(body))
      } catch (error) {
        send(500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), label)
}

export function apply(ctx) {
  const routes = {
      'guard.state': { method: 'GET', path: '/clinepass-guard/api/state' },
      'guard.config': { method: 'POST', path: '/clinepass-guard/api/config' },
      'guard.probe': { method: 'POST', path: '/clinepass-guard/api/probe' },
      'guard.probeAll': { method: 'POST', path: '/clinepass-guard/api/probe-all' },
      'guard.cache': { method: 'POST', path: '/clinepass-guard/api/cache' },
      'guard.baseline': { method: 'POST', path: '/clinepass-guard/api/baseline' },
      'guard.clear': { method: 'POST', path: '/clinepass-guard/api/clear' },
    }
  const harness = {
    defineTool,
    registerTool(_context, tool) {
      return ctx.effect(() => ctx.tools.register(tool), 'dsh-clinepass-guard: tool ' + tool.name)
    },
    handle(key, handler) {
      const route = routes[key]
      if (route === undefined) throw new Error('unsupported handler: ' + key)
      return registerRoute(ctx, route, (body) => handler(body || {}), 'dsh-clinepass-guard: ' + key)
    },
  }
  return createPlugin(harness).apply(ctx)
}
