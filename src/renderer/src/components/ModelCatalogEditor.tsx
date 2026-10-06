import { useState } from 'react'
import type {
  BudgetEncoding,
  ModelSettings,
  OffEncoding,
  ReasoningConfig,
  ReasoningEffort,
  ReasoningKind
} from '@shared/ipc'
import { BUDGET_ENCODINGS, OFF_ENCODINGS, REASONING_KINDS } from '@shared/ipc'
import {
  INPUT_MODALITIES,
  modalityLabel,
  type InputModality
} from '@shared/content-parts'
import { entryLabel, isDetectionFresh, type ModelEntry } from '@shared/models'
import {
  ADDABLE_EFFORT_LEVELS,
  BUDGET_ENCODING_LABELS,
  OFF_ENCODING_LABELS,
  effortToSend,
  sortEffortLevels
} from '@shared/reasoning'
import FieldNote from './FieldNote'

/**
 * **本应用已接通的模态** —— 设置页只列这些。
 * ⚠️ 加一项之前必须先确认出境通路真的通了（provider 有映射 + 有判据），否则这里出现的就是一个骗人的格子；
 * 厂商收不收由 `inputModalities` 表达，**我们能不能发**由这张表表达，两者不是一回事。
 */
const MODALITY_UI: InputModality[] = ['text', 'image', 'video']

/**
 * 推理等级那一块（plan58 R14 · 形态照 Zcode：chips + `+`，`levels` 收**有序**数组）。
 *
 * 三条形态纪律：
 * ① **`kind` 决定这一块的形状**（R7）：`effort` 档位卡片、`toggle` 开关 + 关闭编码、
 *    `budget_tokens` 预算框 + 预算字段、`none` 只剩一行说明。片② 起三型的出境形状都已接通
 *    （`shared/reasoning.ts`），但"声明了编码"与"端点真吃这一套"仍是两件事 ——
 *    未实测的披露义务不变（R9）。
 * ② **档位集合只认模型自己声明的 `levels`**（R6）。没声明时列我们的已知词表并**如实标「未实测」** ——
 *    我们三家端点的档位支持情况一格都没实测过（plan58 §丁 / R9），不许替厂商下结论。
 * ③ **"设了不等于生效"当场说**（R5）：意图 = 用户选了该档；生效 = `effortToSend` 判定它真会出境。
 *    两者不一致时用 `hint` 直显（照 `SettingsView` 里 trouble 行的既有形态：实时状态不是注释）。
 */

/** 四种形态的界面名（kind 选择器用；「不支持」= `none`，选它整块只剩说明） */
const KIND_LABELS: Record<ReasoningKind, string> = {
  effort: '档位',
  toggle: '开关',
  budget_tokens: '预算',
  none: '不支持'
}

/** 形态选择器。`none` 也必须能从这里改出去 —— 否则选了"不支持"就被锁死在死界面里。 */
function ReasoningKindSelect({
  kind,
  onChangeKind
}: {
  kind: ReasoningKind
  onChangeKind: (next: ReasoningKind) => void
}): JSX.Element {
  return (
    <select
      className="choice-item"
      aria-label="思考形态"
      value={kind}
      onChange={(e) => onChangeKind(e.target.value as ReasoningKind)}
    >
      {REASONING_KINDS.map((k) => (
        <option key={k} value={k}>
          形态：{KIND_LABELS[k]}
        </option>
      ))}
    </select>
  )
}

/** `toggle` 形态：二态开关 + 关闭编码声明（R16）。编码是"厂商方言"⇒ 逐模型声明，应用层不猜。 */
function ToggleControls({
  reasoning,
  onChangeReasoning
}: {
  reasoning: ReasoningConfig | undefined
  onChangeReasoning: (next: ReasoningConfig) => void
}): JSX.Element {
  const on = reasoning?.enabled === true
  const offEnc: OffEncoding = reasoning?.offEncoding ?? 'omit'
  const set = (patch: Partial<ReasoningConfig>): void =>
    onChangeReasoning({ ...reasoning, kind: 'toggle', ...patch })
  return (
    <>
      <div className="choice-list" role="radiogroup" aria-label="思考开关">
        {([true, false] as const).map((v) => (
          <button
            key={String(v)}
            type="button"
            className={`choice-item${on === v ? ' is-on' : ''}`}
            role="radio"
            aria-checked={on === v}
            onClick={() => set({ enabled: v })}
          >
            <span className="choice-name">{v ? '开' : '关'}</span>
          </button>
        ))}
      </div>
      <label>
        关闭编码
        <select aria-label="关闭编码" value={offEnc} onChange={(e) => set({ offEncoding: e.target.value as OffEncoding })}>
          {OFF_ENCODINGS.map((enc) => (
            <option key={enc} value={enc}>
              {OFF_ENCODING_LABELS[enc]}
            </option>
          ))}
        </select>
      </label>
      {!on && offEnc === 'omit' && (
        <p className="hint">未声明关闭编码：对默认开思考的端点，关闭可能不生效。</p>
      )}
    </>
  )
}

/** `budget_tokens` 形态：预算数字框 + 预算字段声明（R15）。 */
function BudgetControls({
  reasoning,
  onChangeReasoning
}: {
  reasoning: ReasoningConfig | undefined
  onChangeReasoning: (next: ReasoningConfig) => void
}): JSX.Element {
  const budget = reasoning?.budget
  const enc = reasoning?.budgetEncoding
  const set = (patch: Partial<ReasoningConfig>): void =>
    onChangeReasoning({ ...reasoning, kind: 'budget_tokens', ...patch })
  return (
    <>
      <label>
        思考预算（Token）
        <input
          type="number"
          min="0"
          aria-label="思考预算"
          value={budget ?? ''}
          placeholder="留空 = 不设置"
          onChange={(e) => {
            const v = e.target.value.trim() === '' ? undefined : Number(e.target.value)
            set({ budget: v })
          }}
        />
      </label>
      <label>
        预算字段
        <select
          aria-label="预算字段"
          value={enc ?? ''}
          onChange={(e) => set({ budgetEncoding: e.target.value === '' ? undefined : (e.target.value as BudgetEncoding) })}
        >
          <option value="">不发送（未声明字段）</option>
          {BUDGET_ENCODINGS.map((b) => (
            <option key={b} value={b}>
              {BUDGET_ENCODING_LABELS[b]}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">
        Anthropic 协议原生发送 thinking.budget_tokens（免声明）；OpenAI 兼容端点须声明字段，未声明时不发送。
      </p>
    </>
  )
}

function ReasoningLevels({
  reasoning,
  effort,
  onChangeReasoning,
  onChangeEffort
}: {
  reasoning: ReasoningConfig | undefined
  effort: ReasoningEffort
  onChangeReasoning: (next: ReasoningConfig | undefined) => void
  onChangeEffort: (eff: ReasoningEffort) => void
}): JSX.Element {
  const kind = reasoning?.kind ?? 'effort'
  const levels = sortEffortLevels(reasoning?.levels ?? [])
  const declared = levels.length > 0
  // 未声明时的候选池：已知词表（+ 用户已经存下来的、强度表里的其它官方档）
  const pool = ADDABLE_EFFORT_LEVELS.filter((l) => !levels.includes(l))
  const unused = effort !== 'default' && !levels.includes(effort)
  // 意图 vs 生效：生效与否走**主进程同一份判定**（`shared/reasoning.ts`），不是界面另算一套
  const effective = effortToSend({ reasoningEffort: effort, reasoning }) !== null
  const wantsThinking = effort !== 'default'

  // 换形态**保留已填的字段**：inert 数据存着无害（出境层保证不发），
  // 替用户清数据 = 偷用户数据（R11′ 否决"界面自动归零"的同一条线）。
  const setKind = (next: ReasoningKind): void =>
    onChangeReasoning(next === 'effort' ? { ...reasoning, kind: 'effort' } : { ...reasoning, kind: next })

  if (kind !== 'effort') {
    return (
      <>
        <ReasoningKindSelect kind={kind} onChangeKind={setKind} />
        {kind === 'none' && (
          <p className="hint">该模型已声明不支持思考：控制项不出现，任何思考字段都不发送。</p>
        )}
        {kind === 'toggle' && <ToggleControls reasoning={reasoning} onChangeReasoning={onChangeReasoning} />}
        {kind === 'budget_tokens' && <BudgetControls reasoning={reasoning} onChangeReasoning={onChangeReasoning} />}
      </>
    )
  }

  const setLevels = (next: string[]): void => {
    onChangeReasoning(next.length > 0 ? { kind: 'effort', levels: next } : { kind: 'effort' })
  }

  return (
    <>
      <ReasoningKindSelect kind={kind} onChangeKind={setKind} />
      {/* 卡片组复用设置页既有形态（`.choice-list` + `.choice-item`：访问权限档 / Token Saver 档位
          用的是同一套，门禁也认）—— 不新造 `.chip`（那个类名已被模型切换器占用）。 */}
      <div className="choice-list" role="radiogroup" aria-label="推理等级">
        {levels.map((l) => (
          <button
            key={l}
            type="button"
            className={`choice-item${effort === l ? ' is-on' : ''}`}
            role="radio"
            aria-checked={effort === l}
            onClick={() => onChangeEffort(l)}
          >
            <span className="choice-name">{l}</span>
          </button>
        ))}
        {pool.length > 0 && (
          <select
            className="choice-item"
            value=""
            aria-label="添加推理等级"
            onChange={(e) => {
              if (!e.target.value) return
              setLevels(sortEffortLevels([...levels, e.target.value]))
              e.target.value = ''
            }}
          >
            <option value="">＋</option>
            {pool.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        )}
      </div>
      {/* 缺陷 4 收口（plan58）：原先"跟随端点默认"与"default"是**两个入口、一个动作**
          （都存成"不发字段"）⇒ 这里只留「恢复默认」一个，且它与上面的档位互斥。
          `default` 是**哨兵不是厂商档**（R8），所以它不进 chips 那一排。 */}
      {declared && (
        <p className="hint">
          <button type="button" className="mc-link" onClick={() => onChangeEffort('default')}>
            恢复默认（不发送思考字段）
          </button>
        </p>
      )}
      {/* 意图 vs 生效：这一行是"设了不等于生效"的实时状态 ⇒ 直显，不收进 ⓘ
          （同 `SettingsView` 里 trouble 行的既有纪律：注释收进 ⓘ，实时状态保留）。 */}
      {wantsThinking && !effective && (
        <p className="hint">
          {unused
            ? `已选 ${effort}，但它不在本模型声明的等级里（${levels.join('、') || '尚未声明'}）—— 不会发往厂商。`
            : '该等级在本模型上未实测：已保存，但厂商是否接受未经逐档验证。'}
        </p>
      )}
    </>
  )
}

const MODALITY_HINT: Record<InputModality, string> = {
  text: '文本输入恒开启，不可关闭。',
  image: '影响：含图片的消息能否发出。未勾选时，含图片的轮次在发送前被拦下并说明原因。',
  video: '影响：含视频的消息能否发出（仅 OpenAI 兼容端点；Anthropic 协议无视频通路）。未勾选时同样发送前拦下。'
}

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
  const rc = s.reasoning
  return (
    <div className="mc-adv">
      <p className="hint">仅影响该模型。</p>
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
      {/* 思考能力（plan58 R7/R13/R14）。`kind` 决定**这一块的形态**，而不是统一给一个下拉：
          `none` ⇒ 整块不出现（该模型不支持思考，摆个下拉是骗人的格子，plan54 #3 同族）。 */}
      {rc?.kind !== 'none' && (
        <>
          <div className="field-label field-label-with-note">
            推理等级
            <FieldNote
              text={[
                '按从低到高排列；档位名取自各厂商官方文档，**同一档名在不同端点上的实际效果我们未逐档实测**。',
                '用「+」添加本模型实际支持的档位，保存后下拉只列你声明过的那些。',
                'Anthropic 端点在带工具调用的轮次不启用思考（该限制来自厂商协议，无法绕开）。'
              ]}
            />
          </div>
          <ReasoningLevels
            reasoning={rc}
            effort={s.reasoningEffort ?? 'default'}
            onChangeReasoning={(next) => onChange({ reasoning: next })}
            onChangeEffort={(eff) => onChange({ reasoningEffort: eff })}
          />
        </>
      )}
      {/* `none` 的逃出口：上面那道门把整块藏了 ⇒ 不在这里再挂一次形态选择器，
          选了"不支持"的模型就被锁死在死界面里（没有回去的路）。 */}
      {rc?.kind === 'none' && (
        <ReasoningKindSelect
          kind="none"
          onChangeKind={(next) => onChange({ reasoning: { ...rc, kind: next } })}
        />
      )}
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
          placeholder="留空表示使用厂商默认值"
          onChange={(e) => onChange({ temperature: e.target.value.trim() === '' ? null : Number(e.target.value) })}
        />
      </label>
      <label>
        Top P（0~1）
        <input
          type="number"
          step="0.05"
          value={s.topP ?? ''}
          placeholder="留空表示使用厂商默认值"
          onChange={(e) => onChange({ topP: e.target.value.trim() === '' ? null : Number(e.target.value) })}
        />
      </label>
      {/* 输入模态（plan57 片⑤ / K55）：取代旧的单勾「图片输入支持」。两条规矩：
          ① `text` 恒选且锁死（没有它这条会话根本发不出去）；
          ② **只列本应用已接通的模态**（`MODALITY_UI` 就是那份名单）—— 未接通的连格子都不出现，
             因为一个"能勾却没有通路"的格子等于骗人（plan54 #3 撤掉旧勾选框正是这个理由）。 */}
      <div className="mc-adv-modality">
        <span className="mc-adv-modality-title">输入模态</span>
        {MODALITY_UI.map((m) => {
          const list = s.inputModalities ?? ['text']
          return (
            <label key={m} className="mc-adv-check" title={MODALITY_HINT[m]}>
              <input
                type="checkbox"
                disabled={m === 'text'}
                checked={list.includes(m)}
                onChange={(e) =>
                  onChange({
                    inputModalities: e.target.checked
                      ? INPUT_MODALITIES.filter((x) => list.includes(x) || x === 'text' || x === m)
                      : list.filter((x) => x !== m)
                  })
                }
              />
              {modalityLabel(m)}
            </label>
          )
        })}
      </div>
      {/* K51 探测注记（B3）：有新鲜探测记录才显 —— 缺失/过期不显示（未探测不是负信息，不占位）。
          文案只讲两件事：官方位说什么 + 手勾为准（§十）。 */}
      {(() => {
        const fresh =
          entry.detectedModalities && isDetectionFresh(entry.detectedAt) ? entry.detectedModalities : null
        if (!fresh) return null
        const days = Math.floor((Date.now() - (entry.detectedAt as number)) / 86400000)
        const ago = days <= 0 ? '今天' : `${days}天前`
        const supports = fresh.includes('image')
        return (
          <span className="hint mc-adv-detected">
            {supports
              ? `官方能力位：支持图片输入（${ago}探测；仍以手勾为准）`
              : `官方能力位：不支持图片输入（${ago}探测；手勾可覆盖）`}
          </span>
        )
      })()}
      <span className="hint inline-hint">Top K 请使用端点级或厂商默认值：多数端点不支持该参数</span>
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
      setNotice({ ok: false, text: '该端点至少要留一个模型 —— 不然它就成了一条空连接' })
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
        setNotice({ ok: true, text: `厂商返回 ${res.models.length} 个模型，均已加入目录` })
        setPicked(null)
        return
      }
      setPicked(fresh)
      setNotice({ ok: true, text: `${res.message}；以下为尚未添加的模型（勾选后点「导入」）` })
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
    setNotice({ ok: true, text: `已添加 ${added.length} 个模型` })
  }

  return (
    <div className="mc">
      <div className="mc-head">
        <span className="mc-title">模型目录</span>
        <span className="mc-head-actions">
          <button
            className="mc-link"
            title="清空目录，仅保留第一个模型"
            onClick={() => {
              onChange(models.slice(0, 1))
              setNotice({ ok: true, text: '已恢复为仅保留第一个模型' })
            }}
          >
            恢复默认模型
          </button>
          <button className="mc-link" disabled={fetching || !onFetch} onClick={() => void doFetch()}>
            {fetching ? '拉取中…' : '获取可用模型'}
          </button>
        </span>
      </div>

      {models.map((m) => (
        <div key={m.id} className={`mc-row ${expanded === m.id ? 'on' : ''}`}>
          <div className="mc-row-main">
            <input
              className="mc-model"
              value={m.model}
              placeholder="模型 ID（须与厂商文档完全一致）"
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
              title={expanded === m.id ? '收起高级设置' : '高级设置（仅影响该模型）'}
              onClick={() => setExpanded(expanded === m.id ? null : m.id)}
            >
              {expanded === m.id ? '⌄' : '›'}
            </button>
            <button className="mc-icon mc-del" title="删除该模型" onClick={() => remove(m.id)}>
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
        <span className="mc-foot-label">当前使用：{entryLabel(models[0] ?? { id: '', model: '' })}</span>
      </div>

      {picked && (
        <div className="mc-import">
          <div className="mc-import-head">
            <span>厂商返回的模型</span>
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
