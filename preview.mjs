// 面板可视化预览：用真实 dist/native/client.js 渲染成 HTML，交给 Edge 无头截图。
// 目的：改 CSS 时能看着改，而不是盲改。不连 DSH、不碰真实数据。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(root, 'preview')
fs.mkdirSync(outDir, { recursive: true })

// ── mock React（与 test-client.mjs 同语义：children 并进 props.children）──
const instances = new Map()
let current = null
let dirty = 0
const React = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    const merged = Object.assign({}, props || {})
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged, children }
  },
  useState(initial) {
    const inst = current
    const i = inst.index++
    if (!(i in inst.hooks)) {
      const v = (typeof initial === 'function') ? initial() : initial
      // PREVIEW_DETAIL=1：把「空对象」型的初始状态（面板里用来记展开项的 open={}）
      // 换成一个「任何 key 都为真」的代理，这样预览就能渲染出展开的详情卡。
      // 只影响空对象——fold={guide,settings}、draft=null 等不受影响。
      inst.hooks[i] = (process.env.PREVIEW_DETAIL && v && typeof v === 'object'
        && !Array.isArray(v) && Object.keys(v).length === 0)
        ? new Proxy({}, { get: () => true, has: () => true })
        : v
    }
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
    inst.lastPending = inst.pending
    return expand(out, keyPath)
  }
  return {
    tag: node.type,
    props: node.props || {},
    children: (node.children || []).map((c, i) => expand(c, keyPath + '.' + i)).filter((c) => c !== null),
  }
}
async function flush(rootEl) {
  let tree = null
  for (let i = 0; i < 8; i++) {
    const before = dirty
    tree = expand(rootEl, 'root')
    for (const inst of instances.values()) {
      for (const p of (inst.lastPending || [])) {
        const r = p.fn()
        if (typeof r === 'function') inst.cleanups.push(r)
      }
      inst.lastPending = []
    }
    await new Promise((r) => setTimeout(r, 8))
    if (dirty === before && i > 0) break
  }
  return tree
}

// ── mock document / window / slots / host ────────────────────────────────
const styleTags = []
globalThis.document = {
  createElement(tag) { return { tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, textContent: '', remove() { } } },
  head: { appendChild(el) { styleTags.push(el) } },
}
let loaded = null
globalThis.window = { __ModuleLoader__: { load(o) { loaded = o } } }

const STATE_RICH = JSON.parse(fs.readFileSync(path.join(root, 'preview', 'state-rich.json'), 'utf8'))
const STATE_COLD = JSON.parse(fs.readFileSync(path.join(root, 'preview', 'state-cold.json'), 'utf8'))
// 可选：把从线上真机抓到的 state 也渲染一张 —— 用来验证面板能吃**真实**字段，
// 而不是只吃手写的 fixture（真实 payload 多出来的字段不会炸，缺的字段不会崩）。
const LIVE_FILE = path.join(root, 'preview', 'state-live.json')
const STATE_LIVE = fs.existsSync(LIVE_FILE) ? JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8')) : null
let STATE = STATE_RICH
globalThis.fetch = async function (url) {
  if (url === '/clinepass-guard/api/state') return { ok: true, status: 200, async json() { return JSON.parse(JSON.stringify(STATE)) } }
  return { ok: true, status: 200, async json() { return { ok: true } } }
}

const regs = []
const slots = {
  inject(name, factory) { return factory() },
  register(spec, component) { regs.push({ spec, component }); return () => { } },
}

// 面板里有 setInterval(load, 15000) 做自动刷新 —— 预览是静态渲染，不需要它，
// 而且留着会让 node 的事件循环永不退出（表现为脚本"卡死"）。
globalThis.setInterval = function () { return 0 }
globalThis.clearInterval = function () { }

// ── 序列化成 HTML ────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function styleStr(obj) {
  if (!obj) return ''
  return Object.keys(obj).map((k) => {
    const v = obj[k]
    if (v === null || v === undefined) return ''
    const prop = String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
    return prop + ':' + v
  }).filter(Boolean).join(';')
}
function toHtml(node) {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (node.text !== undefined) return esc(node.text)
  const p = node.props || {}
  const attrs = []
  if (p.className) attrs.push('class="' + esc(p.className) + '"')
  if (p.id) attrs.push('id="' + esc(p.id) + '"')
  if (p.title) attrs.push('title="' + esc(p.title) + '"')
  if (p.style) attrs.push('style="' + esc(styleStr(p.style)) + '"')
  if (node.tag === 'input') {
    attrs.push('value="' + esc(p.value === undefined ? '' : p.value) + '"')
    if (p.placeholder) attrs.push('placeholder="' + esc(p.placeholder) + '"')
    if (p.disabled) attrs.push('disabled')
  }
  if (node.tag === 'button' && p.disabled) attrs.push('disabled')
  const inner = (node.children || []).map(toHtml).join('')
  const voidTags = ['input', 'br', 'img', 'hr']
  if (voidTags.indexOf(node.tag) !== -1) return '<' + node.tag + ' ' + attrs.join(' ') + '>'
  return '<' + node.tag + ' ' + attrs.join(' ') + '>' + inner + '</' + node.tag + '>'
}

// ── 主题 ─────────────────────────────────────────────────────────────────
const THEMES = {
  dark: {
    bg: '#1b1b1f', fg: '#e6e6e9',
    vars: [
      '--dsw-alias-label-primary:#e6e6e9',
      '--dsw-alias-label-secondary:#8f8f99',
      '--dsw-alias-border-secondary:rgba(255,255,255,.16)',
      '--dsw-alias-border-tertiary:rgba(255,255,255,.09)',
      '--dsw-alias-interactive-bg-hover:rgba(255,255,255,.08)',
      '--dsw-alias-bg-secondary:rgba(255,255,255,.035)',
    ].join(';'),
  },
  light: {
    bg: '#ffffff', fg: '#1f2328',
    vars: [
      '--dsw-alias-label-primary:#1f2328',
      '--dsw-alias-label-secondary:#6b7280',
      '--dsw-alias-border-secondary:rgba(0,0,0,.16)',
      '--dsw-alias-border-tertiary:rgba(0,0,0,.08)',
      '--dsw-alias-interactive-bg-hover:rgba(0,0,0,.06)',
      '--dsw-alias-bg-secondary:rgba(0,0,0,.025)',
    ].join(';'),
  },
}

async function render(state, theme, name) {
  // 重置 hook 环境，保证每种状态独立
  instances.clear(); dirty = 0; styleTags.length = 0; regs.length = 0
  STATE = state

  const code = fs.readFileSync(path.join(root, 'dist', 'native', 'client.js'), 'utf8')
  new Function('window', 'document', code)(globalThis.window, globalThis.document)
  const plugin = loaded.factory((n) => { if (n === 'react') return React; throw new Error('require ' + n) })
  plugin.apply({ get(n) { return n === 'slots' ? slots : undefined } })

  const tree = await flush(regs[0].component())
  const css = styleTags.map((t) => t.textContent).join('\n')
  const body = toHtml(tree)
  const t = THEMES[theme]

  const html = '<!doctype html><meta charset="utf-8"><style>' +
    '*{box-sizing:border-box}body{margin:0;padding:22px 24px;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
    'background:' + t.bg + ';color:' + t.fg + ';' + t.vars + '}' +
    ':root{' + t.vars + '}' +
    '\n' + css + '\n</style><div style="max-width:760px">' + body + '</div>'

  const file = path.join(outDir, name + '.html')
  fs.writeFileSync(file, html, 'utf8')
  return { file, name }
}

// ── 截图 ─────────────────────────────────────────────────────────────────
function shoot(htmlFile, pngFile, height) {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  const tmp = path.join(os.tmpdir(), 'edge-preview-profile')
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--user-data-dir=' + tmp,
    '--window-size=808,' + height,
    '--screenshot=' + pngFile,
    'file:///' + htmlFile.replace(/\\/g, '/'),
  ]
  execFileSync(edge, args, { stdio: 'ignore', timeout: 90000 })
  return fs.existsSync(pngFile) ? fs.statSync(pngFile).size : 0
}

const jobs = [
  { state: STATE_RICH, theme: 'dark', name: 'rich-dark', h: 2650 },
  { state: STATE_RICH, theme: 'light', name: 'rich-light', h: 2650 },
  { state: STATE_COLD, theme: 'dark', name: 'cold-dark', h: 1150 },
]
if (STATE_LIVE) jobs.push({ state: STATE_LIVE, theme: 'dark', name: 'live-dark', h: 2400 })
const results = []
for (const j of jobs) {
  const { file } = await render(j.state, j.theme, j.name)
  if (process.env.PREVIEW_NO_SHOT) {
    console.log('html ' + j.name + '  ' + file)
    continue
  }
  const png = path.join(outDir, j.name + '.png')
  const size = shoot(file, png, j.h)
  results.push({ name: j.name, png, size })
  console.log((size ? 'ok   ' : 'FAIL ') + j.name + '  ' + png + (size ? '  ' + Math.round(size / 1024) + 'KB' : ''))
}
console.log('\n输出目录: ' + outDir)
process.exit(0)
