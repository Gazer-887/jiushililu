import { useEffect, useState } from 'react'
import {
  canRevertHunks,
  computeHunks,
  summarizeDiff,
  type DiffHunk,
  type DiffResult
} from '@shared/text-diff'
import {
  describeKind,
  describeSidesFailure,
  type CheckpointSides,
  type CheckpointSidesResult
} from '@shared/checkpoint'

// 文件差异（plan13 批 B · B3）——「这一轮到底把这个文件改成了什么样」。
//
// ## 为什么是"统一视图"而不是并排（这个决定值得写下来）
//
// Monaco 有现成的 DiffEditor，并排更漂亮。这里没用它，两个理由：
//
// ① **块序号必须是唯一的真相源**。用户要"退回第 2 处"时，那个"第 2 处"必须是
//    我们能精确应用的那一块。Monaco 自带一套切块算法、jsdiff 另一套 ——
//    两套一起用，高亮的块和按钮对应的块**迟早对不上**，而且是静默对不上：
//    界面上看着点了第 2 处，写盘的却是第 3 处的内容。所以 diff 只有一份来源
//    （`@shared/text-diff`），渲染也用它。
// ② 这个面板是**窄抽屉**。并排视图在窄栏里每侧只剩几十个字符，读起来比统一视图更差。
//
// 记在计划里的调研结论（Monaco 的 diff 只能整侧 revert、`@monaco-editor/react` 走 CDN
// 被 CSP 禁）也印证了同一条：**能"应用"的那份数据才是主体，界面只是它的呈现**。

interface Props {
  runId: string
  rel: string
  /** 收起（清空选择） */
  onClose: () => void
}

type Loaded =
  | { phase: 'loading' }
  | { phase: 'failed'; reason: string }
  | { phase: 'ready'; sides: CheckpointSides; diff: DiffResult }

export default function DiffView({ runId, rel, onClose }: Props): JSX.Element {
  const [state, setState] = useState<Loaded>({ phase: 'loading' })

  useEffect(() => {
    let alive = true
    setState({ phase: 'loading' })

    void window.api.getCheckpointSides(runId, rel).then((res: CheckpointSidesResult) => {
      if (!alive) return
      if (!res.ok) {
        setState({ phase: 'failed', reason: describeSidesFailure(res.reason) })
        return
      }
      // created：改前文件不存在 → 拿空串当"改前"，于是整份都是新增行。
      // after === null：这轮改完之后文件又被删了 → 整份都是删除行。
      const before = res.before ?? ''
      const after = res.after ?? ''
      setState({ phase: 'ready', sides: res, diff: computeHunks(before, after) })
    })

    return () => {
      alive = false
    }
  }, [runId, rel])

  if (state.phase === 'loading') {
    return <div className="df-wrap df-loading">正在读取这一轮的快照…</div>
  }

  if (state.phase === 'failed') {
    return (
      <div className="df-wrap">
        <div className="df-bar">
          <span className="df-rel" title={rel}>
            {rel}
          </span>
          <button className="ck-btn" onClick={onClose}>
            收起
          </button>
        </div>
        <div className="ex-msg">{state.reason}</div>
      </div>
    )
  }

  const { sides, diff } = state
  const revertible = canRevertHunks({
    truncated: sides.truncated,
    kind: sides.kind,
    hasBefore: sides.before !== null,
    hasAfter: sides.after !== null
  })

  return (
    <div className="df-wrap">
      <div className="df-bar">
        <span className={`ck-kind ${sides.kind === 'created' ? 'ck-kind-new' : ''}`}>
          {describeKind(sides.kind)}
        </span>
        <span className="df-rel" title={rel}>
          {rel}
        </span>
        <span className="df-stat">{summarizeDiff(diff)}</span>
        <button className="ck-btn" onClick={onClose}>
          收起
        </button>
      </div>

      {/* 这一轮还没收尾 —— Agent 可能正在写这些文件，此刻看到的内容可能正在变 */}
      {sides.runStatus === 'running' && (
        <div className="df-warn">这一轮还没跑完，Agent 可能正在改这些文件 —— 现在看到的不是最终结果。</div>
      )}

      {/* 截断必须说出来：只读了一半就下结论，比不显示更误导 */}
      {sides.truncated && (
        <div className="df-warn">
          文件较大，这里只读了前 256 KB —— 下面显示的差异<strong>可能不完整</strong>。
        </div>
      )}

      {sides.before === null && (
        <div className="df-note">
          这个文件在这一轮之前<strong>不存在</strong>，所以下面全是新增的内容。
        </div>
      )}
      {sides.before !== null && sides.after === null && (
        <div className="df-note">
          这个文件现在<strong>已经不存在了</strong>（本轮之后被删掉），所以下面全是消失的内容。
        </div>
      )}

      {diff.identical ? (
        <div className="df-none">
          当前内容和这一轮的快照<strong>完全一致</strong> —— 可能已经被退回过了。
        </div>
      ) : (
        <>
          <div className="df-sum">
            共 {diff.totalHunks} 处改动
            {diff.truncated && ` —— 只显示了前 ${diff.hunks.length} 处`}
          </div>
          {diff.hunks.map((h) => (
            <Hunk key={h.index} hunk={h} />
          ))}
        </>
      )}

      {/* B4 才会长出"逐处退回"的按钮；这里先把"能不能逐处退"的判断摊开给用户看 */}
      {!diff.identical && !revertible && (
        <div className="df-note">
          {sides.kind === 'created'
            ? '新建的文件没有"改前的内容"可逐处还原，只能整份退回（= 删除）。'
            : '内容不完整，不能逐处退回 —— 只能整份退回，免得把文件写坏。'}
        </div>
      )}
    </div>
  )
}

function Hunk({ hunk }: { hunk: DiffHunk }): JSX.Element {
  const range =
    hunk.oldLines === 0
      ? `在第 ${hunk.newStart} 行处插入 ${hunk.newLines} 行`
      : hunk.newLines === 0
        ? `删掉第 ${hunk.oldStart}–${hunk.oldStart + hunk.oldLines - 1} 行`
        : `改前 ${hunk.oldStart}–${hunk.oldStart + hunk.oldLines - 1} 行 · 改后 ${hunk.newStart}–${hunk.newStart + hunk.newLines - 1} 行`

  return (
    <div className="df-hunk">
      <div className="df-hunk-head">
        <span className="df-hunk-no">第 {hunk.index} 处</span>
        <span className="df-hunk-range">{range}</span>
        <span className="df-hunk-count">
          {hunk.added > 0 && <span className="df-add-n">＋{hunk.added}</span>}
          {hunk.removed > 0 && <span className="df-del-n">−{hunk.removed}</span>}
        </span>
      </div>
      <div className="df-lines">
        {hunk.lines.map((l, i) => (
          <div key={i} className={`df-line df-${l.type}`}>
            {/* 左右两个行号槽：改前 / 改后。空槽保持宽度，行号才对得齐 */}
            <span className="df-no">{l.oldNo ?? ''}</span>
            <span className="df-no">{l.newNo ?? ''}</span>
            <span className="df-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}</span>
            <span className="df-text">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
