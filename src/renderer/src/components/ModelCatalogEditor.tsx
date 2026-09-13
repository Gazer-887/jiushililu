import { useState } from 'react'
import type { ModelSettings, ReasoningEffort } from '@shared/ipc'
import { entryLabel, type ModelEntry } from '@shared/models'

/**
 * **模型目录编辑器**（plan7 F5.1）。行内 `>` 展开 = 该模型自己的高级设置，只存改过的字段。
 * ① **至少要留一个模型** —— 全删光 = "一条空连接"，删最后一个直接拦住并说明。
 * ② 模型 ID 是**给厂商看的**，一字不差；显示名是**给人看的**，随便起。
 */

const num = (v: string): number => (v === '' ? 0 : Number(v))

function AdvancedPanel({
  entry,
  onChange
}: {
  entry: ModelEntry
  onChange: (patch: Partial<ModelSettings>) => void
}): JSX.Element {
  const s = entry.settings ?? {}
  return (
    <div className="mc-adv">
      <p className="hint">留空 = 跟随端点默认；这几个只影响这个模型。</p>
      <label>
        输出上限（Token）
        <input
          type="number"
          min="1"
          value={s.maxTokens ?? ''}
          placeholder="跟随端点默认"
          onChange={(e) => onChange({ maxTokens: e.target.value === '' ? undefined : num(e.target.value) })}
        />
      </label>
      <label>
        上下文窗口（Token）
        <input
          type="number"
          min="1000"
          value={s.contextWindow ?? ''}
          placeholder="跟随端点默认"
          onChange={(e) => onChange({ contextWindow: e.target.value === '' ? undefined : num(e.target.value) })}
        />
      </label>
      <label>
        思考强度
        <select
          value={s.reasoningEffort ?? ''}
          onChange={(e) =>
            onChange({ reasoningEffort: e.target.value === '' ? undefined : (e.target.value as ReasoningEffort) })
          }
        >
          <option value="">跟随端点默认</option>
          <option value="default">default</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>
      <label>
        工具调用轮数
        <input
          type="number"
          min="1"
          value={s.maxToolRounds ?? ''}
          placeholder="跟随端点默认"
          onChange={(e) => onChange({ maxToolRounds: e.target.value === '' ? undefined : num(e.target.value) })}
        />
      </label>
      <label>
        Temperature（0~2）
        <input
          type="number"
          step="0.1"
          value={s.temperature ?? ''}
          placeholder="留空 = 厂商默认"
          onChange={(e) => onChange({ temperature: e.target.value.trim() === '' ? null : Number(e.target.value) })}
        />
      </label>
      <label>
        Top P（0~1）
        <input
          type="number"
          step="0.05"
          value={s.topP ?? ''}
          placeholder="留空 = 厂商默认"
          onChange={(e) => onChange({ topP: e.target.value.trim() === '' ? null : Number(e.target.value) })}
        />
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={s.supportsImages === true}
          onChange={(e) => onChange({ supportsImages: e.target.checked ? true : undefined })}
        />
        支持图片输入（多模态模型才勾）
      </label>
      <span className="hint inline-hint">Top K 请用端点级或厂商默认：多数端点不认这个参数</span>
    </div>
  )
}

export default function ModelCatalogEditor({
  models,
  onChange,
  onFetch
}: {
  models: ModelEntry[]
  onChange: (next: ModelEntry[]) => void
  /** 「获取可用模型」：由上层调主进程；返回候选 id 列表（失败时给出人话） */
  onFetch?: () => Promise<{ ok: boolean; message: string; models: string[] }>
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [fetching, setFetching] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [picked, setPicked] = useState<string[] | null>(null)

  const patch = (id: string, next: Partial<ModelEntry>): void => {
    onChange(models.map((m) => (m.id === id ? { ...m, ...next } : m)))
  }

  const patchSettings = (id: string, next: Partial<ModelSettings>): void => {
    onChange(
      models.map((m) => {
        if (m.id !== id) return m
        const merged = { ...(m.settings ?? {}), ...next }
        // 清空（undefined）= 回到"跟随端点默认"：把这个键**删掉**而不是留 undefined，
        // 留 undefined 会让 JSON 里出现空洞、也让"改过没有"说不清
        for (const k of Object.keys(merged) as Array<keyof typeof merged>) {
          if (merged[k] === undefined) delete merged[k]
        }
        return { ...m, ...(Object.keys(merged).length > 0 ? { settings: merged } : { settings: undefined }) }
      })
    )
  }

  const add = (): void => {
    const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`
    onChange([...models, { id, model: '' }])
    setExpanded(id)
  }

  const remove = (id: string): void => {
    if (models.length <= 1) {
      setNotice({ ok: false, text: '至少要留一个模型 —— 不然这个端点就成了一条空连接' })
      return
    }
    setNotice(null)
    onChange(models.filter((m) => m.id !== id))
  }

  const doFetch = async (): Promise<void> => {
    if (!onFetch) return
    setFetching(true)
    setNotice(null)
    try {
      const res = await onFetch()
      if (!res.ok || res.models.length === 0) {
        setNotice({ ok: false, text: res.message })
        setPicked(null)
        return
      }
      // 已有的不重复列（用户不该在候选里再选一次已加过的）
      const have = new Set(models.map((m) => m.model))
      const fresh = res.models.filter((m) => !have.has(m))
      if (fresh.length === 0) {
        setNotice({ ok: true, text: `厂商有 ${res.models.length} 个模型，都已经在目录里了` })
        setPicked(null)
        return
      }
      setPicked(fresh)
      setNotice({ ok: true, text: `${res.message}；下面是还没加过的（勾选后点「导入」）` })
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setFetching(false)
    }
  }

  const importPicked = (): void => {
    if (!picked || picked.length === 0) return
    const now = Date.now()
    const added: ModelEntry[] = picked.map((model, i) => ({
      id: `m-${(now + i).toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
      model
    }))
    onChange([...models, ...added])
    setPicked(null)
    setNotice({ ok: true, text: `已加入 ${added.length} 个模型` })
  }

  return (
    <div className="mc">
      <div className="mc-head">
        <span className="mc-title">模型目录</span>
        <span className="mc-head-actions">
          <button
            className="mc-link"
            title="清掉目录，恢复成「只留第一个模型」"
            onClick={() => {
              onChange(models.slice(0, 1))
              setNotice({ ok: true, text: '已恢复成只留第一个模型' })
            }}
          >
            恢复默认模型
          </button>
          <button className="mc-link" disabled={fetching || !onFetch} onClick={() => void doFetch()}>
            {fetching ? '拉取中…' : '获取可用模型'}
          </button>
        </span>
      </div>
      <p className="hint">这一把 Key 能调的模型都放这儿 —— 每个模型还能各自设置高级参数。</p>

      {models.map((m) => (
        <div key={m.id} className={`mc-row ${expanded === m.id ? 'on' : ''}`}>
          <div className="mc-row-main">
            <input
              className="mc-model"
              value={m.model}
              placeholder="模型 ID（与厂商菜单一字不差）"
              onChange={(e) => patch(m.id, { model: e.target.value })}
            />
            <input
              className="mc-name"
              value={m.name ?? ''}
              placeholder="显示名称"
              onChange={(e) => patch(m.id, { name: e.target.value })}
            />
            <button
              className="mc-icon"
              title={expanded === m.id ? '收起高级设置' : '高级设置（只影响这个模型）'}
              onClick={() => setExpanded(expanded === m.id ? null : m.id)}
            >
              {expanded === m.id ? '⌄' : '›'}
            </button>
            <button className="mc-icon mc-del" title="删掉这个模型" onClick={() => remove(m.id)}>
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden focusable="false">
                <path
                  d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
          {expanded === m.id && <AdvancedPanel entry={m} onChange={(p) => patchSettings(m.id, p)} />}
        </div>
      ))}

      <div className="mc-foot">
        <button className="btn-secondary" onClick={add}>
          添加模型
        </button>
        <span className="mc-foot-label">当前用：{entryLabel(models[0] ?? { id: '', model: '' })}</span>
      </div>

      {picked && (
        <div className="mc-import">
          <div className="mc-import-head">
            <span>厂商返回的模型（勾选后导入）</span>
            <button className="btn-secondary" onClick={importPicked}>
              导入选中的 {picked.length} 个
            </button>
          </div>
          <div className="mc-import-list">
            {picked.map((m) => (
              <button
                key={m}
                className="mc-chip"
                onClick={() => {
                  // 点一下即"加进目录"（导入按钮是给"全都要"的人用的）
                  onChange([...models, { id: `m-${Date.now().toString(36)}`, model: m }])
                  setPicked(picked.filter((x) => x !== m))
                }}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}

      {notice && <div className={notice.ok ? 'notice-ok' : 'notice-err'}>{notice.text}</div>}
    </div>
  )
}
