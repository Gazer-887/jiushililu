import { useState } from 'react'
import { MODEL_MEMORY_CLASSES, MEMORY_LIMITS, type MemoryClass } from '@shared/memory'

// 通路 B「选中即记」（plan19 §九 批 1）—— **唯一不经过模型的写入通路**。
// 三样价值：① 结构上安全（没有模型参与，提示注入够不着它）② 证据质量最高（用户选中的就是原话）
// ③ `origin: user` 这个高信档位的落点。
//
// ⚠️ 它**只调 `window.api.saveMemory`**，⛔ 不许 import 任何 provider / agent 模块 ——
//    "不经过模型"这条由 `architecture.test.ts` 的守卫丙钉着（人写的规矩会漂，机器钉的不会）。
// ⚠️ 与通路 A 共用**同一个校验口径与同一个事件流**（都在主进程那一条 `saveMemory` 上）。
// plan33 问题四：被相似度闸门拦下（`res.similar`）→ 就地给「更新那条 / 仍要另存」二选一，
// 不让用户原样重试（那只会再次被拦），也不静默吞掉。

export interface MemoryCaptureProps {
  /** 用户选中的原文 —— 就是记忆的正文，一字不改 */
  text: string
  conversationId: string
  /** 这条消息在本会话里的序号（证据指针用；渲染端数得准，比模型那侧更硬） */
  turnIndex: number
  onDone: (result: { ok: boolean; message: string }) => void
}

/** 从选中的原文推一个建议名（用户可改；撞名由主进程按人话拒绝） */
function suggestName(text: string): string {
  const head = text.trim().split(/\s+/).join('-').slice(0, 24)
  return head.length > 0 ? head : 'memory'
}

/** 建议摘要：取首行并压到上限内 */
function suggestDescription(text: string): string {
  const line = text.trim().split('\n')[0] ?? ''
  return line.slice(0, MEMORY_LIMITS.maxDescriptionChars)
}

export default function MemoryCapture(props: MemoryCaptureProps): JSX.Element {
  const [name, setName] = useState(suggestName(props.text))
  const [description, setDescription] = useState(suggestDescription(props.text))
  const [cls, setCls] = useState<MemoryClass>('default')
  const [busy, setBusy] = useState(false)
  /** 失败原因就地显示（⛔ 不用 window.alert —— 阻塞渲染进程，自动化探针会被它挂住） */
  const [err, setErr] = useState<string | null>(null)
  /** 相似度闸门拦下的既有条目（plan33）：非空 = 显示「更新那条/仍要另存」二选一 */
  const [dup, setDup] = useState<{ file: string; name: string; description: string } | null>(null)

  const save = async (opts?: { force?: boolean; editFile?: string }): Promise<void> => {
    setBusy(true)
    setErr(null)
    const res = await window.api.saveMemory({
      name,
      description,
      class: cls,
      body: props.text,
      origin: 'user',
      // 证据指针在这里**天然精确**：会话与消息序号都是渲染端知道的事实
      evidence: { conversationId: props.conversationId, turnIndex: props.turnIndex },
      // force = 用户明确选了「仍要另存」；editFile = 用户选了「更新那条」（按 file 编辑既有条目）
      ...(opts?.force ? { force: true } : {}),
      ...(opts?.editFile ? { file: opts.editFile } : {})
    })
    setBusy(false)
    if (!res.ok) {
      if (res.similar) {
        setDup(res.similar)
        return
      }
      // 失败不关卡片：用户改一改（换名字/缩短摘要）就能原地重试
      setErr(res.needsConfirm ? `${res.reason}（请确认后重试）` : res.reason)
      return
    }
    // 成功的"已记住"反馈由护栏 2 的 `<MemoryNotice />` 面板承担（主进程推送），这里静默关闭
    props.onDone({ ok: true, message: '' })
  }

  return (
    <div className="mem-capture">
      <div className="mem-capture-title">记住这句</div>
      <div className="mem-capture-body">{props.text}</div>
      <label className="mem-field">
        <span>名字</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="mem-field">
        <span>摘要</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <label className="mem-field">
        <span>分类</span>
        <select value={cls} onChange={(e) => setCls(e.target.value as MemoryClass)}>
          {/* plan25 D-073：通路 B 不提供画像选项 —— 画像由反思候选或记忆页手动维护产生 */}
          {MODEL_MEMORY_CLASSES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      {dup ? (
        <div className="mem-capture-dup">
          <div className="mem-notice-err">已有相似记忆「{dup.name}」：{dup.description}</div>
          <div className="mem-capture-actions">
            <button type="button" disabled={busy} onClick={() => void save({ editFile: dup.file })}>
              更新那条记忆
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save({ force: true })}
              title="内容确实不同时才选这个 —— 否则记忆库里会堆起同义重复"
            >
              仍要另存为新条
            </button>
          </div>
        </div>
      ) : (
        <>
          {err ? <div className="mem-notice-err">{err}</div> : null}
          <div className="mem-capture-actions">
            <button type="button" disabled={busy} onClick={() => void save()}>
              保存
            </button>
            <button type="button" disabled={busy} onClick={() => props.onDone({ ok: false, message: '' })}>
              取消
            </button>
          </div>
        </>
      )}
    </div>
  )
}
