import { useEffect, useState, type ReactNode } from 'react'
import {
  canRevertHunks,
  computeHunks,
  summarizeDiff,
  type DiffHunk,
  type DiffResult
} from '@shared/text-diff'
import {
  describeKind,
  describeRevertFailure,
  describeSidesFailure,
  type CheckpointSides,
  type CheckpointSidesResult
} from '@shared/checkpoint'

// 文件差异（B3 看 / B4 退）：「这一轮到底把这个文件改成了什么样」。
//
// 用统一视图而非并排：① 块序号必须唯一真相源 —— Monaco 与 jsdiff 各有一套切块算法，并用会让
// 高亮的块与按钮对应的块**静默**对不上（点第 2 处、写盘的却是第 3 处）；② 窄抽屉里并排更难读。
// 退回**不在这里算完就写**：界面只说"退第几处"，读取/算差异/写盘全在主进程 —— 写盘要走统一写入服务
// （这次退回自己也留检查点），主进程再用**同一个** `@shared/text-diff` 重算，块序号才对得上；
// 界面顺手算的那份只用来**显示**，不许当写入依据。

interface Props {
  runId: string
  rel: string
  onClose: () => void
}

type Loaded =
  | { phase: 'loading' }
  | { phase: 'failed'; reason: string }
  | { phase: 'ready'; sides: CheckpointSides; diff: DiffResult }

export default function DiffView({ runId, rel, onClose }: Props): JSX.Element {
  const [state, setState] = useState<Loaded>({ phase: 'loading' })
  /** 退回过一次就 +1（内容和 mtime 都变了，必须重新取一次两侧） */
  const [reloadToken, setReloadToken] = useState(0)
  /** 正在等确认的那一处（`null` = 没有） */
  const [confirmHunk, setConfirmHunk] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    setState({ phase: 'loading' })

    void window.api.getCheckpointSides(runId, rel).then((res: CheckpointSidesResult) => {
      if (!alive) return
      if (!res.ok) {
        setState({ phase: 'failed', reason: describeSidesFailure(res.reason) })
        return
      }
      // 改前不存在（created）或改后又被删（after === null）都拿空串兜底 → 整份变新增行 / 删除行
      const before = res.before ?? ''
      const after = res.after ?? ''
      setState({ phase: 'ready', sides: res, diff: computeHunks(before, after) })
    })

    return () => {
      alive = false
    }
  }, [runId, rel, reloadToken])

  /** 退回某一处：界面只说"退第几处"，怎么退由主进程决定（见文件头） */
  const doRevert = async (hunkIndex: number): Promise<void> => {
    if (state.phase !== 'ready') return
    const mtimeMs = state.sides.mtimeMs
    if (mtimeMs === undefined) {
      setNotice({ ok: false, text: '拿不到文件的时间戳，没法确认它有没有被改过 —— 请重新打开差异' })
      setConfirmHunk(null)
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const r = await window.api.revertCheckpointHunk({
        runId,
        rel,
        hunkIndex,
        expectedMtimeMs: mtimeMs
      })
      if (r.ok) {
        setNotice({ ok: true, text: `已退回第 ${hunkIndex} 处` })
        setReloadToken((n) => n + 1) // 重新取两侧 → 这一块应当从差异里消失
      } else {
        setNotice({ ok: false, text: describeRevertFailure(r.reason) })
      }
    } catch (err) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
      setConfirmHunk(null)
    }
  }

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
  /** 「算不出来 / 没得显示」必须与「内容相同」分开：`degraded` = jsdiff 超时或编辑长度超限、
   *  它自己放弃了；`hunks` 空但 `identical` 假 = 块算出来了、但唯一那块大过渲染预算被挡掉。
   *  两者都**不是**"没有改动"，所以不能落到"完全一致"那句。 */
  const tooBig = !diff.identical && diff.hunks.length === 0
  // 除 `canRevertHunks` 那几条（created / 截断 / 缺一侧）外，这里还有两条同源否决：
  // `sides.lossy`（不是合法 UTF-8，整份重写会损坏它、不可逆）与 `tooBig`（压根没有可用的块）。
  const revertible =
    canRevertHunks({
      truncated: sides.truncated,
      kind: sides.kind,
      hasBefore: sides.before !== null,
      hasAfter: sides.after !== null
    }) &&
    !sides.lossy &&
    !tooBig

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

      {/* 这一轮还没收尾 —— Agent 可能正在写这些文件，此刻看到的内容正在变 */}
      {sides.runStatus === 'running' && (
        <div className="df-warn">
          这一轮还没跑完，Agent 可能正在改这些文件 —— 现在看到的不是最终结果。
          <strong>如果你现在退回某一处，Agent 可能随后又把它改回去</strong>，这次退回就白做了。
        </div>
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

      {/* 不是合法 UTF-8：退回会把整份内容按 UTF-8 重写，没被退的行也一起烂掉 */}
      {sides.lossy && (
        <div className="df-warn">
          这个文件<strong>不是 UTF-8 编码</strong>（可能是 GBK 或二进制）——
          逐处退回会把整份内容写坏且<strong>不可恢复</strong>，所以这里不提供逐处退回。
        </div>
      )}

      {/* 改动太大算不动：**必须与"内容相同"区分开**，否则就是把"算不动"说成"没改动" */}
      {tooBig ? (
        <div className="df-warn">
          这个文件这一轮改动<strong>太大</strong>（像是整份重写过）—— 逐行差异这里算不出来，
          所以不逐行展示。要看结果请直接打开文件；要还原请用右边那个「回滚」按钮整份退回。
        </div>
      ) : diff.identical ? (
        <div className="df-none">
          当前内容和这一轮的快照<strong>完全一致</strong> —— 可能已经被退回过了。
        </div>
      ) : (
        <>
          <div className="df-sum">
            共 {diff.totalHunks} 处改动
            {diff.truncated && ` —— 只显示了前 ${diff.hunks.length} 处`}
            {revertible && ' · 可以逐处退回'}
          </div>          {diff.hunks.map((h) => (
            <Hunk
              key={h.index}
              hunk={h}
              confirming={confirmHunk === h.index}
              actions={
                revertible ? (
                  <HunkRevert
                    // ⚠️ `busy` 必须排在前面：写盘期间 `confirmHunk` 还挂着，先看它按钮会一直可点 ——
                    //    连点两下 = 两次请求带同一个 mtime 基线（多一条轮次 + 一条惊悚提示）。
                    state={busy ? 'busy' : confirmHunk === h.index ? 'confirming' : 'idle'}
                    onAsk={() => {
                      setConfirmHunk(h.index)
                      setNotice(null)
                    }}
                    onCancel={() => setConfirmHunk(null)}
                    onConfirm={() => void doRevert(h.index)}
                  />
                ) : null
              }
            />
          ))}
        </>
      )}

      {/* 不能逐处退回时要说清**为什么** —— 只给一个灰按钮最招人恨。文案点名真按钮叫「回滚」：
          面板那一栏上写的就是它，只说"整份退回"用户找不到该点哪个。 */}
      {!diff.identical && !tooBig && !revertible && (
        <div className="df-note">
          {sides.kind === 'created'
            ? '新建的文件没有"改前的内容"可逐处还原，只能整份退回（用右边那个「回滚」按钮 —— 对新建的文件来说就是把它删掉）。'
            : sides.lossy
              ? '这个文件不是 UTF-8 编码，逐处退回会把整份内容写坏 —— 只能整份退回（用右边那个「回滚」按钮）。'
              : sides.truncated
                ? '文件太大只读到了一部分，逐处退回会把文件写坏 —— 只能整份退回（用右边那个「回滚」按钮）。'
                : '这个文件现在读不到（或已被删），只能整份退回（用右边那个「回滚」按钮）。'}
        </div>
      )}

      {notice && <div className={notice.ok ? 'notice-ok' : 'notice-err'}>{notice.text}</div>}
    </div>
  )
}

/** 一处的「退回」按钮：点一下不直接写盘，先就地确认一次（与回滚同一规矩） */
function HunkRevert({
  state,
  onAsk,
  onCancel,
  onConfirm
}: {
  state: 'idle' | 'confirming' | 'busy'
  onAsk: () => void
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  if (state === 'confirming') {
    return (
      <span className="df-actions">
        <button className="ck-btn ck-btn-danger" disabled={false} onClick={onConfirm}>
          确认退回
        </button>
        <button className="ck-btn" onClick={onCancel}>
          取消
        </button>
      </span>
    )
  }
  return (
    <span className="df-actions">
      <button className="ck-btn" disabled={state === 'busy'} onClick={onAsk}>
        退回这一处
      </button>
    </span>
  )
}

function Hunk({
  hunk,
  confirming,
  actions
}: {
  hunk: DiffHunk
  confirming: boolean
  actions: ReactNode
}): JSX.Element {
  // ⚠️ 确认那一刻要回答的是**"点下去会发生什么"**、不是"改动是什么"（plan13 硬要求）：
  //    非确认态的「在第 N 行插入 M 行」「删掉第 X–Y 行」描述的是改动本身，
  //    最容易被误解成退回后的结果 —— 所以确认态改用「退回后：…」措辞。
  const range = confirming
    ? hunk.oldLines === 0
      ? `退回后：把新插入的 ${hunk.newLines} 行删掉`
      : hunk.newLines === 0
        ? `退回后：把删掉的 ${hunk.oldLines} 行放回来`
        : `退回后：这 ${hunk.oldLines} 行会还原成改动前的样子`
    : hunk.oldLines === 0
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
        {actions}
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
