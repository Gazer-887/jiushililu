import { useCallback, useEffect, useState } from 'react'
import { GIT_KIND_LABELS, isStaged, type GitChange } from '@shared/git-status'
import type { GitStatusResult } from '@shared/ipc'

// 源代码管理面板（plan16）：**看得见改动 → 能提交**这条主链路。
//
// ⚠️ 三条纪律（都是"静默出错"类，不是崩溃类，只能靠写的时候守住）：
//   1. **每次都拉整份重画**，不做增量推断。git 状态有多个来源（Agent 改文件、终端跑命令、
//      外面的编辑器改），增量推断必漏，漏了就是"改了却不显示"这种最难查的假账。
//   2. **非 Git 仓库必须说清原因**，不许显示空面板 —— 空面板会被读成"没有改动"。
//   3. **勾选状态一律以 git 的回话为准**（`isStaged` 读的是 `git status` 的 X 位），
//      界面不自己记"我刚勾选了所以它现在是勾上的" —— 命令失败了界面还绿着，那就是骗人。
//
// 关于 diff 的呈现：本批用**内联着色**渲染 `git diff` 的 unified 文本，没有复用批 B 的 Monaco 差异视图。
// 理由：`DiffView` 绑定的是检查点的 `runId`（"这一轮改了什么"），而 SCM 没有 runId 这个概念；
// 走页签则要在 `workbench.ts` 里新增一种 `PaneContent`（diff 类型），属于下一批的形态改动。
// 内联渲染零新增依赖、够读，且**不引入"界面自己算一份差异"的第二个真相源**。

type Notice = { ok: boolean; text: string }

export default function ScmPanel(): JSX.Element {
  const [res, setRes] = useState<GitStatusResult | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  /** 正在展开差异的文件（`null` = 没展开）。看完不收起会一直占着面板高度 */
  const [diffRel, setDiffRel] = useState<string | null>(null)
  const [diffText, setDiffText] = useState('')

  const reload = useCallback(async (): Promise<void> => {
    try {
      setRes(await window.api.getGitStatus())
    } catch (err) {
      // 连通道都没通（主进程抛了）—— 也要说清，不能留成"空面板"
      setRes({ ok: false, view: null, message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  useEffect(() => {
    void reload()
    // 自己提交完 / Agent 改了文件 / 终端跑了 git 命令 —— 主进程都会广播，面板据此重拉（不靠定时器猜）
    return window.api.onGitChanged(() => void reload())
  }, [reload])

  const view = res?.ok === true ? res.view : null
  const changes = view?.changes ?? []
  const staged = changes.filter(isStaged)
  const unstaged = changes.filter((c) => !isStaged(c))

  const canCommit = message.trim().length > 0 && staged.length > 0 && !busy

  /** 勾选 = 暂存 / 取消 = 取消暂存。**失败要说原因，且状态以重载结果为准**（不本地乐观勾选） */
  const toggle = async (c: GitChange, next: boolean): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const r = next
        ? await window.api.gitStage([c.path])
        : await window.api.gitUnstage([c.path])
      if (!r.ok) setNotice({ ok: false, text: r.message ?? '操作失败' })
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
      await reload()
    }
  }

  const commit = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const r = await window.api.gitCommit(message)
      if (r.ok) {
        setNotice({ ok: true, text: r.summary || '已提交' })
        setMessage('') // 提交完清空输入框 —— 免得下一条沿用旧说明
      } else {
        setNotice({ ok: false, text: r.message ?? '提交失败' })
      }
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
      setDiffRel(null)
      await reload()
    }
  }

  const showDiff = async (rel: string): Promise<void> => {
    if (diffRel === rel) {
      setDiffRel(null)
      return
    }
    setDiffRel(rel)
    setDiffText('')
    try {
      setDiffText(await window.api.getGitDiff(rel))
    } catch (err) {
      setDiffText(err instanceof Error ? err.message : String(err))
    }
  }

  /** 顶部一行的状态：待推送优先（真实信息、用户最该知道），其次改动计数 */
  const headline = (): string => {
    if (!view) return ''
    if (view.ahead > 0) return `↑ ${view.ahead} 个提交待推送`
    if (changes.length > 0) return `● ${changes.length} 项改动`
    return '没有改动'
  }

  if (res?.ok === false) {
    return (
      <div className="scm-panel">
        <div className="scm-empty">{res.message ?? '读不到 Git 状态'}</div>
      </div>
    )
  }

  return (
    <div className="scm-panel">
      <div className="scm-head">
        <span className="scm-title" title={view ? `当前分支：${view.branch}` : undefined}>
          {view?.branch ?? '…'}
        </span>
        <span className="scm-count">{headline()}</span>
        <button className="scm-btn" disabled={busy} onClick={() => void reload()}>
          刷新
        </button>
      </div>

      <textarea
        className="scm-input"
        rows={3}
        placeholder="一句话说清改了什么…"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="scm-actions">
        <button
          className="scm-btn scm-btn-primary"
          disabled={!canCommit}
          // 禁用时必须**说清为什么**（项目一贯的"禁用就要给理由"，否则用户只会以为按钮坏了）
          title={
            staged.length === 0
              ? '先勾选要提交的文件'
              : message.trim().length === 0
                ? '先填写提交消息'
                : '提交已暂存的文件'
          }
          onClick={() => void commit()}
        >
          提交
        </button>
        {staged.length === 0 && <span className="scm-why">先勾选要提交的文件</span>}
        {staged.length > 0 && message.trim().length === 0 && (
          <span className="scm-why">还没写提交消息</span>
        )}
      </div>

      {changes.length === 0 ? (
        <div className="scm-empty">工作区是干净的。</div>
      ) : (
        <>
          {staged.length > 0 && (
            <div className="scm-group">
              <div className="scm-group-head">已暂存的更改 ({staged.length})</div>
              {staged.map((c) => (
                <Row key={c.path} c={c} busy={busy} onToggle={toggle} onDiff={showDiff} open={diffRel === c.path} />
              ))}
            </div>
          )}
          {unstaged.length > 0 && (
            <div className="scm-group">
              <div className="scm-group-head">更改 ({unstaged.length})</div>
              {unstaged.map((c) => (
                <Row key={c.path} c={c} busy={busy} onToggle={toggle} onDiff={showDiff} open={diffRel === c.path} />
              ))}
            </div>
          )}
        </>
      )}

      {diffRel !== null && (
        <div className="scm-diff">
          <div className="scm-diff-head">
            <span className="scm-diff-rel" title={diffRel}>
              {diffRel}
            </span>
            <button className="scm-btn" onClick={() => setDiffRel(null)}>
              收起
            </button>
          </div>
          {diffText.length === 0 ? (
            <div className="scm-diff-empty">这个文件没有可显示的差异（可能是二进制文件或只有模式变更）</div>
          ) : (
            <pre className="scm-diff-body">
              {diffText.split('\n').map((line, i) => (
                <div key={i} className={`scm-d-line ${lineClass(line)}`}>
                  {line.length > 0 ? line : ' '}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      {notice && <div className={notice.ok ? 'notice-ok' : 'notice-err'}>{notice.text}</div>}
    </div>
  )
}

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'scm-d-file'
  if (line.startsWith('@@')) return 'scm-d-meta'
  if (line.startsWith('+')) return 'scm-d-add'
  if (line.startsWith('-')) return 'scm-d-del'
  return ''
}

function Row({
  c,
  busy,
  open,
  onToggle,
  onDiff
}: {
  c: GitChange
  busy: boolean
  open: boolean
  onToggle: (c: GitChange, next: boolean) => void
  onDiff: (rel: string) => void
}): JSX.Element {
  const checked = isStaged(c)
  return (
    <div className="scm-item">
      <div className="scm-line">
        <input
          type="checkbox"
          className="scm-check"
          checked={checked}
          disabled={busy}
          // 勾选 = 暂存（`git add`），取消 = 取消暂存（`git restore --staged`，**不动工作区文件**）
          title={checked ? '取消暂存（不会丢弃你的改动）' : '暂存这个文件'}
          onChange={(e) => onToggle(c, e.target.checked)}
        />
        <span className={`scm-kind scm-kind-${c.kind}`} title={GIT_KIND_LABELS[c.kind]}>
          {c.staged === '?' ? '??' : (c.staged.trim() || c.unstaged.trim() || '?')}
        </span>
        <button className="scm-rel" title={c.path} onClick={() => onDiff(c.path)}>
          {c.path}
        </button>
        <button className="scm-btn" disabled={busy} onClick={() => onDiff(c.path)}>
          {open ? '收起差异' : '看差异'}
        </button>
      </div>
    </div>
  )
}
