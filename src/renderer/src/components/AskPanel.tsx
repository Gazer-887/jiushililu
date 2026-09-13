import { useRef, useState } from 'react'
import { ASK_TIMEOUT_MS, type AskRequest, type AskResult } from '@shared/ask'
import { useAppStore } from '../store'

/**
 * Agent 提问卡片（输入框上方，**非模态**）：模型拿不定主意时问一句，用户点一下就作答。
 * 卡内自上而下：小标题 + 发起方 → 问题 → 选项行（整行可点，主文案 + 说明） → 自由输入框 → 底部操作栏。
 * 三条纪律：① **排队不覆盖** —— 并发多条提问先进先出，答复按**该条的 id** 配对（单槽 state 会让用户
 * 读着 A 的问题、点下的却是 B 的选项）；② **答完留痕** —— 卡片转只读并标出选了什么；③ **不把用户堵在
 * 选项上** —— 自由输入是**真答案**（`AskResult.text`，不必是选项），另有「跳过本题」这条明路。
 */

/** 已作答的卡片最多留几张：输入框上方是公共空间，堆满会把输入框顶走 */
const KEEP_ANSWERED = 3

/** 一条已处理的提问（卡片转只读，留住"我当时选了什么 / 我跳过了"的记录） */
interface Answered {
  req: AskRequest
  /** 选中的选项值；纯自填或跳过时为空 */
  values: string[]
  /** 用户自己写的那段字（原样留痕） */
  text?: string
  skipped?: boolean
  /** 主进程没认领这次答复（已超时 / 已被中断）—— 选择照记，但要说清"没送到" */
  stale?: boolean
}

/** 四种结局说的话必须不同 —— 把"跳过""没送到"说成"已送达"就是那类假账 */
function noteOf(a: Answered): string {
  if (a.stale) return '主进程没认领这次答复（可能已经超时或被中断）：上面记着你的选择，但模型不一定收得到。'
  if (a.skipped) return '已跳过这题：模型会看到「用户跳过了这个问题」，按未作答继续 —— 不是超时，也不会替你选。'
  if (a.text) return '已经把回答交给了模型：自填的文字原样送出。'
  return '模型已经拿到这个答复，正接着往下做。'
}

export default function AskPanel(): JSX.Element | null {
  const asks = useAppStore((s) => s.asks)
  const dropAsk = useAppStore((s) => s.dropAsk)
  const conversations = useAppStore((s) => s.conversations)
  const activeId = useAppStore((s) => s.activeId)
  const [answered, setAnswered] = useState<Answered[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [free, setFree] = useState('')
  const [busy, setBusy] = useState(false)
  /** 拦**同一个 tick 内**的第二次提交：`busy` 是 state，第二次点击时它还没生效 */
  const lock = useRef(false)

  const head = asks[0] ?? null
  if (!head && answered.length === 0) return null

  const multi = head?.multiSelect === true
  const text = free.trim()

  /** 按 id 收尾：摘队 + 转只读留痕。队列里其余几条**不动** —— 它们各有各的 id 与选项 */
  const settle = (id: string, patch: Partial<Answered>): void => {
    const hit = asks.find((a) => a.id === id)
    if (hit) {
      setAnswered((list) => [{ req: hit, values: [], ...patch }, ...list].slice(0, KEEP_ANSWERED))
    }
    dropAsk(id)
    setChecked([])
    setFree('')
    setBusy(false)
    lock.current = false
  }

  /** 交答案：有选择交选择、有自填交自填，两者都有就都带上（桥按 `skip` > `text` > `values` 的优先级处理） */
  const submit = async (values: string[]): Promise<void> => {
    const entry = asks[0]
    if (!entry || lock.current) return
    if (values.length === 0 && text.length === 0) return // 没选也没写：提交键已禁用，这里是第二道闸
    lock.current = true
    setBusy(true)
    const payload: AskResult = { id: entry.id, values, ...(text.length > 0 ? { text } : {}) }
    const ok = await window.api.respondAsk(payload).catch(() => false)
    settle(entry.id, { values, ...(text.length > 0 ? { text } : {}), ...(ok ? {} : { stale: true }) })
  }

  /** 跳过本题 = 用户**明确**不答：走 `skip` 回执（既不是超时，也不是把空数组当脏值丢掉） */
  const skip = async (): Promise<void> => {
    const entry = asks[0]
    if (!entry || lock.current) return
    lock.current = true
    setBusy(true)
    const ok = await window.api
      .respondAsk({ id: entry.id, values: [], skip: true })
      .catch(() => false)
    settle(entry.id, { skipped: true, ...(ok ? {} : { stale: true }) })
  }

  /** 单选：点整行 = **直接作答**；多选：点整行 = 勾 / 取消，攒够了再点「提交」 */
  const clickRow = (value: string): void => {
    if (multi) {
      setChecked((c) => (c.includes(value) ? c.filter((v) => v !== value) : [...c, value]))
      return
    }
    void submit([value])
  }

  /** 不是当前会话的提问要标出来 —— 否则用户以为自己在答眼前这条会话的问题 */
  const fromLabel = (req: AskRequest): string | null => {
    if (!req.conversationId || req.conversationId === activeId) return null
    return conversations.find((c) => c.id === req.conversationId)?.title ?? req.conversationId
  }

  const from = head ? fromLabel(head) : null
  /** 勾选框形状：单选圆框、多选方框（同一套记号，只有形状不同） */
  const markOf = (on: boolean): string =>
    `ask-mark ${multi ? 'ask-mark-square' : 'ask-mark-round'}${on ? ' ask-mark-on' : ''}`
  const canSubmit = checked.length > 0 || text.length > 0

  return (
    <div className="ask-panel">
      {head && (
        <div className="ask-card" data-ask-id={head.id}>
          <div className="ask-head">
            <span className="ask-title">需要你决定</span>
            <span className="ask-tool">{head.tool ?? 'ask_user'}</span>
          </div>
          {from && <p className="ask-from">来自会话：{from}</p>}

          <p className="ask-q">{head.question}</p>

          <div className="ask-rows">
            {head.options.map((o) => {
              const on = checked.includes(o.value)
              return (
                <button
                  key={o.value}
                  type="button"
                  className={on ? 'ask-row ask-row-on' : 'ask-row'}
                  disabled={busy}
                  onClick={() => clickRow(o.value)}
                >
                  <span className={markOf(on)} aria-hidden="true">
                    {on ? '✓' : ''}
                  </span>
                  <span className="ask-opt-text">
                    <span className="ask-opt-label">{o.label}</span>
                    {o.description && <span className="ask-opt-desc">{o.description}</span>}
                  </span>
                </button>
              )
            })}
          </div>

          <input
            className="ask-free-input"
            value={free}
            placeholder="输入你的答案"
            disabled={busy}
            onChange={(e) => setFree(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit(checked)
            }}
          />

          <div className="ask-actions">
            <button className="ask-skip" type="button" disabled={busy} onClick={() => void skip()}>
              跳过本题
            </button>
            {/* 一次只问一道题（多题分页留给将来），故这里恒为 1/1 */}
            <span className="ask-count">1/1</span>
            <button
              className="ask-submit"
              type="button"
              disabled={busy || !canSubmit}
              onClick={() => void submit(checked)}
            >
              提交
            </button>
          </div>

          {asks.length > 1 && (
            <p className="ask-note">还有 {asks.length - 1} 条提问在排队，这条答复后就轮到它</p>
          )}
          {/* 写清"不答会怎样"（同 ConfirmDialog 的到期说明）：不等 ≠ 默许，这条必须让用户看见 */}
          <p className="ask-note">
            {Math.round(ASK_TIMEOUT_MS / 60000)} 分钟内不答复 → 模型收到「没有回答」并继续往下走，不会默认替你选
          </p>
        </div>
      )}

      {answered.map((a) => (
        <div className="ask-card ask-done" key={a.req.id} data-ask-id={a.req.id}>
          <div className="ask-head">
            <span className="ask-title">
              {a.skipped ? '已跳过本题' : a.stale ? '答复没送到' : '已回答'}
            </span>
            <span className="ask-tool">{a.req.tool ?? 'ask_user'}</span>
          </div>

          <p className="ask-q">{a.req.question}</p>

          <div className="ask-rows">
            {a.req.options.map((o) => {
              const picked = a.values.includes(o.value)
              return (
                <div
                  key={o.value}
                  className={picked ? 'ask-row ask-row-done ask-row-on' : 'ask-row ask-row-done'}
                >
                  <span
                    className={`ask-mark ${
                      a.req.multiSelect ? 'ask-mark-square' : 'ask-mark-round'
                    }${picked ? ' ask-mark-on' : ''}`}
                    aria-hidden="true"
                  >
                    {picked ? '✓' : ''}
                  </span>
                  <span className="ask-opt-text">
                    <span className="ask-opt-label">{o.label}</span>
                    {o.description && <span className="ask-opt-desc">{o.description}</span>}
                  </span>
                </div>
              )
            })}
          </div>

          {a.text && <p className="ask-answer-text">你的回答：{a.text}</p>}
          <p className="ask-note">{noteOf(a)}</p>
        </div>
      ))}
    </div>
  )
}
