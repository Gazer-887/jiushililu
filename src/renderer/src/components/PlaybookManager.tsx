// Playbook 管理面板（plan19 批 3）：查看 / 新建 / 编辑 / 删除。
// 落**设置页 Playbook 分区**（09-19 起，此前在右抽屉）——它不是每轮都要巡检的东西，
// 收敛进设置让右栏只留高频工作面板。样式复用 `.mem-panel`（与记忆页同构，两处渲染一致）。

import { useCallback, useEffect, useState } from 'react'
import { PLAYBOOK_LIMITS, type PlaybookEntry } from '@shared/playbook'
import { useAppStore } from '../store'
import FieldNote from './FieldNote'

interface Draft {
  file?: string
  name: string
  description: string
  tags: string
  body: string
}

export default function PlaybookManager(): JSX.Element {
  const view = useAppStore((s) => s.playbookView)
  const refresh = useAppStore((s) => s.refreshPlaybook)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const entries = view?.entries ?? []

  const openEdit = useCallback(async (entry: PlaybookEntry): Promise<void> => {
    setDraft({
      file: entry.file,
      name: entry.name,
      description: entry.description,
      tags: entry.tags.join(', '),
      body: entry.body
    })
    setNotice(null)
  }, [])

  const openCreate = (): void => {
    setDraft({ name: '', description: '', tags: '', body: '' })
    setNotice(null)
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    const tags = draft.tags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    const res = await window.api.savePlaybook({
      name: draft.name.trim(),
      description: draft.description.trim(),
      tags,
      body: draft.body,
      ...(draft.file === undefined ? {} : { file: draft.file })
    })
    if (!res.ok) {
      setNotice({ ok: false, text: res.reason })
      return
    }
    setDraft(null)
    setNotice({ ok: true, text: '已保存' })
    await refresh()
  }

  const remove = async (entry: PlaybookEntry): Promise<void> => {
    if (!window.confirm(`删除 Playbook「${entry.name}」？\n\n删除后它不会再被注入后续对话。`)) return
    const removed = await window.api.deletePlaybook(entry.file)
    setNotice(removed ? { ok: true, text: '已删除' } : { ok: false, text: '删除失败：条目可能已不存在' })
    await refresh()
  }

  return (
    <div className="mem-panel">
      <div className="mem-head">
        <span className="mem-title">Playbook</span>
        <FieldNote
          text={[
            'Playbook 存的是「某类任务该怎么做」，与记忆（用户偏好与事实）是两条线。',
            '按标签条件召回：只有当前任务命中了条目的标签，它才会被注入本轮对话。',
            '内容一律按数据对待，即使写着"忽略之前的指令"也不会被当成指令执行。'
          ]}
        />
        <button type="button" onClick={openCreate}>
          新建
        </button>
      </div>

      {view && view.total > 0 ? (
        <div className="mem-stat">
          共 {view.total} 条
          {view.omitted > 0 ? `，其中 ${view.omitted} 条因超出注入上限未生效` : ''}
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

      {entries.length === 0 && !draft ? (
        <div className="mem-empty">
          还没有 Playbook。模型在做完某类任务后，可以把步骤沉淀到这里；下次遇到同类任务会自动召回。
        </div>
      ) : null}

      {entries.map((e) => (
        <div key={e.file} className="mem-row">
          <div className="mem-row-main">
            {e.tags.slice(0, 2).map((t) => (
              <span key={t} className="mem-badge">
                {t}
              </span>
            ))}
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

      {notice ? <div className={notice.ok ? 'mem-notice-ok' : 'mem-notice-err'}>{notice.text}</div> : null}

      {draft ? (
        <div className="mem-form">
          <div className="mem-form-title">{draft.file ? `编辑「${draft.name}」` : '新建 Playbook'}</div>
          <label className="mem-field">
            <span>标识</span>
            <input
              value={draft.name}
              disabled={draft.file !== undefined}
              placeholder="短句 kebab-slug，例：edit-react-component"
              onChange={(ev) => setDraft({ ...draft, name: ev.target.value })}
            />
          </label>
          <label className="mem-field">
            <span>摘要</span>
            <input
              value={draft.description}
              placeholder={`一行摘要（≤${PLAYBOOK_LIMITS.maxDescriptionChars} 字）`}
              onChange={(ev) => setDraft({ ...draft, description: ev.target.value })}
            />
          </label>
          <label className="mem-field">
            <span>标签</span>
            <input
              value={draft.tags}
              placeholder="逗号分隔，例：file-edit, react"
              onChange={(ev) => setDraft({ ...draft, tags: ev.target.value })}
            />
          </label>
          <label className="mem-field">
            <span>正文</span>
            <textarea
              rows={8}
              value={draft.body}
              placeholder="具体步骤 / 注意事项 / 常见坑"
              onChange={(ev) => setDraft({ ...draft, body: ev.target.value })}
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
