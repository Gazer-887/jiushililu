import type { ToolCall } from '@shared/agent'

// 流式工具调用累积器（D-032 核心）：工具调用的参数是**分片到达**的，必须按 index 归位拼接。
// 两家协议形态不同：OpenAI 用 `delta.tool_calls[{index, id?, function:{name?, arguments?}}]`（首片带 id/name、
// 后续片只带 arguments）；Anthropic 用 `content_block_start(tool_use)` 开启 + `content_block_delta(partial_json)` 追加。
// 纯逻辑、零依赖，可直接单测（这是本批正确性风险最高的地方）。
//
// ⚠️ 两套出口，语义不同，别混用：
//   - `finish()`       旧宽松出口，**行为与 E21 基线逐字一致**，供旧调用方/既有测试继续用
//   - `finishStrict()` 生产严格出口，残片/冲突一律拒绝并结构化报告（E22-R1）

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

/**
 * 完整性错误的原因码（E22-R1）。只描述**结构**问题，不携带任何厂商正文 ——
 * 错误对象本身不能成为原文外泄通道。
 */
export type ToolCallIntegrityReason =
  /** Anthropic 的 delta 先于 content_block_start 到达（协议异常，流被污染） */
  | 'missing-start'
  /** 真实工具调用缺少 id */
  | 'missing-id'
  /** 真实工具调用缺少 name */
  | 'missing-name'
  /** 参数拼接完不是合法 JSON */
  | 'invalid-arguments'
  /** 参数是合法 JSON 但根不是对象（数组/字符串/数字/null 都不是工具入参） */
  | 'arguments-not-object'
  /** 同一 index 上出现了不同的 id（先有后换 = 流被污染或重排） */
  | 'id-conflict'
  /** 同一 index 上出现了不同的 name（同上） */
  | 'name-conflict'

/**
 * 工具调用残片/冲突（E22-R1）。
 * ⚠️ **不完整不得静默当成功**：旧 `finish()` 把坏参数原样交出去、把冲突的 id 静默采信后者、
 * 把无 name 残片 filter 成空数组当"没有工具调用" —— 生产路径拿到的是
 * "看起来成功、实际是半截"的结果。严格出口存在的意义就是把这类流**明确拒绝**。
 */
export class ToolCallIntegrityError extends Error {
  readonly reason: ToolCallIntegrityReason
  readonly index: number
  readonly callName: string

  constructor(reason: ToolCallIntegrityReason, index: number, callName: string) {
    // message 只由固定本地映射 + 结构定位信息组成，绝不拼入参数原文
    super(describeIntegrityError(reason, index, callName))
    this.name = 'ToolCallIntegrityError'
    this.reason = reason
    this.index = index
    this.callName = callName
  }
}

function describeIntegrityError(
  reason: ToolCallIntegrityReason,
  index: number,
  callName: string
): string {
  const where = `工具调用 #${index}${callName ? `（${callName}）` : ''}`
  switch (reason) {
    case 'missing-start':
      return `工具调用 #${index} 的参数分片先于开启块到达，流已污染，已拒绝`
    case 'missing-id':
      return `${where} 缺少 id，已拒绝而非生成占位 id`
    case 'missing-name':
      return `工具调用 #${index} 缺少名称，已拒绝而非当作无工具调用`
    case 'invalid-arguments':
      return `${where} 的参数不是合法 JSON，已拒绝而非当作成功`
    case 'arguments-not-object':
      return `${where} 的参数不是 JSON 对象，已拒绝而非当作成功`
    case 'id-conflict':
      return `${where} 在流中出现冲突的 id，已拒绝而非静默采信`
    case 'name-conflict':
      return `${where} 在流中出现冲突的名称，已拒绝而非静默采信`
  }
}

export class ToolCallAccumulator {
  private readonly drafts = new Map<number, ToolCallDraft>()
  /**
   * 已发生但可能被上层吞掉的冲突/协议异常。
   * ⚠️ 为什么需要：provider 的 SSE 回调外面通常包着 `try { ... } catch {}`（用于忽略心跳/注释行），
   * 那里会**静默吞掉** push 阶段抛出的错误。若不另记状态，严格出口就会把被污染的草稿
   * 当成功交出去 —— 正是「不完整不得静默当成功」要防的场景。
   */
  private conflict: { reason: ToolCallIntegrityReason; index: number; callName: string } | null = null

  private record(reason: ToolCallIntegrityReason, index: number, callName: string): never {
    this.conflict = { reason, index, callName }
    throw new ToolCallIntegrityError(reason, index, callName)
  }

  /** 处理一帧 OpenAI 风格的 tool_calls delta（可能同时携带多个 index） */
  pushOpenAI(deltas: OpenAIToolCallDelta[]): void {
    for (const d of deltas) {
      const index = typeof d.index === 'number' ? d.index : this.drafts.size
      const draft = this.drafts.get(index) ?? { id: '', name: '', argsText: '' }
      // 同值重发是协议允许的；只有"先有后换"才算冲突
      if (typeof d.id === 'string' && d.id.length > 0) {
        if (draft.id.length > 0 && draft.id !== d.id) {
          this.record('id-conflict', index, draft.name)
        }
        draft.id = d.id
      }
      if (d.function?.name) {
        if (draft.name.length > 0 && draft.name !== d.function.name) {
          this.record('name-conflict', index, draft.name)
        }
        draft.name = d.function.name
      }
      if (d.function?.arguments) draft.argsText += d.function.arguments
      this.drafts.set(index, draft)
    }
  }

  /** Anthropic：content_block_start 开启一个 tool_use 块（input 可能已含完整对象） */
  startAnthropic(index: number, id: string, name: string, input?: unknown): void {
    const existing = this.drafts.get(index)
    if (existing) {
      // 重复 start 且身份不同 = 流被污染；身份相同则按重发处理（重置为该次 input）
      if (existing.id.length > 0 && existing.id !== id) {
        this.record('id-conflict', index, existing.name)
      }
      if (existing.name.length > 0 && existing.name !== name) {
        this.record('name-conflict', index, existing.name)
      }
    }
    // ⚠️ 明确提供了 input 但不是 plain object（数组/字符串/数字/布尔）→ 记为缺陷，
    // 不能静默当成"无参"。旧 finish() 不读 conflict 故行为不变；strict 会据此拒绝。
    let argsText = ''
    if (input !== undefined && input !== null) {
      if (typeof input !== 'object' || Array.isArray(input)) {
        this.conflict = { reason: 'arguments-not-object', index, callName: name }
      } else if (Object.keys(input).length > 0) {
        argsText = JSON.stringify(input)
      }
    }
    this.drafts.set(index, { id, name, argsText })
  }

  /**
   * Anthropic：content_block_delta 追加参数分片。
   * ⚠️ 未 start 就来的 delta 是**协议异常**：这里仍静默忽略（保持旧行为，不打断既有流），
   * 但会记进 `conflict`，让严格出口 `finishStrict()` 拒绝 —— 宽松与严格各司其职。
   */
  appendAnthropicJson(index: number, partialJson: string): void {
    const draft = this.drafts.get(index)
    if (!draft) {
      this.conflict = { reason: 'missing-start', index, callName: '' }
      return
    }
    draft.argsText += partialJson
  }

  get size(): number {
    return this.drafts.size
  }

  /**
   * **旧宽松出口**（行为与 E21 基线逐字一致）。
   *
   * 按 index 升序；丢弃没有名字的残缺项；缺 id 按 `call_index` 兜底；缺参补 `{}`。
   * 参数不做任何校验，原样交出。
   * ⚠️ 生产路径请用 `finishStrict()` —— 这里会静默容忍半截调用。
   */
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

  /**
   * **生产严格出口**（E22-R1）。残片、冲突、坏参数一律拒绝，绝不静默当成功。
   *
   * 拒绝项：`missing-start` / `missing-id` / `missing-name` /
   * `invalid-arguments` / `arguments-not-object` / `id-conflict` / `name-conflict`。
   *
   * 三条硬规矩：
   * 1. **不 filter 残片后返回 `[]`** —— 那会把"流坏了"伪装成"本轮没有工具调用"
   * 2. **不生成 `call_index` 占位 id** —— 掩盖真实缺陷
   * 3. **不为缺参修补** —— 但 id/name 完整且**完全没有参数分片**时，按合同规范化为 `{}`
   *    （合同原文：「普通无参数工具可为 `{}`」）。这与"掩盖缺陷"不同：无参工具本就合法。
   *
   * 冲突若被上层 `catch {}` 吞掉，这里仍会再抛一次。
   * @throws ToolCallIntegrityError 任一条不满足
   */
  finishStrict(): ToolCall[] {
    if (this.conflict) {
      const { reason, index, callName } = this.conflict
      throw new ToolCallIntegrityError(reason, index, callName)
    }

    const entries = [...this.drafts.entries()].sort((a, b) => a[0] - b[0])
    const calls: ToolCall[] = []
    for (const [index, d] of entries) {
      if (d.name.length === 0) this.record('missing-name', index, '')
      if (d.id.length === 0) this.record('missing-id', index, d.name)

      // 完全没有参数分片 = 普通无参工具，规范化为 {}（合同允许）；有分片则必须是合法 JSON 对象
      const argsText = d.argsText.length === 0 ? '{}' : d.argsText
      let parsed: unknown
      try {
        parsed = JSON.parse(argsText)
      } catch {
        this.record('invalid-arguments', index, d.name)
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        this.record('arguments-not-object', index, d.name)
      }
      calls.push({ id: d.id, name: d.name, arguments: argsText })
    }
    return calls
  }
}
