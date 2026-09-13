#!/usr/bin/env node
// 把随包的 ripgrep 复制到 `resources/ripgrep/`（L0 检索，plan3/plan4）。
//
// 为什么要这一步：`@vscode/ripgrep` 走 optionalDependencies 分平台装二进制，
// 而 `electron-builder` 的 `extraResources` 只认**磁盘上的静态路径** ——
// 不能直接引 `node_modules/@vscode/...`（那个目录名带平台后缀，且不打进 asar 的话
// 相对路径在打包后是错的）。所以：**先复制到 resources/，再让构建配置引它**。
//
// ⚠️ 两个容易出事的地方：
// ① 二进制**不能进 asar**（可执行文件在 asar 里没法 spawn）—— 走 extraResources 天生就在 asar 外；
// ② 版本要**钉死**：用户机器上 rg 版本不同会导致"同一个查询两种结果"，随包那份是唯一保证。
//    版本从实际装到的包里读，不手写 —— 手写会和 package.json 漂移。

const { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const PLATFORM = process.platform
const BIN_NAME = PLATFORM === 'win32' ? 'rg.exe' : 'rg'

/** 平台后缀包名：darwin/win32/linux + arch */
function platformPackageName() {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
  return `ripgrep-${PLATFORM}-${arch}`
}

const pkgName = `@vscode/${platformPackageName()}`
const src = join(ROOT, 'node_modules', '@vscode', platformPackageName(), 'bin', BIN_NAME)
const destDir = join(ROOT, 'resources', 'ripgrep')
const dest = join(destDir, BIN_NAME)

if (!existsSync(src)) {
  // CI（ubuntu）上会走到这里：`@vscode/ripgrep` 的 linux 包**可能没装**（optional dep 被跳过）。
  // 这不该让构建失败 —— 检索会降级到内置扫描器，并**在结果里如实说明**。
  // 但要让这件事**看得见**（否则打包出来是个"永远降级"的包，没人知道为什么）。
  console.warn(`[vendor-ripgrep] 未找到 ${pkgName} 的二进制（${src}）`)
  console.warn('[vendor-ripgrep] 打包后 search_files 将降级到内置扫描器（结果里会如实标注）')
  console.warn('[vendor-ripgrep] 若要随包分发，请确认该平台包已安装：npm i -D @vscode/ripgrep')
  process.exit(0)
}

mkdirSync(destDir, { recursive: true })
copyFileSync(src, dest)

const size = statSync(dest).size
const version = readFileSync(join(ROOT, 'node_modules', '@vscode', 'ripgrep', 'package.json'), 'utf8')
  .match(/"version"\s*:\s*"([^"]+)"/)?.[1]
console.log(`[vendor-ripgrep] 已复制 ${BIN_NAME}（${(size / 1024 / 1024).toFixed(1)} MB）→ resources/ripgrep/`)
console.log(`[vendor-ripgrep] 来源：${pkgName} · @vscode/ripgrep@${version ?? '未知'}`)
