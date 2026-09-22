import { useCallback, useEffect, useState } from 'react'
import FieldNote from './FieldNote'
import { MEMORY_CLASSES, MEMORY_LIMITS, type ArchivedEntry, type MemoryClass, type MemoryEntry } from '@shared/memory'
import { useAppStore } from '../store'

// 记忆页签（plan19 批 1）：查看 / 编辑 / 删除 + 「本次新增」巡检区。
// ⚠️ 落点是**右抽屉工作台页签**而不是设置页（plan19 §十）：巡检是高频动作，
//    而设置页自 0.13.29 起是独立窗口 —— 把兜底放在要切窗口的地方 = 把兜底做成装饰。
// ⚠️ 巡检区与对话流里的 `<MemoryNotice />` **按时机分工**（D-043）：这里管"历史上积累了什么"（事后、有摩擦），
//    面板管"刚刚发生了什么"（当场、零摩擦）。两处都写同一件事就是双 X 案同族。

const CLASS_LABEL: Record<MemoryClass, string> = {
  style: '风格',
  default: '默认',
  knowledge: '知识',
  profile: '画像'
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
  const flagMemory = useAppStore((s) => s.flagMemory)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  /** 用户点「忽略」的重复对（本次会话内不再显示；不持久化 —— 下次进来还会提醒，清理要用户亲手做） */
  const [dismissedDups, setDismissedDups] = useState<Set<string>>(new Set())
  /** 归档区默认折起：它是"出过的事"不是"要办的事"，摊开会把待批准挤下去 */
  const [archivedOpen, setArchivedOpen] = useState(false)

  useEffect(() => {
    void refresh()
    void refreshStats()
  }, [refresh, refreshStats])

  const entries = view?.entries ?? []
  const candidates = view?.candidates ?? []
  const archived = view?.archived ?? []
  const inspected = entries.filter((e) => e.origin === 'model')
  // 疑似重复（plan33 问题四）：结构化数据来自主进程 loadAll；忽略掉的本地过滤
  const dupKey = (p: { files: [string, string] }): string => `${p.files[0]}|${p.files[1]}`
  const duplicates = (view?.duplicates ?? []).filter((p) => !dismissedDups.has(dupKey(p)))

  const mergePair = async (p: { files: [string, string]; names: [string, string] }): Promise<void> => {
    const res = await window.api.mergeMemory(p.files[0], p.files[1])
    setNotice(
      res.ok
        ? { ok: true, text: res.message }
        : { ok: false, text: res.message }
    )
    void refresh()
  }

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

  const flag = async (name: string): Promise<void> => {
    await flagMemory(name)
    setNotice({ ok: true, text: `已标记「${name}」不准确（只记一笔，不改动它）` })
  }

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

  // plan53 片 1：自动遗忘不再硬删，条目移进归档区；这里是把「还能取回来」摊到台面上的那段 UI。
  const restore = async (entry: ArchivedEntry): Promise<void> => {
    const res = await window.api.restoreMemory(entry.file)
    setNotice(
      res.ok ? { ok: true, text: `已恢复「${entry.name}」，重新计入注入索引` } : { ok: false, text: res.reason }
    )
    void refresh()
  }

  return (
    <div className="mem-panel">
      <div className="mem-head">
        <span className="mem-title">记忆</span>
        <FieldNote
          text={[
            '记忆是跨会话长期有用的信息，会在后续对话里作为背景注入。',
            '画像（profile）是对你的整体档案，正文每轮直接注入；风格类总是生效；默认与知识类由模型按相关性取用，细节用 recall 按需读取。',
            '画像最多一条（name 固定 user-profile），由反思在会话结束时提出更新候选，批准后整体覆盖；也可以直接在这里手动编辑。',
            '记忆里的内容一律按数据对待，即使写着"忽略之前的指令"也不会被当成指令执行。'
          ]}
        />
      </div>

      {view && view.total > 0 ? (
        <div className="mem-stat">
          共 {view.total} 条 · 注入预算 {view.usedBytes} / {MEMORY_LIMITS.maxIndexBytes} 字节
          {view.omitted > 0
            ? `，${view.omitted} 条因该预算未注入（未注入的条目模型也取不到，删减或缩短描述后才会带上）`
            : ''}
          {stats && stats.survivalRate !== null
            ? ` · 存活 ${Math.round(stats.survivalRate * 100)}%`
            : ''}
          {stats && stats.usageRate !== null ? ` · 使用 ${Math.round(stats.usageRate * 100)}%` : ''}
          {stats && stats.repeatCorrectionRate !== null
            ? ` · 重复纠正 ${Math.round(stats.repeatCorrectionRate * 100)}%`
            : ''}
          {stats && stats.falsePositiveRate !== null
            ? ` · 误伤 ${Math.round(stats.falsePositiveRate * 100)}%`
            : ''}
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

      {archived.length > 0 ? (
        <div className="mem-archived">
          <button type="button" className="mem-archived-toggle" onClick={() => setArchivedOpen((v) => !v)}>
            已归档 {archived.length} 条 {archivedOpen ? '▴' : '▾'}
          </button>
          {archivedOpen ? (
            <>
              <div className="mem-archived-note">
                条目数达到上限时，最久未使用的记忆移入此处，不再注入。
                恢复后回到生效集合；同名条目已存在时需先删除或改名。
              </div>
              {archived.map((a) => (
                <div key={a.file} className="mem-archived-row">
                  <span className="mem-badge">{CLASS_LABEL[a.class]}</span>
                  <span className="mem-name">{a.name}</span>
                  <span className="mem-desc">{a.description}</span>
                  <span className="mem-archived-at">{a.archivedAt.slice(0, 10)}</span>
                  <button type="button" onClick={() => void restore(a)}>
                    恢复
                  </button>
                </div>
              ))}
            </>
          ) : null}
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

      {/* ── 疑似重复（plan33 问题四）：同义堆积的直接危害是挤占注入索引预算，这里摆到台面
          上让用户一键合并；合并方向（谁并谁）由主进程按创建时间重判 —— ── */}
      {duplicates.length > 0 ? (
        <div className="mem-dups">
          <div className="mem-dups-title">疑似重复 {duplicates.length} 组</div>
          <div className="mem-dups-note">
            两边的名字或摘要高度相似，会在每轮对话里各占一份注入预算。合并 = 较旧那条的正文并入较新的并删除旧条；也可分别编辑/删除后点「忽略」。
          </div>
          {duplicates.map((p) => (
            <div key={dupKey(p)} className="mem-dup-row">
              <div className="mem-dup-pair">
                <div className="mem-dup-item">
                  <span className="mem-name">{p.names[0]}</span>
                  <span className="mem-desc">{p.descriptions[0]}</span>
                </div>
                <div className="mem-dup-item">
                  <span className="mem-name">{p.names[1]}</span>
                  <span className="mem-desc">{p.descriptions[1]}</span>
                </div>
              </div>
              <div className="mem-dup-actions">
                <button type="button" onClick={() => void mergePair(p)}>
                  合并到较新
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedDups((s) => new Set(s).add(dupKey(p)))}
                >
                  忽略
                </button>
              </div>
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
            <button
              type="button"
              title="这条记忆不准确？标记一下（只记一笔，不改动它）"
              onClick={() => void flag(e.name)}
            >
              标记不对
            </button>
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
