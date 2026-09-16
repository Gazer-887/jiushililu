import { join } from 'node:path'
import { appendJsonlLine, rotateJsonlIfNeeded } from '../store/jsonl'
import type { FsAdapter } from '../store/conversations-fs'
import {
  EXEC_EVENT_KINDS,
  type AgentScope,
  type ExecEvent,
  type ExecEventKind
} from '@shared/exec-events'

// 跨层共享的**类型与常量**在 `@shared/exec-events`（渲染层/preload 也 import 它）；
// 本模块只管 main 侧的能力：白名单强制的 recorder + fs 落盘 + 读取。
export { EXEC_EVENT_KINDS }
export type { AgentScope, ExecEvent, ExecEventKind }

/**
 * **统一执行事件流**（plan26 D-077）—— 时间线回放的地基。
 *
 * 背景：记忆事件（memory/events.ts）带时间戳落盘，但 Agent 执行过程的痕迹全是残缺的：
 * 工具事件是渲染内存态（每轮清空、重挂载即丢、无时间戳、不落盘）、裁剪/审批只有文本日志。
 * 没有统一事件流，「事件时间线回放」就是无源之水 —— 所以先建流、再建面板。
 *
 * ⚠️ **隐私与体积（白名单口径，判据 2）**：每种 kind 的 payload 字段集合**白名单化**，
 * record 时未列名的 key 直接丢弃。只记元数据（工具名/耗时/字节数/审批结论/droppedCount），
 * **tool_call 入参同属禁区**（write_file 的 content 参数即文件正文）、工具输出正文、
 * 用户消息正文、滚动摘要文本一律不落盘 —— 时间线回放「发生了什么」，正文回看走
 * 既有工具卡片与对话流。全量落盘等于把对话复制一份（体积 + 隐私双输）。
 *
 * ⚠️ **不设 usage kind**（盲审 A P1-4 裁决）：会话 meta 已聚合 token、注入税已在记忆
 * inject 事件 —— exec 流再记 token 就是「同一事实两处存放必然漂移」。
 */

/**
 * 白名单：每种 kind 允许的 payload 字段。**schema 即白名单** —— 负向断言（判据 2）按
 * key 集合断言，不用正文 grep（转义/截断会击穿）。
 */
export const EXEC_PAYLOAD_WHITELIST: Record<ExecEventKind, readonly string[]> = {
  run_start: ['agentName'],
  tool_call: ['tool'],
  tool_result: ['tool', 'ok', 'ms', 'bytes', 'windowed'],
  approve: ['tool', 'allowed', 'reason'],
  trim: ['droppedCount', 'bytes', 'summarized'],
  run_end: ['rounds', 'durationMs', 'stopReason']
}

/** 落盘通道（注入式，单测用内存 sink；主进程用 createFsExecEventSink） */
export interface ExecEventSink {
  append(event: ExecEvent): void
}

export interface ExecEventRecorderOptions {
  sink: ExecEventSink
  conversationId: string
  agentScope: AgentScope
  now?: () => Date
  /** 未列名 key 被丢弃时的留痕（单测断言用；主进程接 log.warn） */
  onDropped?: (kind: ExecEventKind, keys: string[]) => void
}

export interface ExecEventRecorder {
  /** 记一条事件。payload 里不在白名单内的 key 会被**静默丢弃**（计数 + onDropped） */
  record(kind: ExecEventKind, payload?: Record<string, unknown>): void
  readonly conversationId: string
  readonly agentScope: AgentScope
  /** 内部用：派生 scope 的新 recorder 需要同一个落盘通道 */
  readonly sink: ExecEventSink
}

/** 原始 opts（派生 scope 时保留 now/onDropped 等回调）—— WeakMap 不污染公开接口 */
const optsByRecorder = new WeakMap<ExecEventRecorder, ExecEventRecorderOptions>()

export function createExecEventRecorder(opts: ExecEventRecorderOptions): ExecEventRecorder {
  const now = opts.now ?? (() => new Date())
  const rec: ExecEventRecorder = {
    conversationId: opts.conversationId,
    agentScope: opts.agentScope,
    sink: opts.sink,
    record(kind, payload) {
      const list = EXEC_PAYLOAD_WHITELIST[kind]
      const kept: Record<string, unknown> = {}
      const dropped: string[] = []
      for (const [k, v] of Object.entries(payload ?? {})) {
        if (list.includes(k)) kept[k] = v
        else dropped.push(k)
      }
      if (dropped.length > 0) opts.onDropped?.(kind, dropped)
      const event: ExecEvent = {
        at: now().toISOString(),
        kind,
        conversationId: opts.conversationId,
        agentScope: opts.agentScope,
        ...kept
      }
      opts.sink.append(event)
    }
  }
  optsByRecorder.set(rec, opts)
  return rec
}

/** 派生一个同 sink/conversationId、**换 scope** 的 recorder（主代理给子代理用：scheduler 透传时标 'sub'）。
 *  ⚠️ 必须是新建 recorder 而非转发调用 —— 转发会让事件仍带原 scope（单测抓过这个 bug）。 */
export function withAgentScope(recorder: ExecEventRecorder, scope: AgentScope): ExecEventRecorder {
  if (recorder.agentScope === scope) return recorder
  const base = optsByRecorder.get(recorder)
  return createExecEventRecorder({
    ...(base ?? {}),
    sink: recorder.sink,
    conversationId: recorder.conversationId,
    agentScope: scope
  })
}

// ── 落盘 sink ──────────────────────────────────────────────────

/** 执行事件流落 `<userData>/exec-events.jsonl` —— **不落工作区**（用户工作区入 git，
 *  观测数据混进去会出现在 git status 里）；会话过滤靠 conversationId，单文件够用 */
export function execEventsPath(userDataDir: string): string {
  return join(userDataDir, 'exec-events.jsonl')
}

export interface FsExecEventSinkOptions {
  onWarn?: (message: string, extra?: Record<string, unknown>) => void
}

/** fs 落盘 sink：追加 + 轮转（与记忆事件同款三件套），**失败仅告警不阻塞**（观测不许拖垮主链路） */
export function createFsExecEventSink(
  userDataDir: string,
  fs: FsAdapter,
  opts: FsExecEventSinkOptions = {}
): ExecEventSink {
  const warn = opts.onWarn ?? (() => {})
  const path = execEventsPath(userDataDir)
  let broken = false // 首次失败后停止追加（防每次事件都刷一条告警）；应用重启自愈
  return {
    append(event: ExecEvent) {
      if (broken) return
      try {
        rotateJsonlIfNeeded(path, fs)
        fs.mkdirSync(userDataDir, { recursive: true })
        appendJsonlLine(path, JSON.stringify(event), fs)
      } catch (err) {
        broken = true
        warn('执行事件流写入失败（本次运行停止记录，不影响功能）', {
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
  }
}

/**
 * 查询入参净化（`exec-events:list` 的 handler 用它）——渲染端来的 raw 一律不信任：
 * 类型不对就丢弃、limit 收敛到 [1, 5000]。纯函数，可单测。
 */
export function sanitizeExecEventQuery(raw: unknown): { conversationId?: string; limit?: number } {
  const q = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const conversationId =
    typeof q['conversationId'] === 'string' && q['conversationId'].length > 0 ? q['conversationId'] : undefined
  const limit =
    typeof q['limit'] === 'number' && Number.isFinite(q['limit'])
      ? Math.max(1, Math.min(5000, Math.floor(q['limit'])))
      : undefined
  return {
    ...(conversationId ? { conversationId } : {}),
    ...(limit ? { limit } : {})
  }
}

/** 读执行事件（倒序 = 最新在前）。skipped = 坏行数（半行尾/手改）——跳过也是留痕 */
export function readExecEvents(
  userDataDir: string,
  fs: FsAdapter,
  opts: { conversationId?: string; limit?: number } = {}
): { events: ExecEvent[]; skipped: number } {
  const path = execEventsPath(userDataDir)
  if (!fs.existsSync(path)) return { events: [], skipped: 0 }
  const raw = fs.readFileSync(path, 'utf8')
  const all: ExecEvent[] = []
  let skipped = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as ExecEvent
      if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') {
        if (!opts.conversationId || parsed.conversationId === opts.conversationId) all.push(parsed)
      } else {
        skipped++
      }
    } catch {
      skipped++
    }
  }
  const limit = opts.limit ?? 500
  return { events: all.slice(-limit).reverse(), skipped }
}
