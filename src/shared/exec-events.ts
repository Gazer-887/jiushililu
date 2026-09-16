/**
 * 执行事件流 —— **跨层共享的类型定义**（plan26 D-077）。
 *
 * 这里是纯类型与常量（渲染层与 preload 都要 import）；recorder/落盘/读取逻辑在
 * `src/main/agent/exec-events.ts`。分层理由与 memory/playbook 同款：shared 只放形状。
 *
 * ⚠️ **隐私口径**：事件的 payload 只含元数据（工具名/耗时/字节数/审批结论/droppedCount），
 * 工具入参、工具输出正文、用户消息正文、摘要文本**一律不进事件流** ——
 * 白名单在 main 侧（EXEC_PAYLOAD_WHITELIST）强制执行，这里只描述形状。
 */

export const EXEC_EVENT_KINDS = ['run_start', 'tool_call', 'tool_result', 'approve', 'trim', 'run_end'] as const

export type ExecEventKind = (typeof EXEC_EVENT_KINDS)[number]

/** 事件归属：主代理 / 子代理 */
export type AgentScope = 'main' | 'sub'

/** 一条执行事件：固定头 + 白名单内 payload（payload 字段随 kind 而定） */
export interface ExecEvent {
  at: string
  kind: ExecEventKind
  conversationId: string
  agentScope: AgentScope
  [key: string]: unknown
}

/** 事件列表查询入参（`execEvents:list`）；都不给 = 全部会话、默认 limit */
export interface ExecEventQuery {
  conversationId?: string
  limit?: number
}

/** 事件列表查询结果（倒序 = 最新在前；`skipped` = 坏行数，跳过也是留痕） */
export interface ExecEventListResult {
  events: ExecEvent[]
  skipped: number
}

/** 界面上每种事件的短标签（时间线一行摘要的 kind 列） */
export const EXEC_EVENT_LABELS: Record<ExecEventKind, string> = {
  run_start: '开始',
  tool_call: '工具调用',
  tool_result: '工具结果',
  approve: '审批',
  trim: '裁剪',
  run_end: '结束'
}
