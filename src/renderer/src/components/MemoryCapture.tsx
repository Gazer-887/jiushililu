import { useState } from 'react'
import { MEMORY_CLASSES, MEMORY_LIMITS, type MemoryClass } from '@shared/memory'

// 通路 B「选中即记」（plan19 §九 批 1）—— **唯一不经过模型的写入通路**。
// 三样价值：① 结构上安全（没有模型参与，提示注入够不着它）② 证据质量最高（用户选中的就是原话）
// ③ `origin: user` 这个高信档位的落点。
//
// ⚠️ 它**只调 `window.api.saveMemory`**，⛔ 不许 import 任何 provider / agent 模块 ——
//    "不经过模型"这条由 `architecture.test.ts` 的守卫丙钉着（人写的规矩会漂，机器钉的不会）。
// ⚠️ 与通路 A 共用**同一个校验口径与同一个事件流**（都在主进程那一条 `saveMemory` 上）。

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

  const save = async (): Promise<void> => {
    setBusy(true)
    const res = await window.api.saveMemory({
      name,
      description,
      class: cls,
      body: props.text,
      origin: 'user',
      // 证据指针在这里**天然精确**：会话与消息序号都是渲染端知道的事实
      evidence: { conversationId: props.conversationId, turnIndex: props.turnIndex }
    })
    setBusy(false)
    props.onDone(
      res.ok
        ? { ok: true, message: `已记住「${name}」` }
        : { ok: false, message: res.needsConfirm ? `${res.reason}（请确认后重试）` : res.reason }
    )
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
          {MEMORY_CLASSES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <div className="mem-capture-actions">
        <button type="button" disabled={busy} onClick={() => void save()}>
          保存
        </button>
        <button type="button" disabled={busy} onClick={() => props.onDone({ ok: false, message: '' })}>
          取消
        </button>
      </div>
    </div>
  )
}
