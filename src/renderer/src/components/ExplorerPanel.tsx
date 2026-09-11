import { useCallback, useEffect, useState } from 'react'
import type { FsEntry } from '@shared/fs-tree'
import { formatSize, isTextPreviewable } from '@shared/fs-tree'

// 资源管理器（plan7 批 A）：工作区文件树 + 内容预览
//
// **只读**。新建/重命名/删除刻意留到批 A2 —— R4 的检查点钩子挂在 Agent 工具链上，
// 界面若直接写文件就绕过了检查点（删掉的文件在回滚面板里查不到、退不回来）。
// 要做写操作，得先让界面与 Agent 走同一条写入路径。
//
// 懒加载：展开哪个目录才查哪个，不做整树递归（工作区可能有几千个文件）。

interface TreeState {
  /** rel → 该层条目；'' 表示根 */
  children: Record<string, FsEntry[]>
  /** 展开中的目录 rel */
  expanded: Set<string>
  /** 加载中 / 出错的目录 rel */
  loading: Set<string>
  errors: Record<string, string>
}

export default function ExplorerPanel(): JSX.Element {
  const [tree, setTree] = useState<TreeState>({
    children: {},
    expanded: new Set(),
    loading: new Set(),
    errors: {}
  })
  const [workspace, setWorkspace] = useState<string>('')
  const [selected, setSelected] = useState<FsEntry | null>(null)
  const [preview, setPreview] = useState<{ content: string; truncated: boolean } | null>(null)
  const [previewErr, setPreviewErr] = useState<string>('')

  /** 载入某一层 */
  const loadDir = useCallback(async (rel: string): Promise<void> => {
    setTree((t) => ({
      ...t,
      loading: new Set(t.loading).add(rel),
      errors: { ...t.errors, [rel]: '' }
    }))
    const res = await window.api.listWorkspaceDir(rel)
    setTree((t) => {
      const loading = new Set(t.loading)
      loading.delete(rel)
      const errors = { ...t.errors }
      if (!res.ok) errors[rel] = res.error ?? '读取失败'
      else delete errors[rel]
      return { ...t, children: { ...t.children, [rel]: res.entries }, loading, errors }
    })
  }, [])

  // 打开面板时载入根目录 + 工作区路径
  useEffect(() => {
    void (async () => {
      const ws = await window.api.getWorkspace()
      setWorkspace(ws.path)
      await loadDir('')
    })()
  }, [loadDir])

  const toggleDir = async (entry: FsEntry): Promise<void> => {
    const expanded = new Set(tree.expanded)
    if (expanded.has(entry.rel)) {
      expanded.delete(entry.rel)
      setTree((t) => ({ ...t, expanded }))
      return
    }
    expanded.add(entry.rel)
    setTree((t) => ({ ...t, expanded }))
    if (!tree.children[entry.rel]) await loadDir(entry.rel)
  }

  const openFile = async (entry: FsEntry): Promise<void> => {
    setSelected(entry)
    setPreview(null)
    setPreviewErr('')
    if (!isTextPreviewable(entry.name)) {
      setPreviewErr('这个文件按二进制处理，暂不支持预览')
      return
    }
    const res = await window.api.readWorkspaceFile(entry.rel)
    if (!res.ok) {
      setPreviewErr(res.error ?? '读取失败')
      return
    }
    setPreview({ content: res.content, truncated: res.truncated === true })
  }

  /** 递归渲染一层（懒加载：子层没数据就不渲染子项） */
  const renderLevel = (rel: string, depth: number): JSX.Element[] => {
    const entries = tree.children[rel]
    if (!entries) return []
    const err = tree.errors[rel]

    if (err) {
      return [
        <div key={`${rel}__err`} className="ex-msg ex-err" style={{ paddingLeft: 8 + depth * 14 }}>
          {err}
        </div>
      ]
    }
    if (entries.length === 0) {
      return [
        <div key={`${rel}__empty`} className="ex-msg" style={{ paddingLeft: 8 + depth * 14 }}>
          （空目录）
        </div>
      ]
    }

    return entries.flatMap((e) => {
      const isOpen = tree.expanded.has(e.rel)
      const isLoading = tree.loading.has(e.rel)
      const row = (
        <button
          key={e.rel}
          className={`ex-row ${selected?.rel === e.rel ? 'ex-row-on' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={e.rel}
          onClick={() => (e.kind === 'dir' ? void toggleDir(e) : void openFile(e))}
        >
          <span className="ex-icon">{e.kind === 'dir' ? (isOpen ? '▾' : '▸') : '·'}</span>
          <span className={`ex-name ${e.kind === 'dir' ? 'ex-dir' : ''}`}>{e.name}</span>
          {e.kind === 'file' && e.size !== undefined && (
            <span className="ex-size">{formatSize(e.size)}</span>
          )}
          {isLoading && <span className="ex-size">…</span>}
        </button>
      )
      if (e.kind !== 'dir' || !isOpen) return [row]
      return [row, ...renderLevel(e.rel, depth + 1)]
    })
  }

  const rootLoading = tree.loading.has('')
  const rootErr = tree.errors['']

  return (
    <div className="ex-panel">
      <div className="ex-head">
        <span className="ex-title">资源管理器</span>
        <button className="ex-btn" onClick={() => void loadDir('')}>
          刷新
        </button>
      </div>
      <div className="ex-path" title={workspace}>
        {workspace || '（未设置工作区）'}
      </div>

      <div className="ex-tree">
        {rootLoading && !tree.children[''] ? (
          <div className="ex-msg">读取中…</div>
        ) : rootErr ? (
          <div className="ex-msg ex-err">{rootErr}</div>
        ) : tree.children['']?.length === 0 ? (
          <div className="ex-msg">这个工作区还是空的。</div>
        ) : (
          renderLevel('', 0)
        )}
      </div>

      {selected && selected.kind === 'file' && (
        <div className="ex-preview">
          <div className="ex-preview-head">
            <span className="ex-preview-name" title={selected.rel}>
              {selected.name}
            </span>
            <button className="ex-btn" onClick={() => setSelected(null)}>
              关闭
            </button>
          </div>
          {previewErr && <div className="ex-msg ex-err">{previewErr}</div>}
          {preview && (
            <>
              {preview.truncated && (
                <div className="ex-msg">文件较大，仅显示前 256 KB</div>
              )}
              <pre className="ex-pre">{preview.content}</pre>
            </>
          )}
          {!preview && !previewErr && <div className="ex-msg">读取中…</div>}
        </div>
      )}
    </div>
  )
}
