import { useCallback, useEffect, useState } from 'react'
import type { DevEnvSnapshot } from '@shared/dev-env'
import { isSelectionValid } from '@shared/dev-env'
import RuntimeSelect from './RuntimeSelect'

/**
 * 开发环境设置区（plan43 S2）。
 * 文案纪律（决策 3b）：未检测到时**只显「未检测到，请刷新」**——不加指路、不加暗示，逐字。
 * 「＋」不存在（§〇之二 立场）：探测是唯一入口。
 */
export default function DevEnvSettings(): React.ReactElement {
  const [snap, setSnap] = useState<DevEnvSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const detect = useCallback(async (force: boolean): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      setSnap(await window.api.detectRuntimes(force))
    } catch (e) {
      setErr(`探测失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void detect(false)
  }, [detect])

  async function select(language: string, path: string | null): Promise<void> {
    const selected = await window.api.selectRuntime(language, path)
    setSnap((s) => (s ? { ...s, selected } : s))
  }

  const staleLangs = snap ? isSelectionValid(snap.selected, snap) : []
  // UI 先只显 Node + Python（开放点 2）；uv 在快照里供其他方案联动取用，不单列分组
  const shown = (snap?.groups ?? []).filter((g) => g.id === 'node' || g.id === 'python')

  return (
    <div className="settings-section de-section">
      <h2>开发环境</h2>
      <p className="hint">Agent 运行代码时使用的本机运行时。全局一份，探测自动发现，不支持手动添加。</p>
      <div className="de-toolbar">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void detect(true)}>
          {busy ? '探测中…' : '刷新'}
        </button>
        {snap && <span className="hint de-time">上次探测 {new Date(snap.detectedAt).toLocaleTimeString()}</span>}
      </div>
      {err.length > 0 && <p className="hint de-err">{err}</p>}
      {shown.map((g) => {
        const total = g.main.length + g.others.length
        const selectedPath = snap?.selected[g.id] ?? ''
        return (
          <div key={g.id} className="de-group">
            <div className="field-label">{g.label}</div>
            {total === 0 ? (
              <div className="de-empty">未检测到，请刷新</div>
            ) : (
              <div className="de-row">
                <span className="de-row-label">{g.id === 'node' ? 'Node 版本' : 'Python 解释器'}</span>
                <RuntimeSelect
                  main={g.main}
                  others={g.others}
                  langLabel={g.label}
                  value={selectedPath}
                  stale={staleLangs.includes(g.id)}
                  disabled={busy}
                  onChange={(p) => void select(g.id, p)}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
