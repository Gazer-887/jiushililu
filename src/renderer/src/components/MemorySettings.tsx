import { useEffect, useState } from 'react'
import MemoryImportDialog from './MemoryImportDialog'
import { MEMORY_LIMITS } from '@shared/memory'

// 记忆设置分区（plan19 批 1 / 0.13.41 反馈改版）。
// ⚠️ 开关的**批 1 语义只管通路 A**（模型工具 remember / recall 是否下发）：
//    通路 B（选中即记）是用户主动行为，不受它管 —— 关掉开关不该剥夺用户"亲手记一条"的能力。
//    批 2 起它才长出"自动记忆"的语义（额外管反思是否跑），到时用词统一（plan19 §九 批 2）。
// ⚠️ 判据 14：开启时若正处于**完全访问档**，必须**当场**告警 —— 只在设置页躺一行字等于没写。
// ⚠️ 0.13.41 反馈：注释**不收 ⓘ**，直接排成文字（参考 WorkBuddy 记忆页的排版）；并新增「导入其他记忆」。

export default function MemorySettings(): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [warn, setWarn] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)

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

      {/* 直接注释（0.13.41 反馈：不用 ⓘ 收纳）。三句话把"是什么/去哪管/边界"说完 */}
      <p className="mem-settings-lead">
        记忆让应用跨会话记住你的偏好与项目事实，后续对话自动生效。
        查看与管理在主界面右栏的「记忆」页签；导入的记忆同样可以在那里编辑或删除。
      </p>
      <p className="mem-settings-lead mem-settings-lead-muted">
        安全边界（如实）：模型可写的记忆受三道防线约束（架构守卫 / 授权语义拒写 / 凭据硬拒），
        但防线是必要非充分条件；记忆内容会作为背景注入后续对话，也是本机明文文件。请养成巡检习惯。
      </p>

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

      <div className="mem-import-card">
        <div className="mem-import-card-main">
          <div className="mem-import-card-title">导入其他记忆</div>
          <div className="mem-import-card-desc">
            把其它 AI 工具里关于你的长期信息搬过来：两步 —— 复制提示词到那个 AI 对话，再把它的回答粘贴回来。
            单条上限 {MEMORY_LIMITS.maxDescriptionChars} 字摘要 /{' '}
            {Math.round(MEMORY_LIMITS.maxBodyBytes / 1024)}KB 正文，撞名与不合格式的条目会逐条说明原因。
          </div>
        </div>
        <button type="button" className="mem-import-card-btn" onClick={() => setImporting(true)}>
          导入
        </button>
      </div>

      {summary ? <p className="mem-settings-summary">{summary}</p> : null}
      {importing ? (
        <MemoryImportDialog
          onClose={(message) => {
            setImporting(false)
            setSummary(message)
          }}
        />
      ) : null}
    </div>
  )
}
