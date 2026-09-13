// 内置终端的**共享类型**（plan7 批 C · plan14）
//
// 为什么单独一个文件而不是塞进 `ipc.ts`：渲染层要用这些类型，而**不能** import
// `src/main/terminal-session.ts`（那边 import 了 node:fs，渲染进程不许碰 node）。
// 与 `@shared/checkpoint` 同一个道理：纯类型/纯逻辑放共享层，主进程与界面共用一份口径。

export type TerminalPermission = 'read-only' | 'write' | 'full-access'

/** 一段输出（**带单调序号**） */
export interface TerminalChunk {
  /**
   * **单调递增**序号，从 1 开始。
   *
   * ⚠️ 这是"切走页签再切回来，输出**不重不漏**"的全部依据：渲染层 attach 时拿到
   * `chunks` + `nextSeq`，之后只收 `seq >= nextSeq` 的帧。
   * 靠时序猜（"先重放后订阅"会漏、"先订阅后重放"会重复）是猜不对的 —— 两种写法都错。
   */
  seq: number
  data: string
}

/** 推给渲染层的增量帧（**进程级**通道的载荷，不带会话信封） */
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
  /** 已经产出的输出（**可能因为超限被截掉头部**，那时 `truncated` 为真） */
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
