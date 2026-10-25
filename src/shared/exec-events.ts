// 执行事件流 —— 跨层共享的类型与常量（plan26 D-077）。
// E28：工具卡/任务卡/时间线共用同一套终态文本，避免三处各写一份映射后漂移。

import type { OutcomeCode, RunTerminal, ToolResultState } from './execution-outcome'

export type { OutcomeCode, RunTerminal, ToolResultState } from './execution-outcome'

/** 工具结果终态文本：`outcome` 是细分事实；`code` 只用于把 token/output 截断单独标出。 */
export function toolOutcomeText(outcome?: ToolResultState, code?: OutcomeCode): string {
  if (outcome === 'succeeded') return '成功'
  if (code === 'token-limit' || code === 'output-limit') return '已截断'
  switch (outcome) {
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    case 'denied':
      return '已拒绝'
    case 'unknown':
      return '未确认'
    default:
      return ''
  }
}

/** 任务/运行终态文本：`max-rounds` 不得显示为成功（预算耗尽 ≠ 完成）。 */
export function runTerminalText(terminal?: RunTerminal): string {
  if (!terminal) return ''
  switch (terminal.state) {
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    case 'denied':
      return '已拒绝'
    case 'unknown':
      return '未确认'
    case 'truncated':
      return '已截断'
    case 'max-rounds':
      return '轮次耗尽'
    default:
      return ''
  }
}

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
