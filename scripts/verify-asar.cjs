/**
 * **asar 正反校验**（发版必做的一步）。
 *
 * ## 为什么需要它
 *
 * 打包之后源码被塞进 `app.asar`（一坨二进制），**按文件名搜不到** ——
 * 所以"改动到底进没进包"只能搜**内容特征串**。两个必须守住的点：
 *
 * 1. **特征串必须唯一**。本项目的实际教训：拿"版本号"这种共有前缀当特征串 → **假阳性**
 *    （改没改都"命中"）；后来又发现 asar 里的 `package.json` 是**带缩进**的
 *    （串里少个空格就永远搜不到）。
 * 2. **反向也要查**。只查"新的在不在"，查不出"**旧的没清掉**"——
 *    比如合并写法与覆盖写法同时躺在包里。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-asar.cjs                          # 校验版本号已进包（每次发版必做的那条）
 * node scripts/verify-asar.cjs --in '新代码里的一段字符串'
 * node scripts/verify-asar.cjs --not '被删掉的那段字符串'
 * ```
 *
 * ## 一条前置自检（这个脚本最容易骗人的地方）
 *
 * 正向特征串会**先在 `out/` 构建产物里确认存在**，再去查 asar。为什么必须这样：
 * "asar 里没找到"到底是**没打进去**，还是**我这个串本身就写错了**？两者处置完全不同。
 * 少了这一步，写错一个串就会被读成"打包坏了"，白排查一轮
 * （本项目那条"零命中必须换方法复核"的规矩就是这么来的）。
 */
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = process.cwd()
const ASAR = join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar')

const argv = process.argv.slice(2)
/** 收集 `--flag 值` 形式的参数（可重复） */
const collect = (flag) => {
  const out = []
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === flag) out.push(argv[i + 1])
  }
  return out
}
const positives = collect('--in')
const negatives = collect('--not')

/** 递归收集 `out/` 下的全部构建产物（用于前置自检） */
function outFiles(dir = join(ROOT, 'out'), acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) outFiles(p, acc)
    else acc.push(p)
  }
  return acc
}

function main() {
  if (!existsSync(ASAR)) {
    console.error(`找不到 asar：${ASAR}\n先跑 npm run dist`)
    process.exit(1)
  }
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  // ⚠️ 版本号串**必须带空格**：asar 里的 package.json 是 `"version": "0.13.22"`（带缩进的 JSON）
  const checks = [`"version": "${version}"`, ...positives]
  const asar = readFileSync(ASAR)
  const built = outFiles().map((p) => readFileSync(p).toString('utf8'))
  let failed = 0

  console.log(`asar：${ASAR}（${(asar.length / 1048576).toFixed(1)} MB）`)
  console.log(`版本：${version}\n`)

  for (const s of checks) {
    const inAsar = asar.indexOf(Buffer.from(s, 'utf8')) >= 0
    const inBuilt = built.some((t) => t.includes(s))
    if (!inAsar) failed++
    const why = inAsar
      ? ''
      : inBuilt
        ? '  ← 构建产物里有、asar 里没有 → **真的没打进去**'
        : '  ← 构建产物里也没有 → **这个串本身不对**，不是打包的问题（先复核特征串）'
    console.log(`${inAsar ? '✅' : '❌'} 正向 ${JSON.stringify(s)}${why}`)
  }

  for (const s of negatives) {
    const inAsar = asar.indexOf(Buffer.from(s, 'utf8')) >= 0
    if (inAsar) failed++
    console.log(`${inAsar ? '❌' : '✅'} 反向 ${JSON.stringify(s)}${inAsar ? '  ← 旧代码还在包里' : '  ← 已清掉'}`)
  }

  console.log(failed ? `\n==== 不通过：${failed} 项 ====` : '\n==== 正反校验通过 ====')
  process.exit(failed ? 1 : 0)
}

main()
