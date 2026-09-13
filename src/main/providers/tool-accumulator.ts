import type { ToolCall } from '@shared/agent'

// 流式工具调用累积器（D-032 核心）：工具调用的参数是**分片到达**的，必须按 index 归位拼接。
// 两家协议形态不同：OpenAI 用 `delta.tool_calls[{index, id?, function:{name?, arguments?}}]`（首片带 id/name、
// 后续片只带 arguments）；Anthropic 用 `content_block_start(tool_use)` 开启 + `content_block_delta(partial_json)` 追加。
// 纯逻辑、零依赖，可直接单测（这是本批正确性风险最高的地方）。

export interface ToolCallDraft {
  id: string
  name: string
  argsText: string
}

interface OpenAIToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

export class ToolCallAccumulator {
  private readonly drafts = new Map<number, ToolCallDraft>()

  /** 处理一帧 OpenAI 风格的 tool_calls delta（可能同时携带多个 index） */
  pushOpenAI(deltas: OpenAIToolCallDelta[]): void {
    for (const d of deltas) {
      const index = typeof d.index === 'number' ? d.index : this.drafts.size
      const draft = this.drafts.get(index) ?? { id: '', name: '', argsText: '' }
      if (typeof d.id === 'string' && d.id.length > 0) draft.id = d.id
      if (d.function?.name) draft.name = d.function.name
      if (d.function?.arguments) draft.argsText += d.function.arguments
      this.drafts.set(index, draft)
    }
  }

  /** Anthropic：content_block_start 开启一个 tool_use 块（input 可能已含完整对象） */
  startAnthropic(index: number, id: string, name: string, input?: unknown): void {
    const argsText =
      input !== undefined && input !== null && typeof input === 'object' && Object.keys(input).length > 0
        ? JSON.stringify(input)
        : ''
    this.drafts.set(index, { id, name, argsText })
  }

  /** Anthropic：content_block_delta 追加参数分片 */
  appendAnthropicJson(index: number, partialJson: string): void {
    const draft = this.drafts.get(index)
    if (!draft) return // 未 start 就来的 delta，按协议不该出现，忽略
    draft.argsText += partialJson
  }

  get size(): number {
    return this.drafts.size
  }

  /** 收尾产出：按 index 升序；丢弃没有名字的残缺项（协议异常时不产生半截调用）；参数缺失给 `{}` 交给工具侧报错 */
  finish(): ToolCall[] {
    return [...this.drafts.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, d]) => d.name.length > 0)
      .map(([index, d]) => ({
        id: d.id || `call_${index}`,
        name: d.name,
        arguments: d.argsText.length > 0 ? d.argsText : '{}'
      }))
  }
}
