/**
 * 清扫根目录的 electron-vite 临时配置孤儿（`electron.vite.config.<时间戳>.mjs`）。
 *
 * 生成源：electron-vite 的 loadConfigFormBundledFile 把临时 .mjs 写在 cwd，
 * 正常退出靠 finally 自删，**进程中途被杀就留下孤儿**（每次 dev/build 攒一个）。
 * 本脚本在各命令**前置**执行，让下一次运行自动收走上一次的残骸——不靠人记得。
 *
 * 只删同时满足三个条件的文件，避免误伤并发运行中的临时配置：
 * ① 严格匹配 `electron.vite.config.<纯数字>.mjs` ② 位于仓库根 ③ mtime 早于 10 分钟。
 */
const { readdirSync, statSync, unlinkSync } = require('node:fs')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const PATTERN = /^electron\.vite\.config\.\d+\.mjs$/
const MAX_AGE_MS = 10 * 60 * 1000

let removed = 0
for (const name of readdirSync(ROOT)) {
  if (!PATTERN.test(name)) continue
  const file = join(ROOT, name)
  if (Date.now() - statSync(file).mtimeMs < MAX_AGE_MS) continue
  try {
    unlinkSync(file)
    removed++
  } catch {
    /* 被占用则留给下一次清扫 */
  }
}
if (removed > 0) console.log(`clean-vite-temp: 已清 ${removed} 个临时构建配置`)
