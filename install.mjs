// 安装 dsh-clinepass-guard 到 desktop profile，并卸载第三方 dsh-clinepass。
//
// 需要写 ~/.dsh/**，在 workspace-write 沙箱下会被拒 —— 用 danger-full-access 跑。
//
// 做四件事（都可重复执行）：
//   ① profile package.json：dependencies 加 link:<本目录>，dsh.profile.bundles 加包名
//   ② profile cordis.patch.yml：删掉 dsh-clinepass 的 insert 块，追加 clinepass-guard 行
//   ③ 把 ~/.dsh/profiles/desktop/plugins/dsh-clinepass 移到 ~/.dsh/backups/（先备份，不删）
//   ④ 用宿主自带 pnpm 安装依赖
//
// 所有被改写的文件都先做时间戳备份。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const GUARD_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')
const HOME = process.env.DSH_HOME || (process.env.USERPROFILE + '\\.dsh')
const PROFILE = path.join(HOME, 'profiles', 'desktop')
const PKG_FILE = path.join(PROFILE, 'package.json')
const PATCH_FILE = path.join(PROFILE, 'cordis.patch.yml')
const LEGACY_DIR = path.join(PROFILE, 'plugins', 'dsh-clinepass')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const BACKUP = path.join(HOME, 'backups', 'clinepass-guard-' + STAMP)

const PKG_NAME = 'dsh-clinepass-guard'
const PATCH_ID = 'clinepass-guard'
const PNPM = 'D:\\DeepSeek Harness\\resources\\runtime\\pnpm\\bin\\pnpm.cjs'

const log = (...a) => console.log(...a)

function backup(file) {
  if (!fs.existsSync(file)) return null
  fs.mkdirSync(BACKUP, { recursive: true })
  const dest = path.join(BACKUP, path.basename(file))
  fs.copyFileSync(file, dest)
  return dest
}

// 只允许 node 的 fs 写这两个文件：PowerShell 的 Get-Content/Set-Content 往返会带
// BOM 或 GBK 乱码，而宿主用 JSON.parse / YAML 解析，BOM 会让 profile 直接打不开。
function writeUtf8NoBom(file, text) {
  fs.writeFileSync(file, text, { encoding: 'utf8' })
  const b = fs.readFileSync(file)
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) throw new Error('写出了 BOM：' + file)
}

log('GUARD_DIR = ' + GUARD_DIR)
log('DSH_HOME  = ' + HOME)
if (!fs.existsSync(PKG_FILE)) throw new Error('找不到 profile package.json：' + PKG_FILE)
if (!fs.existsSync(PATCH_FILE)) throw new Error('找不到 cordis.patch.yml：' + PATCH_FILE)
fs.mkdirSync(BACKUP, { recursive: true })

// ── ① package.json ────────────────────────────────────────────────────────
log('\n[1/4] profile package.json')
const pkgBackup = backup(PKG_FILE)
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
const wanted = 'link:' + GUARD_DIR
if (pkg.dependencies[PKG_NAME] !== wanted) {
  log('  dependencies[' + PKG_NAME + '] = ' + wanted)
  pkg.dependencies[PKG_NAME] = wanted
} else log('  dependencies 已是目标值，跳过')

pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const bundles = pkg.dsh.profile.bundles || []
if (bundles.indexOf(PKG_NAME) === -1) {
  // 铁律：bundles 里写 **包名**，不是插件 cordis.patch.yml 里的 insert.id
  bundles.push(PKG_NAME)
  log('  bundles += ' + PKG_NAME)
} else log('  bundles 已含 ' + PKG_NAME + '，跳过')
pkg.dsh.profile.bundles = bundles
writeUtf8NoBom(PKG_FILE, JSON.stringify(pkg, null, 2) + '\n')
log('  备份：' + pkgBackup)

// ── ② cordis.patch.yml ────────────────────────────────────────────────────
log('\n[2/4] profile cordis.patch.yml')
const patchBackup = backup(PATCH_FILE)
let yml = fs.readFileSync(PATCH_FILE, 'utf8')

// 删掉 dsh-clinepass 的 insert 块（它是文件末尾的最后一块）
const marker = yml.indexOf('# ── dsh-clinepass ──')
let legacyRemoved = false
if (marker !== -1) {
  yml = yml.slice(0, marker).replace(/\s+$/, '') + '\n'
  legacyRemoved = true
  log('  已删除 dsh-clinepass 的 insert 块')
} else if (yml.indexOf('id: clinepass\n') !== -1) {
  throw new Error('找到了 clinepass 的 insert 行但没找到它的注释标记，拒绝盲删，请手工检查 ' + PATCH_FILE)
} else log('  没有 dsh-clinepass 的块，跳过')

const guardBlock = [
  '',
  '# ── dsh-clinepass-guard ──────────────────────────────────────────────────',
  '# Cline Pass 上游守卫：按模型注入 providerOptions.gateway.only（只对探测确认可钉的模型，',
  '# 如 deepseek-v4-pro），并用 res.clone() 旁路读回每条真实请求的 finalProvider /',
  '# canonicalSlug / 缓存命中 / 费用，对上游或管道漂移告警。',
  '# 配置落盘在 ~/.dsh/dsh-clinepass-guard.json；面板在「设置 → 上游守卫」。',
  '# 与 dsh-clinepass 的区别：它把钩子做成事后闸门（命中非允许渠道就丢响应），',
  '# 本插件默认只观测 + 对可钉模型注入，strict 拦截是显式可选项。',
  '- id: ' + PATCH_ID,
  "  name: '" + PKG_NAME + "'",
  '',
].join('\n')

if (yml.indexOf('- id: ' + PATCH_ID + '\n') === -1 && yml.indexOf('id: ' + PATCH_ID + '\n') === -1) {
  yml = yml.replace(/\s+$/, '') + '\n' + guardBlock
  log('  已追加 ' + PATCH_ID + ' 条目')
} else log('  已存在 ' + PATCH_ID + ' 条目，跳过')
writeUtf8NoBom(PATCH_FILE, yml)
log('  备份：' + patchBackup)

// ── ③ 移除旧插件目录（先备份）─────────────────────────────────────────────
log('\n[3/4] 卸载 dsh-clinepass 的插件目录')
if (fs.existsSync(LEGACY_DIR)) {
  const dest = path.join(BACKUP, 'plugins', 'dsh-clinepass')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(LEGACY_DIR, dest, { recursive: true })
  fs.rmSync(LEGACY_DIR, { recursive: true, force: true })
  log('  已移到备份：' + dest)
  log('  （原目录 ' + LEGACY_DIR + ' 已删除；要回滚就从备份拷回）')
} else log('  没有 ' + LEGACY_DIR + '，跳过')

// ── ④ pnpm install ────────────────────────────────────────────────────────
log('\n[4/4] 宿主自带 pnpm install')
log('  cwd = ' + PROFILE)
const out = execFileSync(process.execPath, [PNPM, 'install'], {
  cwd: PROFILE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})
log(out.trim() || '(无输出)')

log('\n完成。备份目录：' + BACKUP)
log('legacyRemoved=' + legacyRemoved)
log('\n下一步：完全退出并重启 DSH（宿主按模块路径缓存插件代码，HMR 换不掉 host 半边）。')
