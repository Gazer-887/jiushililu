// 同步 FS 插桩（plan49 A 档）：一处包装 `node:fs` 的同步函数，罩住主进程全部调用点。
// 为什么不逐个调用点打点：主进程有 110 处同步 fs 调用散在 16 个文件，而面包屑原先只挂
// `ipcMain.handle` ⇒ 这些调用占死事件循环时**零记录**（真凶不可见的技术根因）。
// 与 index.ts 的 IPC 包装器同一条原则：放组合根一处包，不要求每个调用点自觉打点。
// ⚠️ 诊断注入绝不许拖垮启动：安装失败只落 ERROR、照常启动。

import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import { createLogger } from './log'
import { traceSync } from './watchdog'

const log = createLogger('sync-trace')

/** 值得计时的**同步函数类别** —— 不是"当前谁在调"：产物里 lstatSync / readlinkSync /
 *  realpathSync 暂零调用，但它们将来一用就自动纳入，无需回来改这张名单。
 *  ⚠️ 不含 existsSync —— 亚毫秒高频，打了只是冲刷缓冲、抢不到证据。
 *  ⚠️ appendFileSync 在列：它既是真凶候选（exec-events / memory-fs / playbook-fs 每轮同步追写，
 *  且 log.ts 每次落盘都走它），又必须防自反 —— 靠 watchdog 的 `reporting` 闸：诊断通路写日志时
 *  不记账、不递归告警。业务日志的追写则如实入账（低于 50ms 门槛的进不了归属池，不会刷屏）。 */
const TRACED = [
  'readFileSync',
  'writeFileSync',
  'appendFileSync',
  'copyFileSync',
  'readdirSync',
  'statSync',
  'lstatSync',
  'fstatSync',
  'readlinkSync',
  'realpathSync',
  'mkdirSync',
  'rmSync',
  'renameSync',
  'unlinkSync',
  'openSync',
  'closeSync',
  'readSync',
  'writeSync'
] as const

const traced = Symbol.for('jiushililu.sync-trace')

/**
 * 取**可写**的那份 fs 模块对象。
 * `import * as fs` 拿到的是 ESM namespace，属性只读 —— 直接往上写会 TypeError，
 * 整条 A 档静默空转。故走 createRequire 拿 require cache 里的原生对象：
 * 主进程 CJS 产物与它同源（实测 `require('fs') === require('node:fs')` 为 true）。
 * ⚠️ 实测（tmp/verify-fs-patch.cjs）：**ESM named export 是链接期快照，patch 后读不到** ——
 * 主进程产物一旦转 ESM，本插桩会静默失效，只能靠下面的自检与 `n === 0` 报错发现。
 */
function writableFs(): Record<string, unknown> {
  const sep = process.platform === 'win32' ? '\\' : '/'
  const req = createRequire(`${process.cwd()}${sep}sync-trace.cjs`)
  return req('node:fs') as Record<string, unknown>
}

/** 业务代码那份引用（`import * as` 编译产物）：可能与 writableFs() 同源，也可能不是 ——
 *  正是这个"可能不是"要被自检盯住 */
function callersView(): Record<string, unknown> {
  return fs as unknown as Record<string, unknown>
}

/** @returns 本次新包装的函数个数（0 = 已全部包装过或整体装不上，见下方 selfCheck） */
export function installFsSyncTrace(injected?: Record<string, unknown>): number {
  let target: Record<string, unknown>
  try {
    target = injected ?? writableFs()
  } catch (err) {
    log.error('同步 FS 插桩取不到可写模块对象（诊断降级，不影响功能）', {
      message: err instanceof Error ? err.message : String(err)
    })
    return 0
  }
  let n = 0
  let already = 0
  let failed = 0
  for (const name of TRACED) {
    const raw = target[name]
    if (typeof raw !== 'function') continue
    if ((raw as { [traced]?: boolean })[traced]) {
      already++
      continue
    }
    try {
      const fn = raw as (...a: unknown[]) => unknown
      const wrapped = (...a: unknown[]): unknown => traceSync(`fs.${name}`, () => fn(...a))
      // ⚠️ 必须挂原型：`realpathSync.native` 是它自己**独有的属性**，而 guard.ts 的
      // realpathDeepest 用的就是 `.native`。不搬属性 ⇒ 补丁一上，`.native` 变 undefined ⇒
      // 那句裸 catch 把 TypeError 吞掉 ⇒ 软链逃逸检测静默按"未解析的原路径"放行。
      Object.setPrototypeOf(wrapped, fn)
      Object.defineProperty(wrapped, traced, { value: true })
      target[name] = wrapped
      n++
    } catch (err) {
      // 单个属性不可写不影响其余：跳过它，别把整个诊断面搭进去
      failed++
      log.warn(`fs.${name} 插桩失败（该函数不产生同步块证据）`, {
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
  if (n > 0) log.info(`同步 FS 插桩已装上 ${n} 个函数`)
  else if (already === 0 || failed > 0) {
    // 一个都没包上：属性被冻结、或模块对象与调用方拿到的不是同一份引用。
    // 必须报出来 —— 否则下一轮"没抓到"会被读成"没有同步任务"
    log.error('同步 FS 插桩未装上（诊断降级，不影响功能）', { already, failed })
  }
  if (n > 0 && !injected) verifyFromCallersView(target, n)
  return n
}

/**
 * **包上属性 ≠ 罩住调用点**。以业务代码的同一视角（`import * as` 编译出的那份引用）回读，
 * 数一数它看到几个被包过的函数。产物若从 CJS 转成 ESM，named import 是链接期快照，
 * 上面那句写入会对它不可见 —— 那时 n 照样是 17、日志照样"已装上"，而插桩其实全程空转。
 * 这条自检就是把那种"看起来在工作、其实没有"的状态变成一条 ERROR。
 */
function verifyFromCallersView(target: Record<string, unknown>, patched: number): void {
  let seen = 0
  const missing: string[] = []
  for (const name of TRACED) {
    if (typeof target[name] !== 'function' && typeof callersView()[name] !== 'function') continue
    const seenFn = callersView()[name]
    if (typeof seenFn === 'function' && (seenFn as { [traced]?: boolean })[traced]) seen++
    else missing.push(name)
  }
  if (seen > 0 && missing.length === 0) {
    log.info(`同步 FS 插桩经调用方视角复核生效 ${seen} 个`)
  } else {
    log.error('同步 FS 插桩未覆盖调用方视角（插桩可能在空转）', { patched, seen, missing })
  }
}