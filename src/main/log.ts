import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

// 日志系统（plan8 R2）—— 零依赖，写文件 + 控制台，带轮转与敏感信息过滤。
// 为什么必须有：在此之前全项目只有散落的 console，**出问题无法排查**（盲飞）。
// 两条铁律（延续 D-013 / NORMS）：① 绝不写 API Key 或任何凭据（写盘前必过 scrub）；
// ② 轮转有上限，不允许日志无限膨胀。

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** 单个日志文件上限（超过即轮转） */
const MAX_FILE_BYTES = 1024 * 1024
/** 保留的历史文件数（不含当前） */
const MAX_ARCHIVES = 4

const CURRENT_NAME = 'app.log'

let logDir: string | null = null
let minLevel: LogLevel = 'info'
/** 自上次轮转检查以来累计写入的字节数（避免每次写都 statSync） */
let bytesSinceCheck = 0

/** 敏感信息脱敏：**最后一道防线**，写盘前必过（Key 绝不能进日志） */
export function scrub(text: string): string {
  let out = text
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, 'sk-***REDACTED***')
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***REDACTED***')
  out = out.replace(
    /(["']?(?:api[-_]?key|apikey|token|secret|password)["']?\s*[:=]\s*["']?)([A-Za-z0-9._-]{8,})/gi,
    '$1***REDACTED***'
  )
  out = out.replace(/(authorization["']?\s*[:=]\s*["']?)([^\s"',}]{8,})/gi, '$1***REDACTED***')
  return out
}

/** 初始化：指定日志目录（通常 app.getPath('userData')/logs） */
export function initLogger(dir: string, level: LogLevel = 'info'): void {
  minLevel = level
  // 换目录必须重置累计器：它是模块级状态，漂移会让轮转被反复跳过（测试抓到过这个 bug）。
  bytesSinceCheck = 0
  try {
    mkdirSync(dir, { recursive: true })
    logDir = dir
  } catch {
    // 目录建不了也不能让应用起不来——降级为仅控制台
    logDir = null
  }
  rotateIfNeeded()
}

/**
 * 轮转：app.log 超过上限时依次后移（app.1.log ← app.log，app.2.log ← app.1.log …），
 * 超出 MAX_ARCHIVES 的最旧档案删除。全部用重命名/覆盖，逻辑简单可预测。
 *
 * @returns 是否真的执行了轮转（调用方据此决定是否清零字节累计器）
 */
function rotateIfNeeded(): boolean {
  if (!logDir) return false
  const current = join(logDir, CURRENT_NAME)
  try {
    if (!existsSync(current) || statSync(current).size < MAX_FILE_BYTES) return false
  } catch {
    return false
  }

  for (let i = MAX_ARCHIVES; i >= 1; i--) {
    const from = i === 1 ? current : join(logDir, `app.${i - 1}.log`)
    const to = join(logDir, `app.${i}.log`)
    try {
      if (!existsSync(from)) continue
      if (existsSync(to)) unlinkSync(to) // 覆盖同名档案
      renameSync(from, to)
    } catch {
      // 单个档案移动失败不阻塞日志写入
    }
  }
  // 兜底：档案数超过上限时清掉多余的
  try {
    const archives = readdirSync(logDir)
      .filter((f) => /^app\.\d+\.log$/.test(f))
      .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))
    for (const extra of archives.slice(MAX_ARCHIVES)) {
      try {
        unlinkSync(join(logDir, extra))
      } catch {
        // 忽略
      }
    }
  } catch {
    // 忽略
  }
  return true
}

function write(level: LogLevel, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
  const time = new Date().toISOString()
  let line = `[${time}] [${level.toUpperCase()}] [${scope}] ${scrub(message)}`
  if (extra !== undefined) {
    try {
      line += ` ${scrub(JSON.stringify(extra))}`
    } catch {
      line += ' [extra 序列化失败]'
    }
  }

  // 控制台（开发可见）
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  consoleFn(line)

  // 文件（生产留痕）
  if (logDir) {
    try {
      appendFileSync(join(logDir, CURRENT_NAME), line + '\n', 'utf8')
      // 运行期轮转：累计到上限才真去 statSync + 轮转（只在启动时轮转会漏掉长期不重启的会话）
      bytesSinceCheck += Buffer.byteLength(line, 'utf8') + 1
      if (bytesSinceCheck >= MAX_FILE_BYTES) {
        // 轮转成功才清零；没成功（文件其实还没到上限）就保持高位，下次写继续重试
        bytesSinceCheck = rotateIfNeeded() ? 0 : MAX_FILE_BYTES
      }
    } catch {
      // 写失败不能反过来影响主流程
    }
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void
  info(msg: string, extra?: unknown): void
  warn(msg: string, extra?: unknown): void
  error(msg: string, extra?: unknown): void
}

/** 取一个带 scope 的 logger（scope 建议用模块名，如 'agent' / 'ipc'） */
export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e)
  }
}

/** 日志目录（界面「打开日志目录」用）；未初始化返回 null */
export function getLogDir(): string | null {
  return logDir
}

/** 当前日志文件列表（新→旧：app.log 在最前，其后 app.1.log / app.2.log …） */
export function listLogFiles(): string[] {
  if (!logDir || !existsSync(logDir)) return []
  try {
    return readdirSync(logDir)
      .filter((f) => f.endsWith('.log'))
      .sort((a, b) => {
        const n = (f: string): number => (f === CURRENT_NAME ? 0 : Number(f.match(/\d+/)?.[0] ?? 0))
        return n(a) - n(b)
      })
  } catch {
    return []
  }
}
