import {
  ASK_TIMEOUT_MS,
  type AskAnswer,
  type AskOption,
  type AskRequest,
  type AskResult
} from '@shared/ask'

// Agent 提问桥（「答即继续」），形状照 confirm.ts：待决 Map + 唯一 id 成对响应 + 超时 + abortAll。
// 三条硬约束：① 没人答复（超时/中断）**绝不替用户挑选项**，不得默认第一个 —— 替用户拿主意正是本能力要消灭的；
// ② id 对不上的回执一律忽略（过期或伪造）；③ `values` 必须落在 options 里，界面传脏值只丢不猜。
// ⚠️ 不提供 `hasPending()` 这类自省 API：confirm.ts 里刚删掉过一个全仓零调用点的，它只会让人以为有防线。

export interface AskBridge {
  /** 向用户提问；用户作答即返回答案，未作答（超时 / 窗口不可用 / 中断）返回 answered:false */
  ask(req: Omit<AskRequest, 'id'>): Promise<AskAnswer>
  /** 渲染进程回传作答；返回是否匹配到待决提问（认不出即 false） */
  respond(result: AskResult): boolean
  /** 丢弃全部待决提问（按未作答结束）—— 窗口关闭 / 渲染崩溃时调用 */
  abortAll(reason: string): void
}

export interface AskBridgeDeps {
  /** 把提问推给界面；无法推送（没有窗口）时返回 false */
  send(req: AskRequest): boolean
  /** 日志留痕 */
  log(message: string, extra?: unknown): void
  /** 超时毫秒数（默认 5min）；测试用短超时 */
  timeoutMs?: number
}

export function createAskBridge(deps: AskBridgeDeps): AskBridge {
  interface Pending {
    resolve: (answer: AskAnswer) => void
    timer: ReturnType<typeof setTimeout>
    req: AskRequest
  }
  const pending = new Map<string, Pending>()
  const timeoutMs = deps.timeoutMs ?? ASK_TIMEOUT_MS
  let seq = 0

  /** 回执值 → 选项，按回执顺序保留（多选即点选顺序），重复值只留一次 */
  const pickOptions = (req: AskRequest, values: string[]): AskOption[] => {
    const out: AskOption[] = []
    for (const value of values) {
      const hit = req.options.find((o) => o.value === value)
      if (hit && !out.includes(hit)) out.push(hit)
    }
    return out
  }

  const bridge: AskBridge = {
    ask(base) {
      const id = `a${++seq}-${Date.now().toString(36)}`
      const req: AskRequest = { ...base, id }

      // 推不出去 = 没人能回答：立刻按未作答结束（不留待决，否则这条请求要挂满超时才消失）
      if (!deps.send(req)) {
        deps.log('提问无法送达界面，按未作答处理', { tool: base.tool })
        return Promise.resolve({ answered: false, reason: 'no-window' })
      }

      deps.log('向用户提问', { tool: base.tool, options: base.options.length })

      return new Promise<AskAnswer>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          deps.log('提问超时，按未作答处理（不替用户选）', { tool: base.tool })
          resolve({ answered: false, reason: 'timeout' })
        }, timeoutMs)
        pending.set(id, { resolve, timer, req })
      })
    },

    respond(result) {
      const p = pending.get(result.id)
      if (!p) return false // 过期或伪造的回执，忽略

      // ① **明确跳过最优先**：用户说了"这题我不答"，就不能被降级成"没人答复"（超时）—— 模型要能分清
      //    "用户不要这条路"（可以换路）与"用户没看见"（该重问或往下走）。
      if (result.skip === true) {
        pending.delete(result.id)
        clearTimeout(p.timer)
        deps.log('用户跳过提问（明确不答，按未作答结束）', { tool: p.req.tool })
        p.resolve({ answered: false, reason: 'skipped' })
        return true
      }

      const raw = Array.isArray(result.values) ? result.values : [] // 界面可能缺字段或传 null
      const text = typeof result.text === 'string' ? result.text.trim() : ''
      // ② 自由输入 = **答案本身**：不在 options 里也照样收 —— 这是与下面 ③ 唯一的分支。
      //    ③ 的过滤是"防界面传错值"的护栏，不是拦用户自己写的字；选项与自填并存时两者都带上（见 formatAnswer）。
      if (text.length > 0) {
        const pickedWithText = pickOptions(p.req, raw)
        pending.delete(result.id)
        clearTimeout(p.timer)
        deps.log('用户自填作答', {
          tool: p.req.tool,
          picked: pickedWithText.map((o) => o.value),
          textLen: text.length
        })
        p.resolve({
          answered: true,
          values: pickedWithText.map((o) => o.value),
          labels: pickedWithText.map((o) => o.label),
          text
        })
        return true
      }

      const picked = pickOptions(p.req, raw)
      // 过滤后为空 = 认不出用户选了什么，当作"回执无效"忽略、**继续等**（上限由超时兜底）。
      // 不按未作答结束的理由：那是把界面的一个 bug（传了不在选项里的值）翻译成一个看着正常的结论，
      // 模型会据此往下走；继续等虽然难受，但终点仍是诚实的 timeout。
      if (picked.length === 0) {
        deps.log('提问回执不含任何有效选项，已忽略（继续等）', {
          tool: p.req.tool,
          count: raw.length
        })
        return false
      }

      pending.delete(result.id)
      clearTimeout(p.timer)
      deps.log('用户已回答提问', { tool: p.req.tool, values: picked.map((o) => o.value) })
      p.resolve({
        answered: true,
        values: picked.map((o) => o.value),
        labels: picked.map((o) => o.label)
      })
      return true
    },

    abortAll(reason) {
      for (const [, p] of pending) {
        clearTimeout(p.timer)
        p.resolve({ answered: false, reason: 'aborted' })
      }
      if (pending.size > 0)
        deps.log('丢弃全部待决提问（按未作答）', { reason, count: pending.size })
      pending.clear()
    }
  }

  return bridge
}
