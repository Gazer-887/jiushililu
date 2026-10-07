// afterPack 钩子（B4 · D-154/D-156 构建链）：把产物里的 better-sqlite3 换成 Electron ABI 的 prebuilt。
// 为什么要换：v12 是按 ABI 编译的非 N-API 绑定，node_modules 里只能放 Node ABI 版（vitest/CI 用）；
// v13 转 N-API 本可一份跨 ABI，但在 Node 20/22 运行时 segfault（上游 #1514 未修，
// Electron 33 内核即 Node 20）⇒ 只能打包时替换产物内那份，node_modules 用 try/finally 保证还原。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

module.exports = async function afterPack(context) {
  const srcPkg = path.join(context.packager.projectDir, 'node_modules', 'better-sqlite3')
  const dstNode = path.join(
    context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3',
    'build', 'Release', 'better_sqlite3.node'
  )
  const srcNode = path.join(srcPkg, 'build', 'Release', 'better_sqlite3.node')
  if (!fs.existsSync(srcNode)) throw new Error(`源二进制缺失：${srcNode}（先 npm install）`)
  if (!fs.existsSync(dstNode)) throw new Error(`产物二进制缺失：${dstNode}（asar smart unpack 未含 better-sqlite3？）`)

  const backup = srcNode + '.nodeabi.bak'
  fs.copyFileSync(srcNode, backup)
  console.log('  • [afterpack-sqlite] 已备份 Node ABI 版 → 还原在 finally 保证')
  try {
    // context.electronVersion 在 afterPack 阶段可能是 undefined（实测）⇒ 版本直接读依赖真源
    const electronVersion = JSON.parse(
      fs.readFileSync(path.join(context.packager.projectDir, 'node_modules', 'electron', 'package.json'), 'utf8')
    ).version
    execFileSync(
      process.execPath,
      [path.join(context.packager.projectDir, 'node_modules', 'prebuild-install', 'bin.js'),
        '-r', 'electron', '-t', electronVersion],
      { cwd: srcPkg, stdio: 'inherit' }
    )
    if (!fs.existsSync(srcNode)) throw new Error('prebuild-install 后源二进制消失（下载/解包失败）')
    fs.copyFileSync(srcNode, dstNode)
    console.log(`  • [afterpack-sqlite] 产物已换 electron-v${electronVersion} prebuilt（${context.arch}）`)
  } finally {
    fs.copyFileSync(backup, srcNode)
    fs.rmSync(backup)
    console.log('  • [afterpack-sqlite] node_modules 已还原为 Node ABI 版')
  }
}
