/**
 * 文档新鲜度闸：出包前核对两张对外文档的版本标记是否等于 package.json。
 * 存在理由：`AGENTS.md` §四 规律 2 ——「以为别的文档会顺带更新的必然落后」。
 * 功能汇表曾落后 33 版而 CHANGELOG 一直新，差别只在后者有硬触发点。这道闸就是把触发点接到 `npm run dist` 上。
 * 只挡出包不进 CI：CI 要挡的是"改动本身坏没坏"，而"对账表追平没追平"属于发版动作。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

/** 每项：文件 → 从文中取出"这张表声称自己是哪个版本"的读法 */
const TARGETS = [
  {
    rel: 'docs/功能汇表.md',
    label: '对账基线',
    // `> 对账基线：**0.13.49 + 未发版增量**（...）` —— 只取第一个 semver
    read: (text) => /对账基线：\*\*(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null
  },
  {
    rel: 'README.md',
    label: '版本标记',
    // `**v0.13.58**` —— 取加粗的那个，正文里提到的历史版本号一律不算声明
    read: (text) => /\*\*v(\d+\.\d+\.\d+)\*\*/.exec(text)?.[1] ?? null
  }
]

const stale = []
for (const t of TARGETS) {
  const file = path.join(ROOT, t.rel)
  if (!fs.existsSync(file)) {
    stale.push(`${t.rel} 不存在（该文件在闸的清单里，要么补文件要么改闸）`)
    continue
  }
  const found = t.read(fs.readFileSync(file, 'utf8'))
  if (found === null) {
    stale.push(`${t.rel}：读不到「${t.label}」的版本号 —— 标记被改写了？闸要先跟上`)
  } else if (found !== version) {
    stale.push(`${t.rel}：${t.label} = ${found}，当前版本 = ${version}（落后即失真）`)
  }
}

if (stale.length > 0) {
  console.error('==== 文档新鲜度闸未过：出包前先追平 ====')
  for (const s of stale) console.error(`  - ${s}`)
  console.error('  要改什么、为什么必须同批改：见 AGENTS.md §四 台账可信度铁律 规律 2。')
  process.exit(1)
}

console.log(`文档新鲜度闸通过：两张对外文档均标 ${version}`)
