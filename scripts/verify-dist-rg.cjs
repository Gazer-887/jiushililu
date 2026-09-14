#!/usr/bin/env node
// 出包后的正向校验（plan8 R16）：dist/win-unpacked 的 asar 外必须真的有能跑的 rg。
//
// 为什么要有这一步：R16 的主题是「脚本报告成功、产物实际不可用」——`vendor:ripgrep` 找不到源包时
// **只告警不失败**（刻意的：CI ubuntu 上不该因缺平台包而阻断构建），坏结果要等到 electron-builder
// 指向的目录缺失才报错，或者更糟——包打出来了、检索**永远静默降级**，没人知道为什么。
// R15 的 asar 特征串校验管「asar 里内容对」，这一条管「asar 外的 rg 真能执行」—— 两级校验拼全。
//
// 只做**正向校验**，不修任何东西：坏了就非零退出，让 `npm run dist` 整体红掉。

const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

const unpacked = join(__dirname, '..', 'dist', 'win-unpacked')
const bin = join(unpacked, 'resources', 'ripgrep', process.platform === 'win32' ? 'rg.exe' : 'rg')

if (!existsSync(bin)) {
  console.error(`[verify-dist-rg] ❌ 出包产物里没有随包 rg：${bin}`)
  console.error('[verify-dist-rg]    search_files 将在打包版里静默降级（plan8 R16 的"报告成功、实际不可用"）')
  console.error('[verify-dist-rg]    修法：先确认 @vscode/ripgrep-<platform> 已安装，再重跑 vendor:ripgrep + dist')
  process.exit(1)
}

const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
if (probe.error || probe.status !== 0 || !String(probe.stdout).includes('ripgrep')) {
  console.error(`[verify-dist-rg] ❌ 随包 rg 存在但跑不起来：${bin}`)
  console.error(`[verify-dist-rg]    error=${probe.error?.message ?? 'null'} status=${probe.status}`)
  process.exit(1)
}

console.log(`[verify-dist-rg] ✅ 随包 rg 可执行：${String(probe.stdout).split('\n')[0].trim()}`)
console.log(`[verify-dist-rg]    位置：${bin}`)
