import { useCallback, useEffect, useState } from 'react'
import {
  TOOL_CATALOG,
  TOOL_GROUP_ORDER,
  validateAgentFields,
  type AgentListEntry,
  type AgentSaveInput,
  type AgentsView
} from '@shared/agents'

// 子 Agent 管理分区（plan17 G1）：三层列表（内置 / 自定义 / 项目）+ 表单 CRUD。
// 文件是唯一真相源：表单只是生成/修改 MD 文件的入口，高级用户可手改文件（列表会反映）。
// name 建后不可改（D3）：它是 spawn_agents 引用键、检查点标签、会话绑定键，改名等于删了重建的连锁。

const SOURCE_LABEL: Record<AgentListEntry['source'], string> = {
  builtin: '内置',
  user: '自定义'
}

const EMPTY_FORM: AgentSaveInput = { name: '', description: '', tools: [], systemPrompt: '' }

export default function AgentManager(): JSX.Element {
  const [view, setView] = useState<AgentsView | null>(null)
  const [editing, setEditing] = useState<AgentSaveInput | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const reload = useCallback((): void => {
    void window.api.listAgents().then(setView)
  }, [])

  useEffect(() => {
    reload()
    // save/delete 后主进程广播：所有窗口各自重读（AGENTS.md 多窗口铁律，不搬变更内容）
    return window.api.onAgentsChanged(reload)
  }, [reload])

  const formError = editing ? validateAgentFields(editing) : null

  const openNew = (): void => {
    setEditing({ ...EMPTY_FORM, tools: [] })
    setIsNew(true)
    setNotice(null)
  }

  const openEdit = async (entry: AgentListEntry): Promise<void> => {
    const detail = await window.api.readAgent(entry.file)
    if (!detail) {
      setNotice({ ok: false, text: '读取失败：该文件可能已被移动或删除，列表将以刷新后的为准' })
      reload()
      return
    }
    setEditing(detail)
    setIsNew(false)
    setNotice(null)
  }

  const save = async (): Promise<void> => {
    if (!editing || (formError && !formError.ok)) return
    const res = await window.api.saveAgent(editing)
    if (!res.ok) {
      setNotice({ ok: false, text: res.reason })
      return
    }
    setEditing(null)
    setNotice({ ok: true, text: res.notice ? `已保存。${res.notice}` : '已保存' })
  }

  const remove = async (entry: AgentListEntry): Promise<void> => {
    if (!window.confirm(`删除自定义 Agent「${entry.name}」？\n\n文件：${entry.file}\n\n使用该 Agent 的会话将回退为内核默认。`)) {
      return
    }
    const res = await window.api.deleteAgent(entry.file)
    if (!res.ok) {
      setNotice({ ok: false, text: res.reason })
      return
    }
    setNotice({ ok: true, text: '已删除' })
  }

  const toggleTool = (name: string): void => {
    if (!editing) return
    setEditing({
      ...editing,
      tools: editing.tools.includes(name)
        ? editing.tools.filter((t) => t !== name)
        : [...editing.tools, name]
    })
  }

  const groups = view
    ? ({
        builtin: view.entries.filter((e) => e.source === 'builtin'),
        user: view.entries.filter((e) => e.source === 'user')
      } satisfies Record<AgentListEntry['source'], AgentListEntry[]>)
    : null

  if (editing) {
    return (
      <div className="settings-section">
        <div className="ag-form-head">
          <h3>{isNew ? '新建 Agent' : `编辑「${editing.name}」`}</h3>
          <span className="ag-form-hint">
            保存为 Markdown 定义文件；文件可手动编辑，列表会反映改动。
          </span>
        </div>

        <label className="ag-field">
          <span className="ag-label">名称（name）</span>
          <input
            className="ag-input"
            value={editing.name}
            disabled={!isNew}
            placeholder="小写字母 / 数字 / -，如 code-reviewer"
            onChange={(e) => setEditing({ ...editing, name: e.target.value.trim() })}
          />
          {!isNew && <span className="ag-note">名称创建后不可修改（子代理派发与会话记录都引用它）。</span>}
        </label>

        <label className="ag-field">
          <span className="ag-label">一句话说明（description）</span>
          <input
            className="ag-input"
            value={editing.description}
            placeholder="这个 Agent 负责什么；何时该派给它"
            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
          />
        </label>

        <div className="ag-field">
          <span className="ag-label">可用工具（不选 = 继承除高危外的全部）</span>
          {TOOL_GROUP_ORDER.map((group) => (
            <div key={group} className="ag-tool-group">
              <span className="ag-tool-group-name">{group}</span>
              <div className="ag-tool-items">
                {TOOL_CATALOG.filter((t) => t.group === group).map((t) => (
                  <label key={t.name} className="ag-tool" title={t.description}>
                    <input
                      type="checkbox"
                      checked={editing.tools.includes(t.name)}
                      onChange={() => toggleTool(t.name)}
                    />
                    <span>{t.name}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <label className="ag-field">
          <span className="ag-label">模型偏好（可选）</span>
          <input
            className="ag-input"
            value={editing.model ?? ''}
            placeholder="留空 = 沿用会话当前模型"
            onChange={(e) => setEditing({ ...editing, model: e.target.value.trim() || undefined })}
          />
        </label>

        <div className="ag-field">
          <span className="ag-label">计划批准（可选）</span>
          <label className="ag-tool" title="勾选后，本 Agent 给出方案就停下来等你点头，批准了才接着执行">
            <input
              type="checkbox"
              checked={editing.approval === 'plan'}
              onChange={(e) => setEditing({ ...editing, approval: e.target.checked ? 'plan' : undefined })}
            />
            <span>给出方案后停下等批准，批准了再交下面这个 Agent 执行</span>
          </label>
          {editing.approval === 'plan' && (
            <label className="ag-field ag-subfield">
              <span className="ag-label">执行者（executor，可选）</span>
              <input
                className="ag-input"
                value={editing.executor ?? ''}
                placeholder="留空 = 代码执行员（code-executor）"
                onChange={(e) => setEditing({ ...editing, executor: e.target.value.trim() || undefined })}
              />
            </label>
          )}
          <span className="ag-note">
            批准只决定「要不要接着做」，不改变「能不能写」——全局权限档仍是硬上限；
            只读档下就算批准了，执行者也写不了文件。
          </span>
        </div>

        <label className="ag-field">
          <span className="ag-label">职责描述（作为该 Agent 的系统提示）</span>
          <textarea
            className="ag-textarea"
            rows={10}
            value={editing.systemPrompt}
            placeholder="这个 Agent 应当如何行事、输出什么格式、有什么边界"
            onChange={(e) => setEditing({ ...editing, systemPrompt: e.target.value })}
          />
        </label>

        {formError && !formError.ok && <p className="ag-err">{formError.reason}</p>}
        {notice && <p className={notice.ok ? 'ag-ok' : 'ag-err'}>{notice.text}</p>}

        <div className="ag-actions">
          <button className="ag-btn" onClick={() => setEditing(null)}>
            取消
          </button>
          <button className="ag-btn ag-btn-go" disabled={formError ? !formError.ok : false} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="settings-section">
      <h2>子 Agent</h2>
      <div className="ag-list-head">
        {/* ⓘ 撤除（0.13.41 反馈）：三层来源的规则都写在下面的分组标题与行内标签上，够用了 */}
        <div className="field-label">定义</div>
        <button className="ag-btn ag-btn-go" onClick={openNew}>
          新建 Agent
        </button>
      </div>

      {view && view.warnings.length > 0 && (
        <div className="ag-warn">
          {view.warnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}
      {notice && <p className={notice.ok ? 'ag-ok' : 'ag-err'}>{notice.text}</p>}

      {groups &&
        view &&
        (['user', 'builtin'] as const).map((source) => (
          <div key={source} className="ag-section">
            <div className="ag-section-title">{SOURCE_LABEL[source]}</div>
            {groups[source].length === 0 ? (
              <p className="ag-empty">{source === 'user' ? '暂无自定义Agent' : '无'}</p>
            ) : (
              groups[source].map((e) => (
                <div key={e.file} className="ag-row">
                  <div className="ag-row-main">
                    <span className="ag-name">{e.name}</span>
                    {e.overridden && <span className="ag-tag ag-tag-off">被同名定义覆盖，未生效</span>}
                    {e.source === 'user' && !e.overridden && view.entries.some((x) => x.source === 'builtin' && x.name === e.name) && (
                      <span className="ag-tag">覆盖内置同名定义</span>
                    )}
                  </div>
                  <div className="ag-desc" title={e.description}>
                    {e.description}
                  </div>
                  <div className="ag-meta">
                    工具 {e.tools ? `${e.tools.length} 项（声明）` : '继承全量'}
                    {e.model ? ` · 模型 ${e.model}` : ' · 沿用会话模型'}
                    {e.approval === 'plan' ? ` · 方案需批准（执行：${e.executor ?? 'code-executor'}）` : ''}
                  </div>
                  {e.source === 'user' && (
                    <div className="ag-row-actions">
                      <button className="ag-link" onClick={() => void openEdit(e)}>
                        编辑
                      </button>
                      <button className="ag-link ag-link-del" onClick={() => void remove(e)}>
                        删除
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        ))}
    </div>
  )
}
