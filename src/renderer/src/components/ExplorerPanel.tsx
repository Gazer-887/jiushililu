import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import type { FsEntry } from '@shared/fs-tree'
import { formatSize, isTextPreviewable } from '@shared/fs-tree'

// 资源管理器（plan7 批 A 只读 → 批 A2 全功能）：工作区文件树 + 预览 + 写操作。
//
// 写操作**全部经统一写入服务**（每个操作各开一个检查点轮次）——
// 所以界面里删掉/改掉的东西，同样出现在「文件变更记录」里、同样退得回。
//
// 菜单项按本项目**真实具备的能力**筛，不照抄 VSCode：
//   运行测试 / 调试 / 覆盖率 / 时间线 / Git 文件历史 —— 这些本项目没有，不做；
//   编辑器与终端相关项等批 B / 批 C 落地后再补。
//
// 懒加载：展开哪个目录才查哪个（工作区可能有几千个文件）。

interface TreeState {
  /** rel → 该层条目；'' 表示根 */
  children: Record<string, FsEntry[]>
  /** 展开中的目录 rel */
  expanded: Set<string>
  /** 加载中 / 出错的目录 rel */
  loading: Set<string>
  errors: Record<string, string>
}

/** 正在就地编辑的那一行（Electron 里 window.prompt 被禁，只能内联输入） */
interface Editing {
  kind: 'new-file' | 'new-dir' | 'rename'
  /** 在哪一层里输入 */
  parentRel: string
  value: string
  /** rename 时的原条目 */
  target?: FsEntry
}

const parentOf = (rel: string): string => rel.split('/').slice(0, -1).join('/')

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
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  /** 拖拽悬停的落点目录（'' = 根）—— 用来给拖放目标加高亮 */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const editRef = useRef<HTMLInputElement>(null)

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

  // 点空白处关菜单（同 PermissionChip 的做法：监听挂在 document 上）
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [menu])

  useEffect(() => {
    if (editing) editRef.current?.focus()
  }, [editing])

  // 提示条几秒后自己消失
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

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

  /** 跑一个写操作：报结果 + 关菜单 + 成功则刷新所在层 */
  const runOp = async (
    fn: () => Promise<{ ok: boolean; message: string }>,
    refreshRel: string
  ): Promise<void> => {
    setMenu(null)
    const res = await fn()
    setNotice({ ok: res.ok, text: res.message })
    if (res.ok) await loadDir(refreshRel)
  }

  const startEdit = (kind: Editing['kind'], parentRel: string, target?: FsEntry): void => {
    setMenu(null)
    setNotice(null)
    setEditing({ kind, parentRel, value: kind === 'rename' ? (target?.name ?? '') : '', ...(target ? { target } : {}) })
  }

  const commitEdit = async (): Promise<void> => {
    const e = editing
    if (!e) return
    const name = e.value.trim()
    setEditing(null)
    if (!name) return
    // 名字里不许带分隔符 —— 否则等于绕开"在哪个目录新建"这层语义
    if (name.includes('/') || name.includes('\\')) {
      setNotice({ ok: false, text: '名字里不能带路径分隔符' })
      return
    }
    const rel = e.parentRel ? `${e.parentRel}/${name}` : name
    if (e.kind === 'new-file') await runOp(() => window.api.writeWorkspaceFile(rel, ''), e.parentRel)
    else if (e.kind === 'new-dir') await runOp(() => window.api.createWorkspaceDir(rel), e.parentRel)
    else if (e.target) {
      await runOp(
        () => window.api.renameWorkspacePath(e.target!.rel, rel),
        parentOf(e.target.rel)
      )
    }
  }

  /**
   * 拖入文件 → 导入工作区（plan7 批 A2 第 3 步）。
   * 路径要经 preload 的 `webUtils` 拿 —— Electron 32+ 起渲染进程拿不到 File.path。
   * 同名冲突交给服务层处理（自动加序号，不覆盖）。
   */
  const handleDrop = async (e: ReactDragEvent, parentRel: string): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    const outs: Array<{ ok: boolean; message: string }> = []
    for (const f of files) {
      const abs = window.api.getPathForFile(f)
      if (!abs) {
        // 合成/浏览器拖拽拿不到磁盘路径 —— 如实说，别静默什么都不做
        outs.push({ ok: false, message: `${f.name}：拿不到磁盘路径，无法导入` })
        continue
      }
      const rel = parentRel ? `${parentRel}/${f.name}` : f.name
      outs.push(await window.api.importIntoWorkspace(abs, rel))
    }
    setNotice({
      ok: outs.every((o) => o.ok),
      text: outs.map((o) => o.message).join('；')
    })
    if (outs.some((o) => o.ok)) await loadDir(parentRel)
  }

  const copyPath = async (rel: string): Promise<void> => {
    setMenu(null)
    try {
      await navigator.clipboard.writeText(rel)
      setNotice({ ok: true, text: `已复制：${rel}` })
    } catch {
      setNotice({ ok: false, text: '复制失败（系统剪贴板不可用）' })
    }
  }

  const editRow = (depth: number): JSX.Element => (
    <div key="__edit" className="ex-edit-row" style={{ paddingLeft: 8 + depth * 14 }}>
      <input
        ref={editRef}
        className="ex-edit"
        value={editing?.value ?? ''}
        placeholder={editing?.kind === 'rename' ? '新名字' : '名字'}
        onChange={(e) => setEditing((cur) => (cur ? { ...cur, value: e.target.value } : cur))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commitEdit()
          else if (e.key === 'Escape') setEditing(null)
        }}
        onBlur={() => void commitEdit()}
      />
    </div>
  )

  /** 递归渲染一层（懒加载：子层没数据就不渲染子项） */
  const renderLevel = (rel: string, depth: number): JSX.Element[] => {
    const entries = tree.children[rel]
    if (!entries) return []
    const err = tree.errors[rel]
    const tail = editing && editing.parentRel === rel ? [editRow(depth)] : []

    if (err) {
      return [
        <div key={`${rel}__err`} className="ex-msg ex-err" style={{ paddingLeft: 8 + depth * 14 }}>
          {err}
        </div>
      ]
    }
    if (entries.length === 0 && tail.length === 0) {
      return [
        <div key={`${rel}__empty`} className="ex-msg" style={{ paddingLeft: 8 + depth * 14 }}>
          （空目录）
        </div>
      ]
    }

    const rows = entries.flatMap((e) => {
      const isOpen = tree.expanded.has(e.rel)
      const isLoading = tree.loading.has(e.rel)
      const renaming = editing?.kind === 'rename' && editing.target?.rel === e.rel
      const row = renaming ? (
        <div key={`${e.rel}__ren`} className="ex-edit-row" style={{ paddingLeft: 8 + depth * 14 }}>
          <input
            ref={editRef}
            className="ex-edit"
            value={editing?.value ?? ''}
            onChange={(ev) =>
              setEditing((cur) => (cur ? { ...cur, value: ev.target.value } : cur))
            }
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') void commitEdit()
              else if (ev.key === 'Escape') setEditing(null)
            }}
            onBlur={() => void commitEdit()}
          />
        </div>
      ) : (
        <button
          key={e.rel}
          className={`ex-row ${selected?.rel === e.rel ? 'ex-row-on' : ''} ${
            dropTarget === e.rel ? 'ex-row-drop' : ''
          }`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={e.rel}
          onClick={() => (e.kind === 'dir' ? void toggleDir(e) : void openFile(e))}
          onDragOver={(ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            setDropTarget(e.rel)
          }}
          onDragLeave={() => setDropTarget((t) => (t === e.rel ? null : t))}
          // 拖到目录上 → 放进该目录；拖到文件上 → 放进它所在的目录（不是根）
          onDrop={(ev) => void handleDrop(ev, e.kind === 'dir' ? e.rel : parentOf(e.rel))}
          onContextMenu={(ev) => {
            ev.preventDefault()
            // 贴边时往回收 —— 否则在窗口右下角右键，菜单会跑到窗口外面去
            // （菜单约 200×220，够用且留余量）
            setMenu({
              x: Math.min(ev.clientX, window.innerWidth - 200),
              y: Math.min(ev.clientY, window.innerHeight - 220),
              entry: e
            })
          }}
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

    return [...rows, ...tail]
  }

  const rootLoading = tree.loading.has('')
  const rootErr = tree.errors['']
  const rootTail = editing && editing.parentRel === '' ? editRow(0) : null

  return (
    <div
      className={`ex-panel ${dropTarget === '' ? 'ex-panel-drop' : ''}`}
      // 拖到面板空白处 → 放进**工作区根目录**
      onDragOver={(e) => {
        e.preventDefault()
        setDropTarget('')
      }}
      onDragLeave={() => setDropTarget((t) => (t === '' ? null : t))}
      onDrop={(e) => void handleDrop(e, '')}
      onContextMenu={(e) => {
        // 空白处右键 → 针对根目录的菜单（新建 / 刷新）
        if (e.target === e.currentTarget) {
          e.preventDefault()
          setMenu({
            x: Math.min(e.clientX, window.innerWidth - 200),
            y: Math.min(e.clientY, window.innerHeight - 220),
            entry: null
          })
        }
      }}
    >
      <div className="ex-head">
        <span className="ex-title">资源管理器</span>
        <button
          className="ex-btn"
          title="新建文件 / 文件夹"
          onClick={() => startEdit('new-file', '')}
        >
          新建
        </button>
        <button className="ex-btn" onClick={() => void loadDir('')}>
          刷新
        </button>
      </div>
      <div className="ex-path" title={workspace}>
        {workspace || '（未设置工作区）'}
      </div>

      {notice && (
        <div className={`ex-notice ${notice.ok ? '' : 'ex-notice-bad'}`}>{notice.text}</div>
      )}

      <div className="ex-tree">
        {rootLoading && !tree.children[''] ? (
          <div className="ex-msg">读取中…</div>
        ) : rootErr ? (
          <div className="ex-msg ex-err">{rootErr}</div>
        ) : tree.children['']?.length === 0 && !rootTail ? (
          <div className="ex-msg">这个工作区还是空的。右键新建，或直接把文件拖进来。</div>
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
              {preview.truncated && <div className="ex-msg">文件较大，仅显示前 256 KB</div>}
              <pre className="ex-pre">{preview.content}</pre>
            </>
          )}
          {!preview && !previewErr && <div className="ex-msg">读取中…</div>}
        </div>
      )}

      {menu && (
        <div className="ex-menu" ref={menuRef} style={{ left: menu.x, top: menu.y }}>
          {menu.entry === null ? (
            <>
              <button className="ex-menu-item" onClick={() => startEdit('new-file', '')}>
                新建文件
              </button>
              <button className="ex-menu-item" onClick={() => startEdit('new-dir', '')}>
                新建文件夹
              </button>
              <div className="ex-menu-sep" />
              <button className="ex-menu-item" onClick={() => void loadDir('')}>
                刷新
              </button>
            </>
          ) : (
            <>
              {menu.entry.kind === 'file' && (
                <button
                  className="ex-menu-item"
                  onClick={() => {
                    const e = menu.entry!
                    setMenu(null)
                    void openFile(e)
                  }}
                >
                  打开预览
                </button>
              )}
              {menu.entry.kind === 'dir' && (
                <>
                  <button
                    className="ex-menu-item"
                    onClick={() => startEdit('new-file', menu.entry!.rel)}
                  >
                    在此新建文件
                  </button>
                  <button
                    className="ex-menu-item"
                    onClick={() => startEdit('new-dir', menu.entry!.rel)}
                  >
                    在此新建文件夹
                  </button>
                  <div className="ex-menu-sep" />
                </>
              )}
              <button
                className="ex-menu-item"
                onClick={() => {
                  const rel = menu.entry!.rel
                  setMenu(null)
                  void window.api.revealWorkspaceEntry(rel)
                }}
              >
                在系统文件管理器中显示
              </button>
              <button className="ex-menu-item" onClick={() => void copyPath(menu.entry!.rel)}>
                复制路径
              </button>
              <div className="ex-menu-sep" />
              <button className="ex-menu-item" onClick={() => startEdit('rename', parentOf(menu.entry!.rel), menu.entry!)}>
                重命名
              </button>
              <button
                className="ex-menu-item ex-menu-danger"
                onClick={() => {
                  const e = menu.entry!
                  void runOp(() => window.api.deleteWorkspacePath(e.rel), parentOf(e.rel))
                }}
              >
                删除（进回收站）
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
