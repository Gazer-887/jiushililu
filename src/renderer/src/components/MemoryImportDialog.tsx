import { useState } from 'react'
import type { MemorySaveResult } from '@shared/memory'
import { MEMORY_IMPORT_PROMPT, parseMemoryImport } from '@shared/memory-import'

// 「导入其他记忆」对话框（0.13.41 反馈新增，形态照 WorkBuddy 的两步式）。
// ⚠️ 三条底线：① 导入走与手填**完全相同**的 `saveMemory` —— 撞名/超限/凭据一样被拒，导入无后门；
//    ② 解析失败的条目**逐条报因**，不许静默丢；③ origin 记 `user` —— 导入是用户主动搬运，
//    内容来自用户自己的其它 AI，不冒充模型写的（也就不进巡检区）。

export default function MemoryImportDialog(props: {
  onClose: (summary: string | null) => void
}): JSX.Element {
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [report, setReport] = useState<string | null>(null)

  const copyPrompt = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(MEMORY_IMPORT_PROMPT)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setReport('复制失败：请手动全选上方文本复制')
    }
  }

  const run = async (): Promise<void> => {
    const parsed = parseMemoryImport(pasted)
    if (!parsed.ok) {
      setReport(parsed.reason)
      return
    }
    setBusy(true)
    const okNames: string[] = []
    const failures: string[] = []
    for (const d of parsed.drafts) {
      const res: MemorySaveResult = await window.api.saveMemory({
        name: d.name,
        description: d.description,
        class: d.class,
        body: d.body,
        origin: 'user'
      })
      if (res.ok) okNames.push(d.name)
      else failures.push(`「${d.name}」：${res.reason}`)
    }
    setBusy(false)
    if (okNames.length === 0) {
      setReport(`一条都没导入成功：${failures.slice(0, 3).join('；')}`)
      return
    }
    const tail = failures.length > 0 ? `；${failures.length} 条未导入（${failures[0]}${failures.length > 1 ? ' 等' : ''}）` : ''
    props.onClose(`已导入 ${okNames.length} 条${tail}`)
  }

  return (
    <div className="mem-import-mask" role="dialog" aria-modal="true" aria-label="导入其他记忆">
      <div className="mem-import">
        <div className="mem-import-head">
          <span className="mem-import-title">导入其他记忆</span>
          <button type="button" className="mem-import-x" onClick={() => props.onClose(null)} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="mem-import-step">
          <div className="mem-import-step-head">
            <span className="mem-import-no">1</span>
            <span>复制下面的提示词，粘贴到其它 AI 对话中</span>
            <button type="button" className="mem-import-copy" onClick={() => void copyPrompt()}>
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <pre className="mem-import-prompt">{MEMORY_IMPORT_PROMPT}</pre>
        </div>

        <div className="mem-import-step">
          <div className="mem-import-step-head">
            <span className="mem-import-no">2</span>
            <span>把它的回答粘贴到下面，导入到本机记忆库</span>
          </div>
          <textarea
            className="mem-import-paste"
            placeholder="在此粘贴按上面格式生成的回答"
            rows={9}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
        </div>

        {report ? <div className="mem-notice-err">{report}</div> : null}

        <div className="mem-import-actions">
          <button type="button" onClick={() => props.onClose(null)}>
            取消
          </button>
          <button
            type="button"
            className="mem-import-go"
            disabled={busy || pasted.trim().length === 0}
            onClick={() => void run()}
          >
            导入
          </button>
        </div>
      </div>
    </div>
  )
}
