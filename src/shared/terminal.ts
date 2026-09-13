// 内置终端共享类型（plan7 批 C · plan14）。
// 独立成文件是因为渲染层要用这些类型，却**不能** import `src/main/terminal-session.ts`（那边 import 了 node:fs）。

export type TerminalPermission = 'read-only' | 'write' | 'full-access'

export interface TerminalChunk {
  /**
   * ⚠️ 从 1 递增。「切走页签再切回来，输出不重不漏」全靠它：attach 时拿到 `chunks` + `nextSeq`，
   * 之后只收 `seq >= nextSeq`；靠时序猜（先重放后订阅会漏、反之会重）是猜不对的 —— 两种写法都错。
   */
  seq: number
  data: string
}

/** 进程级通道的载荷（不带会话信封） */
export interface TerminalDataPayload {
  sessionId: string
  seq: number
  data: string
}

export interface TerminalSessionSnapshot {
  id: string
  /** 会话创建时的 cwd（= 工作区根） */
  cwd: string
  /** 当前工作区根（界面的"回到工作区"用它） */
  workspaceRoot: string
  /** 给人看的 shell 名字（例如「PowerShell（未加载 profile）」） */
  shell: string
  status: 'running' | 'exited' | 'killed'
  startedAt: number
  endedAt?: number
  exitCode?: number
  cols: number
  rows: number
  /** 可能因超限被截掉头部，那时 `truncated` 为真 */
  chunks: TerminalChunk[]
  /** 下一个会发出去的序号（见 `TerminalChunk.seq`） */
  nextSeq: number
  /** 缓冲被截断过（更早的输出已丢弃，界面要如实说） */
  truncated: boolean
}

export type TerminalFailReason = 'read-only' | 'cwd-missing' | 'spawn-failed'

export type TerminalStartResult =
  | { ok: true; session: TerminalSessionSnapshot }
  | { ok: false; reason: TerminalFailReason; message: string }
