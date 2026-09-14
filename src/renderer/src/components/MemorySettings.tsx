import { useEffect, useState } from 'react'
import FieldNote from './FieldNote'

// 记忆设置分区（plan19 批 1）。
// ⚠️ 开关的**批 1 语义只管通路 A**（模型工具 remember / recall 是否下发）：
//    通路 B（选中即记）是用户主动行为，不受它管 —— 关掉开关不该剥夺用户"亲手记一条"的能力。
//    批 2 起它才长出"自动记忆"的语义（额外管反思是否跑），到时用词统一（plan19 §九 批 2）。
// ⚠️ 判据 14：开启时若正处于**完全访问档**，必须**当场**告警 —— 只在设置页躺一行字等于没写。

export default function MemorySettings(): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [warn, setWarn] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.api.getMemorySwitch().then(setEnabled)
  }, [])

  const toggle = async (): Promise<void> => {
    if (enabled === null || saving) return
    setSaving(true)
    const res = await window.api.setMemorySwitch(!enabled)
    setEnabled(res.enabled)
    // 只在"关 → 开"且完全访问档时出现；关回去它就该消失（风险组合不成立了）
    setWarn(res.warnFullAccess)
    setSaving(false)
  }

  return (
    <div className="settings-section">
      <h2>记忆</h2>
      <FieldNote
        text={[
          '记忆是跨会话长期有用的信息，会在后续对话里作为背景注入；可在右栏「记忆」页签查看或删除。',
          '这里管的是「允许模型主动写记忆」。你自己在对话里选中一句话记下来，不受它影响。'
        ]}
      />
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled ?? false}
          disabled={enabled === null || saving}
          onChange={() => void toggle()}
        />
        允许模型写记忆
      </label>
      {warn ? (
        <div className="mem-settings-warn">
          <strong>当前是「完全访问」权限档。</strong>
          <br />
          在这个档位下，模型写下的记忆会**直接参与**后续对话，而该档位本来就**不做逐步确认** ——
          一条被污染的记忆等于给了模型一条不会被拦的指令。建议：改用「可写」档，或到右栏「记忆」页签
          经常巡检。
        </div>
      ) : null}
    </div>
  )
}
