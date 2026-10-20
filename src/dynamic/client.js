// Cline Pass 上游守卫 — Client 半边。
//
// React / styles / host 由 scripts/build-native.mjs 注入。
// 面板挂在「设置 → 上游守卫」。所有数据都经 host.call 走本地路由，凭据永不进浏览器。
//
// 设计取向：先用一句话告诉你「现在有没有事」，再按重要性给证据，低频操作收进折叠区。
return {
  name: 'clinepass-guard-client',
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback

    const TAB_TITLE = '上游守卫'

    const CSS = [
      // ── 骨架 ──
      '.cpg-wrap{display:flex;flex-direction:column;gap:12px;padding:2px 2px 28px;font-size:13px;line-height:1.5}',
      '.cpg-dim{color:var(--dsw-alias-label-secondary,#8b8b8b)}',
      '.cpg-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;font-variant-numeric:tabular-nums}',
      '.cpg-err{color:#f85149;font-size:12px;padding:8px 12px;border-radius:8px;background:rgba(248,81,73,.1);border:1px solid rgba(248,81,73,.35)}',

      // ── 结论条 ──
      '.cpg-hero{display:flex;gap:11px;align-items:flex-start;padding:13px 15px;border-radius:12px;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.28))}',
      '.cpg-hero-dot{width:9px;height:9px;border-radius:50%;margin-top:6px;flex:0 0 auto;box-shadow:0 0 0 4px rgba(128,128,128,.12)}',
      '.cpg-hero-b{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.cpg-hero-t{font-size:13.5px;font-weight:650;line-height:1.35}',
      '.cpg-hero-d{font-size:12px;color:var(--dsw-alias-label-secondary,#8b8b8b)}',
      '.cpg-k-ok{background:rgba(46,160,67,.07);border-color:rgba(46,160,67,.35)}',
      '.cpg-k-warn{background:rgba(210,153,34,.08);border-color:rgba(210,153,34,.4)}',
      '.cpg-k-bad{background:rgba(248,81,73,.08);border-color:rgba(248,81,73,.4)}',
      '.cpg-k-idle{background:rgba(88,166,255,.06);border-color:rgba(88,166,255,.32)}',
      '.cpg-d-ok{background:#3fb950}.cpg-d-warn{background:#d29922}.cpg-d-bad{background:#f85149}.cpg-d-idle{background:#58a6ff}',

      // ── KPI ──
      '.cpg-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:9px}',
      '.cpg-kpi{padding:9px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-tertiary,rgba(128,128,128,.2));background:var(--dsw-alias-bg-secondary,rgba(128,128,128,.04))}',
      '.cpg-kpi-l{font-size:11px;color:var(--dsw-alias-label-secondary,#8b8b8b)}',
      '.cpg-kpi-v{font-size:18px;font-weight:650;line-height:1.3;font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
      '.cpg-kpi-s{font-size:10.5px;color:var(--dsw-alias-label-secondary,#8b8b8b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',

      // ── 工具栏 ──
      '.cpg-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.cpg-sp{flex:1 1 auto}',
      '.cpg-btn{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary,inherit);border-radius:8px;padding:5px 11px;font-size:12px;cursor:pointer;line-height:1.35;transition:background .12s,border-color .12s}',
      '.cpg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}',
      '.cpg-btn:active:not(:disabled){transform:translateY(.5px)}',
      '.cpg-btn:disabled{opacity:.45;cursor:default}',
      '.cpg-btn-x{padding:2px 7px;font-size:11px}',
      '.cpg-btn-c{border-color:rgba(88,166,255,.45);color:#58a6ff}',
      '.cpg-btn-c:hover:not(:disabled){background:rgba(88,166,255,.12)}',

      // ── 版块 ──
      '.cpg-sec{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.26));border-radius:12px;overflow:hidden}',
      '.cpg-sec-h{display:flex;align-items:center;gap:8px;padding:9px 13px;background:rgba(128,128,128,.045);border-bottom:1px solid var(--dsw-alias-border-tertiary,rgba(128,128,128,.18))}',
      '.cpg-sec-t{font-size:12.5px;font-weight:650;letter-spacing:.01em}',
      '.cpg-sec-m{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#8b8b8b)}',
      '.cpg-sec-b{padding:11px 13px}',
      '.cpg-sec-b-flush{padding:0}',
      '.cpg-note{font-size:11.5px;color:var(--dsw-alias-label-secondary,#8b8b8b);line-height:1.6}',
      '.cpg-note-b{margin-top:9px}',

      // ── 表格 ──
      '.cpg-tbl{width:100%;border-collapse:collapse;font-size:12px}',
      '.cpg-tbl th,.cpg-tbl td{text-align:left;padding:6px 7px;vertical-align:middle}',
      '.cpg-tbl thead th{font-weight:600;font-size:11px;color:var(--dsw-alias-label-secondary,#8b8b8b);white-space:nowrap;border-bottom:1px solid var(--dsw-alias-border-tertiary,rgba(128,128,128,.2));background:rgba(128,128,128,.02)}',
      '.cpg-tbl tbody tr+tr td{border-top:1px solid var(--dsw-alias-border-tertiary,rgba(128,128,128,.13))}',
      '.cpg-tbl tbody tr:hover td{background:rgba(128,128,128,.035)}',
      '.cpg-tbl-kv th{width:132px;font-weight:500;color:var(--dsw-alias-label-secondary,#8b8b8b);font-size:11.5px}',
      '.cpg-sub{font-size:10.5px;color:var(--dsw-alias-label-secondary,#8b8b8b);margin-top:1px}',
      '.cpg-sub-warn{color:#d29922}',
      // 结论列的说明：单行省略，否则一个长注释把整行撑到 4 行高（实测过）
      '.cpg-vdnote{max-width:108px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10px;color:var(--dsw-alias-label-secondary,#8b8b8b);margin-top:1px}',
      '.cpg-act{white-space:nowrap;text-align:right}',
      '.cpg-act .cpg-btn{padding-left:5px;padding-right:5px}',
      // 表格防溢出：窄面板里宁可省略号，也不要横向裁切或把行撑成三行
      '.cpg-tscroll{overflow-x:auto}',
      '.cpg-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:138px}',
      '.cpg-slug{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:138px;font-size:10.5px;color:var(--dsw-alias-label-secondary,#8b8b8b)}',
      '.cpg-cand{max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cpg-slugcell{max-width:152px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.cpg-num{white-space:nowrap}',

      // ── 徽标 ──
      '.cpg-pill{display:inline-block;padding:0 6px;border-radius:999px;font-size:10.5px;line-height:1.65;white-space:nowrap;border:1px solid transparent}',
      '.cpg-ok{background:rgba(46,160,67,.14);color:#3fb950;border-color:rgba(46,160,67,.3)}',
      '.cpg-warn{background:rgba(210,153,34,.16);color:#d29922;border-color:rgba(210,153,34,.32)}',
      '.cpg-bad{background:rgba(248,81,73,.14);color:#f85149;border-color:rgba(248,81,73,.3)}',
      '.cpg-dim{background:rgba(128,128,128,.14);color:var(--dsw-alias-label-secondary,#8b8b8b);border-color:rgba(128,128,128,.22)}',
      '.cpg-info{background:rgba(56,139,253,.14);color:#4a9eff;border-color:rgba(56,139,253,.3)}',
      '.cpg-idle{background:rgba(128,128,128,.09);color:#9a9a9a;border-color:rgba(128,128,128,.18)}',

      // ── 进度条 ──
      '.cpg-bar-outer{height:5px;border-radius:3px;background:rgba(128,128,128,.18);overflow:hidden;min-width:60px}',
      '.cpg-bar-sm{min-width:0;flex:0 0 40px;width:40px}',
      '.cpg-bar-in{height:100%;border-radius:3px;transition:width .3s}',
      '.cpg-usage{display:flex;flex-direction:column;gap:11px}',
      '.cpg-usage-i{display:flex;flex-direction:column;gap:4px}',
      '.cpg-usage-t{display:flex;align-items:baseline;justify-content:space-between;font-size:11.5px}',
      '.cpg-usage-n{color:var(--dsw-alias-label-secondary,#8b8b8b)}',
      '.cpg-usage-v{font-variant-numeric:tabular-nums;font-weight:600}',
      '.cpg-usage-x{font-size:10.5px;color:var(--dsw-alias-label-secondary,#8b8b8b);margin-top:1px}',

      // ── token 合计 ──
      '.cpg-tok{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:9px}',
      '.cpg-tok-c{padding:8px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-tertiary,rgba(128,128,128,.2));background:rgba(128,128,128,.035)}',
      '.cpg-tok-l{font-size:10.5px;color:var(--dsw-alias-label-secondary,#8b8b8b);white-space:nowrap}',
      '.cpg-tok-v{font-size:17px;font-weight:650;line-height:1.35;font-variant-numeric:tabular-nums}',
      '.cpg-tok-s{font-size:10px;color:var(--dsw-alias-label-secondary,#8b8b8b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.cpg-hr{height:1px;background:var(--dsw-alias-border-tertiary,rgba(128,128,128,.18));margin:12px 0}',

      // ── 折叠 ──
      '.cpg-fold{border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.26));border-radius:12px;overflow:hidden}',
      '.cpg-fold-h{display:flex;align-items:center;gap:7px;width:100%;padding:9px 13px;background:rgba(128,128,128,.045);border:0;color:inherit;font-size:12.5px;font-weight:650;cursor:pointer;text-align:left;font-family:inherit}',
      '.cpg-fold-h:hover{background:rgba(128,128,128,.08)}',
      '.cpg-caret{font-size:9px;color:var(--dsw-alias-label-secondary,#8b8b8b);width:9px;display:inline-block}',
      '.cpg-fold-b{padding:11px 13px;border-top:1px solid var(--dsw-alias-border-tertiary,rgba(128,128,128,.18))}',

      // ── 输入 ──
      '.cpg-in{background:transparent;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));border-radius:6px;padding:3px 7px;font-size:11.5px;color:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;width:100%;box-sizing:border-box;min-width:66px}',
      '.cpg-in:focus{outline:0;border-color:rgba(88,166,255,.6)}',
      '.cpg-sel{background:transparent;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));border-radius:6px;padding:3px 7px;font-size:12px;color:inherit;font-family:inherit}',
      '.cpg-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));border-radius:8px;overflow:hidden}',
      '.cpg-seg-b{background:transparent;border:0;color:inherit;font-size:12px;padding:4px 11px;cursor:pointer;font-family:inherit;border-right:1px solid var(--dsw-alias-border-tertiary,rgba(128,128,128,.2))}',
      '.cpg-seg-b:last-child{border-right:0}',
      '.cpg-seg-b:hover{background:rgba(128,128,128,.1)}',
      '.cpg-seg-on{background:rgba(88,166,255,.16);color:#58a6ff}',

      // ── 使用说明 ──
      '.cpg-steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:7px}',
      '.cpg-step{display:flex;gap:8px;align-items:flex-start}',
      '.cpg-step-n{flex:0 0 auto;width:16px;height:16px;border-radius:50%;background:rgba(88,166,255,.16);color:#58a6ff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px}',
      '.cpg-step-t{font-size:12px;line-height:1.55}',
      '.cpg-list{margin:0;padding-left:16px;font-size:12px;line-height:1.7}',
      '.cpg-nowrap{white-space:nowrap}',
    ]

    // 关键：styles.insert 内部是 `element.textContent = css`，直接传数组会被
    // 用逗号 join 成 `.a{..},.b{..}` —— 非法选择器列表，浏览器整段丢弃，
    // 面板会退化成没有样式的裸表格。必须自己 join('\n')。
    // 而且只在插件加载时插一次：放在 render 里会随每次重渲染堆积 <style> 标签。
    styles.insert(CSS.join('\n'))

    // ── 小工具 ─────────────────────────────────────────────────────────────
    function fmtMs(ms) {
      if (typeof ms !== 'number' || !isFinite(ms)) return '—'
      return ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(2) + 's'
    }
    function shortModel(id) { return String(id).replace(/^cline-pass\//, '') }
    function pill(text, kind) { return h('span', { className: 'cpg-pill cpg-' + kind }, text) }
    function pct(v) { return (typeof v === 'number' && isFinite(v)) ? (Math.round(v * 10) / 10) + '%' : '—' }
    function money(v) {
      if (typeof v !== 'number' || !isFinite(v)) return '—'
      if (v === 0) return '$0'
      return '$' + (v < 0.01 ? v.toFixed(6) : v.toFixed(4))
    }
    function providerPill(p) {
      if (!p) return pill('未知', 'dim')
      if (p === 'openai-compatible-private') return pill(p, 'warn')
      return pill(p, 'ok')
    }
    function bar(percent, color, small) {
      const w = Math.max(0, Math.min(100, typeof percent === 'number' && isFinite(percent) ? percent : 0))
      return h('div', { className: 'cpg-bar-outer' + (small ? ' cpg-bar-sm' : '') },
        h('div', { className: 'cpg-bar-in', style: { width: w + '%', background: color } }))
    }
    function tokens(n) {
      if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '0'
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k'
      return n.toLocaleString()
    }

    // 每个模型的**最终结论：钉住没有**。面板最该一眼看明白的就是这件事，
    // 所以状态机做成互斥且穷尽，顺序即优先级：
    //   钉不住（正常）> 未探测 > 可钉未钉 > 钉住但有漏 > 已钉住 > 已配待验证
    function pinVerdict(v, cap, pinList) {
      const want = pinList && pinList.length ? pinList : null
      if (cap && cap.pinnable === false) {
        return { kind: 'dim', label: '钉不住·正常', note: '只有一条管道，没有对象可钉' }
      }
      if (!cap) {
        return { kind: 'idle', label: '未探测', note: '点「探测」确认能不能钉' }
      }
      if (!want) {
        return { kind: 'info', label: '可钉·未钉', note: '钉一个能稳住提示缓存' }
      }
      if (v && v.injected > 0 && v.unmatched > 0) {
        return { kind: 'bad', label: '钉住·有漏', note: v.unmatched + ' 次没落到 ' + want.join(',') }
      }
      if (v && v.injected > 0) {
        return { kind: 'ok', label: '已钉住', note: '命中 ' + v.matched + '/' + (v.matched + v.unmatched) + ' 次' }
      }
      return { kind: 'warn', label: '已配·待验证', note: '发一条消息就能验证' }
    }

    // 本地累计的 token 明细。必须带口径说明：网关只给百分比，token 是这边实测累加的。
    function TokBlock(props) {
      const t = props.totals || {}
      const hit = t.prompt > 0 ? (t.cached / t.prompt) * 100 : null
      const cell = (label, value, sub, color) => h('div', { className: 'cpg-tok-c' },
        h('div', { className: 'cpg-tok-l' }, label),
        h('div', { className: 'cpg-tok-v', style: color ? { color } : null }, value),
        sub ? h('div', { className: 'cpg-tok-s' }, sub) : null)
      return h('div', null,
        h('div', { className: 'cpg-tok' },
          cell('合计', tokens(t.total), '输入 + 输出'),
          cell('输入', tokens(t.prompt), 'prompt'),
          cell('其中命中缓存', tokens(t.cached), hit === null ? '—' : pct(hit) + ' 命中',
            hit === null ? null : (hit >= 60 ? '#3fb950' : (hit >= 20 ? '#d29922' : '#f85149'))),
          cell('输出', tokens(t.completion), t.reasoning ? ('含思考 ' + tokens(t.reasoning)) : 'completion')),
        h('div', { className: 'cpg-note cpg-note-b' },
          '口径：本机从 ' + String(t.since || '').slice(0, 16).replace('T', ' ') + ' 起实测累加的 '
          + (t.requests || 0) + ' 次请求。网关不提供 token 用量（套餐额度按费用计、只回百分比），'
          + '所以这里的 token 是这边数出来的，清空统计会归零。'))
    }

    // ── 结论条 ─────────────────────────────────────────────────────────────
    function Hero(props) {
      const v = props.verdict
      return h('div', { className: 'cpg-hero cpg-k-' + v.kind },
        h('div', { className: 'cpg-hero-dot cpg-d-' + v.kind }),
        h('div', { className: 'cpg-hero-b' },
          h('div', { className: 'cpg-hero-t' }, v.title),
          v.desc ? h('div', { className: 'cpg-hero-d' }, v.desc) : null))
    }

    function Kpi(props) {
      return h('div', { className: 'cpg-kpi' },
        h('div', { className: 'cpg-kpi-l' }, props.label),
        h('div', { className: 'cpg-kpi-v', style: props.color ? { color: props.color } : null }, props.value),
        props.sub ? h('div', { className: 'cpg-kpi-s', title: props.sub }, props.sub) : null)
    }

    function Sec(props) {
      return h('div', { className: 'cpg-sec' },
        h('div', { className: 'cpg-sec-h' },
          h('div', { className: 'cpg-sec-t' }, props.title),
          props.meta ? h('div', { className: 'cpg-sec-m' }, props.meta) : null),
        h('div', { className: props.flush ? 'cpg-sec-b-flush' : 'cpg-sec-b' }, props.children))
    }

    function Fold(props) {
      return h('div', { className: 'cpg-fold' },
        h('button', { className: 'cpg-fold-h', onClick: props.onToggle, type: 'button' },
          h('span', { className: 'cpg-caret' }, props.open ? '▾' : '▸'),
          h('span', null, props.title),
          props.meta ? h('span', { className: 'cpg-sec-m' }, props.meta) : null),
        props.open ? h('div', { className: 'cpg-fold-b' }, props.children) : null)
    }

    function Seg(props) {
      return h('div', { className: 'cpg-seg' },
        props.options.map((o) => h('button', {
          key: o.value, type: 'button',
          className: 'cpg-seg-b' + (props.value === o.value ? ' cpg-seg-on' : ''),
          disabled: props.disabled,
          onClick: () => props.onChange(o.value),
        }, o.label)))
    }

    // ── 套餐用量 ───────────────────────────────────────────────────────────
    function UsageBlock(props) {
      const u = props.usage
      if (!u || !u.ok) {
        return h('div', { className: 'cpg-note' },
          u && u.error ? ('读取失败：' + u.error) : '读取中…')
      }
      const names = { five_hour: '5 小时', weekly: '每周', monthly: '每月' }
      return h('div', { className: 'cpg-usage' },
        u.limits.map((L) => {
          const left = typeof L.remaining === 'number' ? L.remaining : 0
          const color = left > 30 ? '#3fb950' : (left > 10 ? '#d29922' : '#f85149')
          return h('div', { key: L.type, className: 'cpg-usage-i' },
            h('div', { className: 'cpg-usage-t' },
              h('span', { className: 'cpg-usage-n' }, names[L.type] || L.type),
              h('span', { className: 'cpg-usage-v', style: { color } }, left + '%')),
            bar(left, color),
            L.resetsAt
              ? h('div', { className: 'cpg-usage-x' }, '重置于 ' + String(L.resetsAt).slice(0, 16).replace('T', ' '))
              : null)
        }),
        h('div', { className: 'cpg-note', style: { marginTop: '2px' } }, 'key 引用 ' + (u.keyRef || '—')))
    }

    // ── 主面板 ──────────────────────────────────────────────────────────────
    function Panel() {
      const [st, setSt] = useState(null)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState(null)
      const [open, setOpen] = useState({})
      const [draft, setDraft] = useState(null)
      const [injection, setInjection] = useState(null)
      const [mode, setMode] = useState(null)
      const [fold, setFold] = useState({ guide: true, settings: false })

      const load = useCallback(async () => {
        try {
          setErr(null)
          const next = await host.call('guard.state', {})
          setSt(next)
          setDraft((prev) => {
            if (prev !== null) return prev
            const pins = next.config && next.config.pins ? next.config.pins : {}
            const out = {}
            for (const m of (next.models || [])) {
              out[m] = Array.isArray(pins[m]) ? pins[m].join(', ') : ''
            }
            for (const m of Object.keys(pins)) if (out[m] === undefined) out[m] = (pins[m] || []).join(', ')
            return out
          })
          setInjection((prev) => (prev === null ? (next.config ? next.config.injection : 'auto') : prev))
          setMode((prev) => (prev === null ? (next.config ? next.config.mode : 'warn') : prev))
        } catch (e) { setErr(String((e && e.message) || e)) }
      }, [])

      useEffect(() => { load() }, [load])
      useEffect(() => {
        const timer = setInterval(load, 15000)
        return () => clearInterval(timer)
      }, [load])

      const run = useCallback(async (name, arg, label) => {
        setBusy(label)
        setErr(null)
        try {
          await host.call(name, arg)
          await load()
        } catch (e) { setErr(String((e && e.message) || e)) }
        finally { setBusy('') }
      }, [load])

      const saveConfig = useCallback(async () => {
        setBusy('保存配置')
        setErr(null)
        try {
          await host.call('guard.config', { injection, mode })
          await load()
        } catch (e) { setErr(String((e && e.message) || e)) }
        finally { setBusy('') }
      }, [injection, mode, load])

      const savePins = useCallback(async () => {
        setBusy('保存钉选')
        setErr(null)
        try {
          await host.call('guard.config', { pins: draft || {} })
          setDraft(null)
          await load()
        } catch (e) { setErr(String((e && e.message) || e)) }
        finally { setBusy('') }
      }, [draft, load])

      function setDraftOne(model, value) {
        setDraft(Object.assign({}, draft || {}, { [model]: value }))
      }
      function toggleFold(k) {
        setFold(Object.assign({}, fold, { [k]: !fold[k] }))
      }

      if (st === null) {
        return h('div', { className: 'cpg-wrap' },
          h('div', { className: 'cpg-dim' }, '读取中…'))
      }

      const models = st.models || []
      const live = st.live || []
      const capBy = {}
      for (const c of (st.capabilities || [])) capBy[c.model] = c
      const probeBy = {}
      for (const p of (st.probes || [])) probeBy[p.model] = p
      const baseBy = {}
      for (const b of (st.baseline || [])) baseBy[b.model] = b
      const hook = st.hook || {}
      const cfg = st.config || {}
      const drifts = st.drifts || []

      // ── 聚合指标 ──
      // 宿主已经算好 totals（含输出 token）；这里保留一份本地兜底，防止老版本宿主没有该字段
      const agg = { requests: 0, prompt: 0, cached: 0, completion: 0, cost: 0, multi: 0 }
      for (const v of live) {
        agg.requests += v.requests || 0
        agg.prompt += v.prompt || 0
        agg.cached += v.cachedTokens || 0
        agg.completion += v.completionTokens || 0
        if (v.costKnown) agg.cost += v.cost || 0
        if (Object.keys(v.providers || {}).length > 1) agg.multi += 1
      }
      const T = st.totals || {
        since: hook.installedAt, requests: agg.requests, prompt: agg.prompt,
        cached: agg.cached, completion: agg.completion, reasoning: 0,
        total: agg.prompt + agg.completion, cost: agg.cost, costKnown: agg.cost > 0,
      }
      const cacheRate = T.prompt > 0 ? (T.cached / T.prompt) * 100 : null
      const pins = cfg.pins || {}
      const pinOf = (m) => (Array.isArray(pins[m]) ? pins[m] : null)

      // 每个模型都先算出结论，总判定要用它
      const verdicts = models.map((m) => pinVerdict(live.find((v) => v.model === m), capBy[m], pinOf(m)))
      const nBad = verdicts.filter((x) => x.kind === 'bad').length
      const nOk = verdicts.filter((x) => x.kind === 'ok').length
      const nFree = verdicts.filter((x) => x.kind === 'dim').length
      // 必须拆成三种，不能合成一个「待处理」计数：
      //   info = 探测确认可钉、但没配目标      idle = 没探测过、能不能钉未知
      //   warn = 配了钉选、但还没有请求验证过
      // 混在一起就会出现「有 3 个模型可以钉但还没钉」这种把「不知道」说成「可以」的错误结论。
      const nReady = verdicts.filter((x) => x.kind === 'info').length
      const nUnprobed = verdicts.filter((x) => x.kind === 'idle').length
      const nPending = verdicts.filter((x) => x.kind === 'warn').length

      // ── 一句话结论（围绕「钉住没有」给，而不是围绕日志多少）──
      const pinSummary = '已钉住 ' + nOk + ' 个 · 钉不住 ' + nFree + ' 个（正常）'
        + (nUnprobed ? ' · 未探测 ' + nUnprobed + ' 个（不影响使用）' : '')
      let verdict
      if (!st.credentialConfigured) {
        verdict = { kind: 'bad', title: '凭据未就绪，守卫看不到任何东西',
          desc: st.credentialError || '没有读到 CLINE_API_KEY。补齐凭据后重启即可，其它不用改。' }
      } else if (!hook.installed) {
        verdict = { kind: 'warn', title: '钩子没挂上',
          desc: '进程内的 fetch 没有被包裹，观测与注入都不会发生。通常重启一次就好。' }
      } else if (nBad > 0) {
        verdict = { kind: 'bad', title: '有模型没钉住（' + nBad + ' 个）',
          desc: '配了钉选但请求没落到指定上游 —— 缓存正在被切碎。看下方「钉住结果」红标那几行。' }
      } else if (nReady > 0) {
        verdict = { kind: 'idle', title: '有 ' + nReady + ' 个模型确认可钉，但还没配目标',
          desc: '不钉也能用；钉住是为了让上游别乱切、保住提示缓存。' + pinSummary }
      } else if (nPending > 0) {
        verdict = { kind: 'idle', title: '有 ' + nPending + ' 个模型配了钉选，还没验证',
          desc: '发一条消息经过它，「钉住结果」就会从「已配·待验证」变成「已钉住」或「钉住·有漏」。' }
      } else if (drifts.length > 0) {
        verdict = { kind: 'warn', title: '上游有变化（' + drifts.length + ' 条漂移）',
          desc: '同一模型换了上游 → 提示缓存要重算 → 费用会明显上去。看下方「上游漂移」是哪次。' }
      } else if (!hook.seen) {
        verdict = { kind: 'idle', title: '钩子已就位，还没观测到流量',
          desc: '用 cline-pass 的模型随便发一条消息，这里就会出现真实数据。不需要任何配置。' }
      } else {
        verdict = { kind: 'ok', title: '已守住：该钉的都钉住了',
          desc: pinSummary + ' · 上游没有乱切 · 你不需要做任何事。' }
      }

      const injectionHelp = {
        auto: '只对「探测确认可钉」且你配了钉选的模型注入 —— 单一上游的模型（如 v4.1-flash）一个字节都不改',
        always: '只要配了钉选就注入，不管探测结论 —— 字段可能被网关静默丢弃',
        never: '一律不注入，纯观测',
      }
      const modeHelp = {
        observe: '只记录，不告警也不拦截',
        warn: '记录，并在漂移/未命中时标警告（默认，推荐）',
        strict: '发请求前检查历史命中：该模型出现过允许列表外的上游就直接拒绝发出（会打断你的工作，慎用）',
      }

      const pinDirty = injection !== cfg.injection || mode !== cfg.mode

      return h('div', { className: 'cpg-wrap' },
        h(Hero, { verdict }),

        h('div', { className: 'cpg-kpis' },
          h(Kpi, { label: '累计 token', value: tokens(T.total),
            sub: T.requests ? (T.requests + ' 次请求 · 输入 ' + tokens(T.prompt) + ' / 输出 ' + tokens(T.completion)) : '还没有 token 数据' }),
          h(Kpi, { label: '缓存命中率', value: cacheRate === null ? '—' : pct(cacheRate),
            color: cacheRate === null ? null : (cacheRate >= 60 ? '#3fb950' : (cacheRate >= 20 ? '#d29922' : '#f85149')),
            sub: T.prompt > 0 ? (tokens(T.cached) + ' / ' + tokens(T.prompt) + ' 命中') : '还没有 token 数据' }),
          h(Kpi, { label: '累计费用', value: money(T.costKnown ? T.cost : agg.cost),
            sub: T.requests ? (T.requests + ' 次请求') : '—' }),
          h(Kpi, { label: '钉住情况', value: nOk + ' / ' + models.length,
            color: nBad > 0 ? '#f85149' : (nOk > 0 ? '#3fb950' : null),
            sub: '钉不住 ' + nFree + ' · 未探测 ' + nUnprobed + (nReady ? ' · 可钉未钉 ' + nReady : '') })),

        h('div', { className: 'cpg-bar' },
          h('button', { className: 'cpg-btn cpg-btn-c', disabled: !!busy,
            onClick: () => run('guard.probeAll', {}, '探测全部') },
            busy === '探测全部' ? '探测中…' : '探测全部'),
          h('button', { className: 'cpg-btn', disabled: !!busy, onClick: () => load() }, '刷新'),
          h('div', { className: 'cpg-sp' }),
          h('span', { className: 'cpg-dim cpg-nowrap', style: { fontSize: '11px' } },
            hook.installed
              ? ('钩子已装 · ' + String(hook.installedAt || '').slice(11, 19)
                + ' · 已见 ' + (hook.seen || 0) + ' · 注入 ' + (hook.injected || 0)
                + ' · 拦截 ' + (hook.blocked || 0))
              : '钩子未装')),

        err ? h('div', { className: 'cpg-err' }, err) : null,

        !st.credentialConfigured
          ? h('div', { className: 'cpg-err' }, st.credentialError || '未找到 API key')
          : null,

        // ── 使用说明（默认展开：这就是「怎么用」的答案）──
        h(Fold, {
          title: '怎么用（三步，通常你只需要第一步）',
          open: fold.guide, onToggle: () => toggleFold('guide'),
          meta: h('span', { className: 'cpg-pill cpg-dim' }, '先读这里'),
        },
          h('ol', { className: 'cpg-steps' },
            h('li', { className: 'cpg-step' },
              h('span', { className: 'cpg-step-n' }, '1'),
              h('span', { className: 'cpg-step-t' },
                '打开这个页面：设置 → 上游守卫。面板一出现就已经在自动工作了。')),
            h('li', { className: 'cpg-step' },
              h('span', { className: 'cpg-step-n' }, '2'),
              h('span', { className: 'cpg-step-t' },
                '什么都不用配。默认「注入策略 auto + 运行模式 warn」就是最稳的状态：可钉的模型自动钉，钉不住的一个字节不改，有异常才提示。')),
            h('li', { className: 'cpg-step' },
              h('span', { className: 'cpg-step-n' }, '3'),
              h('span', { className: 'cpg-step-t' },
                '平时只需要看三处：',
                h('ul', { className: 'cpg-list' },
                  h('li', null, '顶部那句结论 —— 有黄色/红色才需要往下看'),
                  h('li', null, '「钉住结果」的结论列 —— 五种结论一眼看完，只有红标才需要动手'),
                  h('li', null, '「上游漂移」有记录 —— 确实换了上游，可以点「重置漂移基线」表示接受'))))),
          h('div', { className: 'cpg-note cpg-note-b' },
            '关于钉选：只有「多上游」的模型才钉得住。deepseek-v4.1-flash 是单管道的虚拟模型，钉不住也不需要钉 —— ' +
            '它在「结论」列会显示「钉不住·正常」，这是正常且最终的状态，不是坏了。v4-pro 这类才会显示可选上游。'),
          h('div', { className: 'cpg-bar', style: { marginTop: '9px' } },
            h('button', { className: 'cpg-btn cpg-btn-x', disabled: !!busy, onClick: () => load() }, '刷新数据'),
            h('button', { className: 'cpg-btn cpg-btn-x', disabled: !!busy,
              onClick: () => run('guard.clear', {}, '清空统计') }, '清空统计'),
            h('button', { className: 'cpg-btn cpg-btn-x', disabled: !!busy,
              onClick: () => run('guard.baseline', {}, '重置漂移基线') }, '重置漂移基线'))),

        // ── 钉住结果：一行一个模型，结论在最左，操作在同一行 ──
        // 以前这里是「实时流量」+「可钉性」两张表，同一件事要跨表对照才能判断；
        // 现在按用户真正的问题排序：这个模型钉住了没有 → 没钉是因为什么 → 该点什么。
        h(Sec, {
          title: '钉住结果',
          meta: h('span', { className: 'cpg-bar' },
            h('span', { className: 'cpg-dim cpg-nowrap' }, '填完点这里'),
            h('button', { className: 'cpg-btn cpg-btn-x', disabled: !!busy, onClick: savePins }, '保存钉选')),
        },
          models.length === 0
            ? h('div', { className: 'cpg-note' }, '没有读到模型清单（检查 profile 的 llm 配置）。')
            : h('div', null,
              h('div', { className: 'cpg-tscroll' },
                h('table', { className: 'cpg-tbl' },
                  h('thead', null, h('tr', null,
                    h('th', { style: { width: '118px' } }, '模型'),
                    h('th', { style: { width: '104px' } }, '结论'),
                    h('th', { style: { width: '84px' } }, '实际命中'),
                    h('th', { className: 'cpg-num', style: { width: '44px' } }, '注入'),
                    h('th', { className: 'cpg-num', style: { width: '48px' } }, '缓存率'),
                    h('th', { className: 'cpg-num', style: { width: '62px' } }, '费用'),
                    h('th', null, '钉选目标'),
                    h('th', { className: 'cpg-act' }, ''))),
                  h('tbody', null, models.map((m) => {
                    const v = live.find((x) => x.model === m) || null
                    const c = capBy[m]
                    const p = probeBy[m]
                    const b = baseBy[m]
                    const pin = pinOf(m)
                    const vd = pinVerdict(v, c, pin)
                    const prog = probeBy[m]
                    const cands = (prog && prog.availableProviders && prog.availableProviders.length)
                      ? prog.availableProviders.join(', ')
                      : (c && c.providers && c.providers.length ? c.providers.join(', ') : '')
                    const avg = v && v.latencyN ? v.latencySum / v.latencyN : null
                    const rate = v && v.prompt > 0 ? (v.cachedTokens / v.prompt) * 100 : null
                    const slug = (v && v.lastSlug) || (p && p.canonicalSlug) || (b && b.canonicalSlug) || ''
                    const distKeys = v ? Object.keys(v.providers || {}) : []
                    const dist = distKeys.map((x) => x + '×' + v.providers[x]).join('  ')
                    return h('tr', { key: m },
                      h('td', null,
                        h('div', { className: 'cpg-name cpg-mono', title: m }, shortModel(m)),
                        slug ? h('div', { className: 'cpg-slug cpg-mono', title: slug }, slug) : null),
                      h('td', null,
                        pill(vd.label, vd.kind),
                        h('div', { className: 'cpg-vdnote', title: vd.note }, vd.note)),
                      h('td', null,
                        (v || b || c)
                          ? providerPill(v && v.lastProvider ? v.lastProvider : (b && b.finalProvider))
                          : h('span', { className: 'cpg-dim' }, '—'),
                        distKeys.length > 1
                          // 多渠道路由 = 缓存会被切碎的信号，必须仍然显眼（改版时差点丢掉）
                          ? h('div', { className: 'cpg-sub cpg-sub-warn', title: dist }, dist)
                          : null),
                      h('td', { className: 'cpg-mono cpg-num' },
                        v && v.injected > 0
                          ? (v.matched + '/' + (v.matched + v.unmatched))
                          : h('span', { className: 'cpg-dim' }, '—')),
                      h('td', {
                        className: 'cpg-mono cpg-num',
                        // 请求数与延迟不占列了：悬停缓存率即可看到，详情里也有完整的
                        title: v ? ('请求 ' + v.requests + ' 次 · 平均延迟 ' + fmtMs(avg) + ' · 命中 ' + tokens(v.cachedTokens) + '/' + tokens(v.prompt)) : null,
                        style: rate === null ? null : { color: rate >= 60 ? '#3fb950' : (rate >= 20 ? '#d29922' : '#f85149') },
                      }, pct(rate)),
                      h('td', { className: 'cpg-mono cpg-num' }, v && v.costKnown ? money(v.cost) : '—'),
                      h('td', null, h('input', {
                        className: 'cpg-in',
                        title: cands ? ('候选：' + cands) : null,
                        value: (draft && draft[m] !== undefined) ? draft[m] : '',
                        placeholder: c && c.pinnable === false ? '不需要' : (cands || '如 deepseek'),
                        onChange: (e) => setDraftOne(m, e.target.value),
                      })),
                      h('td', { className: 'cpg-act' },
                        h('button', { className: 'cpg-btn cpg-btn-x', disabled: !!busy,
                          onClick: () => run('guard.probe', { model: m }, m) }, busy === m ? '…' : '探测'),
                        ' ',
                        h('button', { className: 'cpg-btn cpg-btn-x', disabled: !!busy,
                          onClick: () => setOpen(Object.assign({}, open, { [m]: !open[m] })) },
                          open[m] ? '收起' : '详情')))
                  })))),
              h('div', { className: 'cpg-note cpg-note-b' },
                '结论怎么看：绿「已钉住」= 请求确实落在你指定的上游；灰「钉不住·正常」= 该模型只有一条管道，' +
                '没有对象可钉（deepseek-v4.1-flash 就是这种，不是坏了）；蓝「可钉·未钉」= 想省缓存就填个目标；' +
                '红「钉住·有漏」= 配了但没落到，最该处理。'))),

        // ── 上游漂移 ──
        drifts.length
          ? h(Sec, { title: '上游漂移', meta: h('span', null, drifts.length + ' 条') },
            h('table', { className: 'cpg-tbl' },
              h('thead', null, h('tr', null,
                h('th', null, '时间'), h('th', null, '模型'), h('th', null, '字段'),
                h('th', null, '从'), h('th', null, '到'))),
              h('tbody', null, drifts.slice(0, 15).map((d, i) => h('tr', { key: i },
                h('td', { className: 'cpg-mono' }, String(d.at).slice(5, 16).replace('T', ' ')),
                h('td', { className: 'cpg-mono' }, shortModel(d.model)),
                h('td', null, pill(d.field, 'warn')),
                h('td', { className: 'cpg-mono cpg-dim cpg-slugcell', title: String(d.from) }, String(d.from)),
                h('td', { className: 'cpg-mono cpg-slugcell', title: String(d.to) }, String(d.to)))))))
          : null,

        // ── 用量：本机实测 token + 网关给的套餐百分比 ──
        h(Sec, { title: '用量', meta: h('span', null, 'token 本机实测 · 套餐据实读取') },
          h(TokBlock, { totals: T }),
          h('div', { className: 'cpg-hr' }),
          h('div', { className: 'cpg-note', style: { marginBottom: '8px' } },
            '套餐额度（网关只回百分比，按费用计上限）：'),
          h(UsageBlock, { usage: st.usage })),

        // ── 守卫配置（低频，折叠）──
        h(Fold, {
          title: '守卫配置（低频，通常不用动）',
          open: fold.settings, onToggle: () => toggleFold('settings'),
          meta: pinDirty ? pill('未保存', 'warn') : pill('已保存', 'ok'),
        },
          h('div', { className: 'cpg-bar', style: { gap: '10px' } },
            h('span', { className: 'cpg-dim cpg-nowrap' }, '注入策略'),
            h(Seg, {
              value: injection || 'auto', disabled: !!busy,
              options: [{ value: 'auto', label: 'auto' }, { value: 'always', label: 'always' }, { value: 'never', label: 'never' }],
              onChange: setInjection,
            }),
            h('span', { className: 'cpg-sp' }),
            h('span', { className: 'cpg-dim cpg-nowrap' }, '运行模式'),
            h(Seg, {
              value: mode || 'warn', disabled: !!busy,
              options: [{ value: 'observe', label: 'observe' }, { value: 'warn', label: 'warn' }, { value: 'strict', label: 'strict' }],
              onChange: setMode,
            }),
            h('button', { className: 'cpg-btn cpg-btn-c', disabled: !!busy, onClick: saveConfig }, '保存配置')),
          h('div', { className: 'cpg-note cpg-note-b' }, '注入策略：' + (injectionHelp[injection] || '')),
          h('div', { className: 'cpg-note' }, '运行模式：' + (modeHelp[mode] || '')),
          h('div', { className: 'cpg-note' }, '配置落盘：' + (st.configFile || '—')),

        ),

        // ── 详情 ──
        (st.probes || []).filter((p) => open[p.model]).map((p) => h(DetailCard, {
          key: 'd-' + p.model, p, busy,
          onCache: () => run('guard.cache', { model: p.model, rounds: 2 }, '缓存 ' + p.model),
        })),

        // ── 操作历史 ──
        (st.history || []).length
          ? h(Sec, { title: '操作历史', meta: h('span', null, st.history.length + ' 条') },
            h('table', { className: 'cpg-tbl' },
              h('tbody', null, st.history.slice(0, 12).map((e, i) => h('tr', { key: i },
                h('td', { className: 'cpg-mono cpg-dim', style: { width: '62px' } }, String(e.at).slice(11, 19)),
                h('td', { style: { width: '76px' } }, e.action),
                h('td', { className: 'cpg-mono' }, e.model ? shortModel(e.model) : ''),
                h('td', { className: 'cpg-dim' }, e.detail || ''))))))
          : null,
      )
    }

    // ── 单个模型的探测详情 ─────────────────────────────────────────────────
    function DetailCard(props) {
      const p = props.p
      const rows = []
      function kv(label, value, mono) {
        rows.push(h('tr', { key: label },
          h('th', null, label),
          h('td', { className: mono === false ? '' : 'cpg-mono' },
            value === null || value === undefined || value === '' ? '—' : String(value))))
      }
      kv('规范 slug', p.canonicalSlug)
      kv('实际命中上游', p.finalProvider)
      kv('resolvedProvider', p.resolvedProvider)
      kv('网关回读 model', p.modelField)
      if (p.affinity) kv('亲和性', JSON.stringify(p.affinity))
      kv('fallback 数', p.fallbacks ? p.fallbacks.length : null)
      kv('HTTP / 延迟', p.request ? (p.request.http + '　' + fmtMs(p.request.ms)) : null)
      if (p.usage) {
        kv('prompt token', p.usage.prompt)
        kv('缓存命中 token', p.usage.cached)
        kv('缓存命中率', p.usage.prompt > 0 ? Math.round((p.usage.cached / p.usage.prompt) * 1000) / 10 + '%' : null)
      }
      if (p.gatewayCost) kv('本次费用', 'cost=' + p.gatewayCost.cost + '　gatewayCost=' + p.gatewayCost.gatewayCost)
      if (p.vendorCache) kv('厂商侧缓存 hit/miss', p.vendorCache.hit + ' / ' + p.vendorCache.miss)
      kv('候选上游', p.availableProviders && p.availableProviders.length ? p.availableProviders.join(', ') : null)

      return h('div', { className: 'cpg-sec' },
        h('div', { className: 'cpg-sec-h' },
          h('div', { className: 'cpg-sec-t' }, '探测详情：' + shortModel(p.model)),
          h('div', { className: 'cpg-sec-m' },
            (p.pinHonored === true ? pill('可钉', 'ok') : (p.pinHonored === false ? pill('钉不动', 'dim') : pill('未知', 'dim'))))),
        h('div', { className: 'cpg-sec-b' },
          p.error ? h('div', { className: 'cpg-err', style: { marginBottom: '8px' } }, '错误：' + p.error) : null,
          p.note ? h('div', { className: 'cpg-note', style: { marginBottom: '8px' } }, '提示：' + p.note) : null,
          h('table', { className: 'cpg-tbl cpg-tbl-kv' }, h('tbody', null, rows)),
          p.probedViaError ? h('div', { className: 'cpg-note cpg-note-b' }, '假上游探测回报：' + p.probedViaError) : null,
          p.cache
            ? h('div', null,
              h('div', { className: 'cpg-note', style: { marginTop: '12px', fontWeight: 600 } }, '缓存实测'),
              h('table', { className: 'cpg-tbl' },
                h('thead', null, h('tr', null,
                  h('th', null, '轮次'), h('th', null, '上游'), h('th', null, 'prompt'),
                  h('th', null, '命中'), h('th', null, '命中率'), h('th', null, '耗时'), h('th', null, '花费'))),
                h('tbody', null, p.cache.runs.map((r) => h('tr', { key: r.round },
                  h('td', null, r.round),
                  h('td', null, r.ok ? providerPill(r.finalProvider) : pill('失败', 'bad')),
                  h('td', { className: 'cpg-mono' }, r.ok ? r.prompt : '—'),
                  h('td', { className: 'cpg-mono' }, r.ok ? r.cached : '—'),
                  h('td', { className: 'cpg-mono' }, r.ok ? r.hitRate + '%' : '—'),
                  h('td', { className: 'cpg-mono' }, fmtMs(r.ms)),
                  h('td', { className: 'cpg-mono' }, r.ok && r.cost ? money(Number(r.cost)) : '—'))))))
            : null,
          h('div', { className: 'cpg-bar', style: { marginTop: '11px' } },
            h('button', { className: 'cpg-btn cpg-btn-x', disabled: !!props.busy, onClick: props.onCache },
              '缓存实测（连发 2 次长前缀）'),
            h('span', { className: 'cpg-dim', style: { fontSize: '11px' } }, '会消耗少量套餐额度'))))
    }

    slots.inject('settings.section', function () {
      return slots.register(
        { name: 'settings.section', id: 'clinepass-guard', order: 14, label: TAB_TITLE },
        function () { return h(Panel, null) })
    })
  },
}
