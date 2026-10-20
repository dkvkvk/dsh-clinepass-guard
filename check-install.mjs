// 安装后自检：静态清单 + 运行时路由。
//
// 运行时会打 http://127.0.0.1:<port>/clinepass-guard/api/state —— 这条路不鉴权，
// 所以 **200 = 插件已加载**，404 = 没加载（改完 profile 清单没重启 DSH 就是 404）。
//
// 端口不写死：DSH 每次启动的桌面端口都会变，这里从 netstat 的自听端口里逐个试，
// 谁先答出 200 就用谁。也可以用 --port 指定。
//
// 关于 profile 的 cordis.patch.yml：**那行 `- id:` 不是必需的**。2026-10-20 实测，
// 插件管理器重写 patch 时会把手加的条目丢掉，而插件照样正常加载 —— 因为
// `dsh.profile.bundles` 写了包名，DSH 会去读包自带的 cordis.patch.yml。
// 所以这里只把它当提示，不算失败。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.DSH_HOME || (process.env.USERPROFILE + '\\.dsh')
const PROFILE = path.join(HOME, 'profiles', 'desktop')
const PKG_FILE = path.join(PROFILE, 'package.json')
const PATCH_FILE = path.join(PROFILE, 'cordis.patch.yml')
const PKG_NAME = 'dsh-clinepass-guard'
const PATCH_ID = 'clinepass-guard'

const portArg = process.argv.indexOf('--port')
const PORT_ARG = portArg !== -1 ? Number(process.argv[portArg + 1]) : null

// DSH 桌面端口每次启动都可能变：从 netstat 的自听端口里找。
function listenPorts() {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 << 20 })
    const set = new Set()
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/i)
      if (m) set.add(Number(m[1]))
    }
    return [...set]
  } catch (_) { return [] }
}

async function resolvePort() {
  if (PORT_ARG) return PORT_ARG
  for (const p of listenPorts()) {
    try {
      const res = await fetch('http://127.0.0.1:' + p + '/clinepass-guard/api/state', { signal: AbortSignal.timeout(1200) })
      if (res.status !== 200) continue
      // 别的服务对任意路径都可能回 200，必须校验响应体确实是守卫的 state
      const st = await res.json()
      if (st && st.ok === true && typeof st.gateway === 'string' && st.hook) return p
    } catch (_) { /* 该端口不是 DSH，或没装本插件 */ }
  }
  return null
}

let pass = 0, fail = 0
const bad = []
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok   ' + label) }
  else { fail++; bad.push(label); console.log('  FAIL ' + label + (detail ? '\n         ' + detail : '')) }
}
function note(label) { console.log('  --   ' + label) }

console.log('DSH_HOME = ' + HOME + '\nprofile  = ' + PROFILE + '\n')

console.log('== 构建产物 ==')
ok(fs.existsSync(path.join(HERE, 'dist', 'native', 'index.js')), 'dist/native/index.js 存在')
ok(fs.existsSync(path.join(HERE, 'dist', 'native', 'client.js')), 'dist/native/client.js 存在')
const guardPkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'))
ok(guardPkg.name === PKG_NAME, 'package.json name = ' + PKG_NAME)
ok(guardPkg.dsh && guardPkg.dsh.bundle && guardPkg.dsh.bundle.patch === './cordis.patch.yml', 'dsh.bundle.patch 已声明')
ok(guardPkg.peerDependencies && guardPkg.peerDependencies.react, 'peerDependencies.react 已声明（宿主据此判兼容性）')

console.log('\n== profile 清单 ==')
if (!fs.existsSync(PKG_FILE)) ok(false, 'profile package.json 存在')
else {
  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'))
  const dep = (pkg.dependencies || {})[PKG_NAME]
  ok(!!dep, 'dependencies 里有 ' + PKG_NAME, '实际：' + JSON.stringify(dep))
  ok(typeof dep === 'string' && dep.indexOf('link:') === 0, '用 link: 指向本地目录', '实际：' + dep)
  const bundles = ((pkg.dsh || {}).profile || {}).bundles || []
  ok(bundles.indexOf(PKG_NAME) !== -1, 'bundles 里有包名 ' + PKG_NAME + '（不是 patch id）')
}

console.log('\n== cordis.patch.yml ==')
if (!fs.existsSync(PATCH_FILE)) note('没有 cordis.patch.yml（不影响：bundles 写包名即可）')
else {
  const yml = fs.readFileSync(PATCH_FILE, 'utf8')
  // 可选：插件管理器重写 patch 时会丢掉这条，插件依然会加载（见文件头注释）
  if (/^\s*-?\s*id:\s*clinepass-guard\s*$/m.test(yml)) ok(true, '有 ' + PATCH_ID + ' 条目（可选，有更好）')
  else note('没有 ' + PATCH_ID + ' 条目 —— 可选，靠 bundles 加载，插件管理器重写 patch 常会丢掉它')
  ok(!/^\s*-?\s*id:\s*clinepass\s*$/m.test(yml), 'dsh-clinepass 的 insert 行已清除')
  ok(yml.indexOf('./plugins/dsh-clinepass') === -1, '没有指向旧插件目录的路径')
  const b = fs.readFileSync(PATCH_FILE)
  ok(!(b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF), '无 BOM（有 BOM 会让 profile 打不开）')
}

console.log('\n== 旧插件目录 ==')
ok(!fs.existsSync(path.join(PROFILE, 'plugins', 'dsh-clinepass')), 'plugins/dsh-clinepass 已移走')

console.log('\n== 运行时（打本机 DSH 的插件路由）==')
const PORT = await resolvePort()
if (PORT === null) {
  ok(false, '找到 DSH 端口', PORT_ARG
    ? '指定的 --port ' + PORT_ARG + ' 上没有插件路由'
    : '已扫描 ' + listenPorts().length + ' 个自听端口，都没有 /clinepass-guard/api/state。'
      + '\n         若刚改完 profile 清单，请完全重启 DSH 后再试；也可用 --port 指定')
} else {
  if (!PORT_ARG) note('自动识别端口 ' + PORT)
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/clinepass-guard/api/state', { signal: AbortSignal.timeout(8000) })
    ok(res.status === 200, 'GET /clinepass-guard/api/state 返回 200（= 插件已加载）', '实际 HTTP ' + res.status)
    if (res.status === 200) {
      let st = null
      try { st = await res.json() } catch (e) { ok(false, '响应是合法 JSON', String((e && e.message) || e)) }
      if (st) {
        ok(st.ok === true, 'state.ok')
        ok(st.hook && st.hook.installed === true, 'fetch 钩子已装')
        console.log('         钩子：' + JSON.stringify(st.hook))
        console.log('         模型：' + (st.models || []).length + ' 个，来源 ' + st.modelsSource)
        console.log('         配置：' + JSON.stringify(st.config))
        console.log('         观测到的模型：' + ((st.live || []).map((v) => v.model + '(' + v.requests + ')').join(', ') || '(无)'))
        console.log('         漂移记录：' + (st.drifts || []).length + ' 条')
        ok(JSON.stringify(st).indexOf('sk_') === -1, 'state 里不含 API key')
      }
    }
  } catch (e) {
    ok(false, '路由可达', String((e && e.message) || e))
  }
}

console.log('\n────────────────────────────────')
console.log('check-install: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail) { console.log('失败项：'); for (const f of bad) console.log('  - ' + f) }
process.exit(fail ? 1 : 0)
