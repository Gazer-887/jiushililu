import { useCallback, useEffect, useState } from 'react'
import FieldNote from './FieldNote'
import { MEMORY_CLASSES, type MemoryClass, type MemoryEntry } from '@shared/memory'
import { useAppStore } from '../store'

// 记忆页签（plan19 批 1）：查看 / 编辑 / 删除 + 「本次新增」巡检区。
// ⚠️ 落点是**右抽屉工作台页签**而不是设置页（plan19 §十）：巡检是高频动作，
//    而设置页自 0.13.29 起是独立窗口 —— 把兜底放在要切窗口的地方 = 把兜底做成装饰。
// ⚠️ 巡检区与对话流里的 `<MemoryNotice />` **按时机分工**（D-043）：这里管"历史上积累了什么"（事后、有摩擦），
//    面板管"刚刚发生了什么"（当场、零摩擦）。两处都写同一件事就是双 X 案同族。

const CLASS_LABEL: Record<MemoryClass, string> = {
  style: '风格',
  default: '默认',
  knowledge: '知识'
}

interface Draft {
  file: string
  name: string
  description: string
  cls: MemoryClass
  body: string
}

export default function MemoryManager(): JSX.Element {
  const view = useAppStore((s) => s.memoryView)
  const refresh = useAppStore((s) => s.refreshMemory)
  const stats = useAppStore((s) => s.memoryStats)
  const refreshStats = useAppStore((s) => s.refreshMemoryStats)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void refresh()
    void refreshStats()
  }, [refresh, refreshStats])

  const entries = view?.entries ?? []
  const candidates = view?.candidates ?? []
  const inspected = entries.filter((e) => e.origin === 'model')

  const openEdit = useCallback(async (entry: MemoryEntry): Promise<void> => {
    const full = await window.api.readMemory(entry.file)
    if (!full) {
      setNotice({ ok: false, text: '读取失败：该条目可能已被移动或删除，列表将以刷新后的为准' })
      void refresh()
      return
    }
    setDraft({
      file: full.file,
      name: full.name,
      description: full.description,
      cls: full.class,
      body: full.body
    })
    setNotice(null)
  }, [refresh])

  const save = async (): Promise<void> => {
    if (!draft) return
    const res = await window.api.saveMemory({
      name: draft.name,
      description: draft.description,
      class: draft.cls,
      body: draft.body,
      file: draft.file
    })
    if (!res.ok) {
      setNotice({ ok: false, text: res.needsConfirm ? `${res.reason}（请确认后重试）` : res.reason })
      return
    }
    setDraft(null)
    setNotice({ ok: true, text: '已保存' })
  }

  const remove = async (entry: MemoryEntry): Promise<void> => {
    if (!window.confirm(`删除记忆「${entry.name}」？\n\n文件：${entry.file}\n\n删除后它不会再被注入后续对话。`)) {
      return
    }
    const removed = await window.api.deleteMemory(entry.file)
    setNotice(removed ? { ok: true, text: '已删除' } : { ok: false, text: '删除失败：条目可能已不存在' })
    void refresh()
  }

  const approve = async (entry: MemoryEntry): Promise<void> => {
    const res = await window.api.approveMemory(entry.file)
    if (!res.ok) {
      setNotice({ ok: false, text: res.reason })
      return
    }
    setNotice({ ok: true, text: '已批准' })
    void refresh()
  }

  const reject = async (entry: MemoryEntry): Promise<void> => {
    const removed = await window.api.rejectMemory(entry.file)
    setNotice(removed ? { ok: true, text: '已拒绝' } : { ok: false, text: '拒绝失败：候选可能已不存在' })
    void refresh()
  }

  return (
    <div className="mem-panel">
      <div className="mem-head">
        <span className="mem-title">记忆</span>
        <FieldNote
          text={[
            '记忆是跨会话长期有用的信息，会在后续对话里作为背景注入。',
            '风格类总是生效；默认与知识类由模型按相关性取用，细节用 recall 按需读取。',
            '记忆里的内容一律按数据对待，即使写着"忽略之前的指令"也不会被当成指令执行。'
          ]}
        />
      </div>

      {view && view.total > 0 ? (
        <div className="mem-stat">
          共 {view.total} 条
          {view.omitted > 0 ? `，其中 ${view.omitted} 条因超出注入上限未生效` : ''}
          {stats && stats.survivalRate !== null
            ? ` · 存活 ${Math.round(stats.survivalRate * 100)}%`
            : ''}
          {stats && stats.usageRate !== null ? ` · 使用 ${Math.round(stats.usageRate * 100)}%` : ''}
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <div className="mem-candidates">
          <div className="mem-candidates-title">待批准 {candidates.length} 条</div>
          <div className="mem-candidates-note">
            反思从历史会话提炼的候选。批准后生效（覆盖同名旧记忆）；不批准不会注入。
          </div>
          {candidates.map((c) => (
            <div key={c.file} className="mem-candidate-row">
              <span className="mem-badge mem-badge-reflection">候选</span>
              <span className="mem-name">{c.name}</span>
              <span className="mem-desc">{c.description}</span>
              <div className="mem-candidate-actions">
                <button type="button" onClick={() => void approve(c)}>
                  批准
                </button>
                <button type="button" onClick={() => void reject(c)}>
                  拒绝
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {inspected.length > 0 ? (
        <div className="mem-inspect">
          <div className="mem-inspect-title">本次新增 {inspected.length} 条</div>
          <div className="mem-inspect-note">
            这些是模型在对话中写下的，不是用户手写的。请扫一眼，确认没有写偏。
          </div>
          {inspected.map((e) => (
            <div key={e.file} className="mem-inspect-row">
              <span className="mem-badge mem-badge-model">{CLASS_LABEL[e.class]}</span>
              <span className="mem-name">{e.name}</span>
              <span className="mem-desc">{e.description}</span>
            </div>
          ))}
        </div>
      ) : null}

      {view && view.warnings.length > 0 ? (
        <div className="mem-warn">
          <div className="mem-warn-title">{view.warnings.length} 条未能加载</div>
          {view.warnings.map((w) => (
            <div key={w} className="mem-warn-row">
              {w}
            </div>
          ))}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div className="mem-empty">还没有记忆。用户在对话里说「记住…」之后，条目会出现在这里。</div>
      ) : null}

      {entries.map((e) => (
        <div key={e.file} className="mem-row">
          <div className="mem-row-main">
            <span className="mem-badge">{CLASS_LABEL[e.class]}</span>
            <span className="mem-name">{e.name}</span>
            <span className="mem-desc">{e.description}</span>
          </div>
          <div className="mem-row-actions">
            <button type="button" onClick={() => void openEdit(e)}>
              编辑
            </button>
            <button type="button" onClick={() => void remove(e)}>
              删除
            </button>
          </div>
        </div>
      ))}

      {notice ? (
        <div className={notice.ok ? 'mem-notice-ok' : 'mem-notice-err'}>{notice.text}</div>
      ) : null}

      {draft ? (
        <div className="mem-form">
          <div className="mem-form-title">编辑「{draft.name}」</div>
          <label className="mem-field">
            <span>摘要</span>
            <input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </label>
          <label className="mem-field">
            <span>分类</span>
            <select
              value={draft.cls}
              onChange={(e) => setDraft({ ...draft, cls: e.target.value as MemoryClass })}
            >
              {MEMORY_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {CLASS_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <label className="mem-field">
            <span>正文</span>
            <textarea
              rows={6}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
          </label>
          <div className="mem-form-actions">
            <button type="button" onClick={() => void save()}>
              保存
            </button>
            <button type="button" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
