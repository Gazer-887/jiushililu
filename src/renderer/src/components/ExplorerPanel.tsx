import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode
} from 'react'
import type { FsEntry } from '@shared/fs-tree'
import { DRAG_PATH_MIME, formatSize } from '@shared/fs-tree'
import { useAppStore } from '../store'

// 资源管理器：工作区文件树 + 写操作。
//
// 写操作**全部经统一写入服务**（每个操作各开一个检查点轮次）—— 界面里改掉/删掉的东西
// 同样进「文件变更记录」、同样退得回；工具栏与菜单只筛本项目**真实具备**的能力，不照抄 VSCode；
// 目录懒加载：展开哪个目录才查哪个。

interface TreeState {
  /** rel → 该层条目；'' 表示根 */
  children: Record<string, FsEntry[]>
  expanded: Set<string>
  loading: Set<string>
  errors: Record<string, string>
}

/** 正在就地编辑的那一行（Electron 禁 window.prompt，只能内联输入） */
interface Editing {
  kind: 'new-file' | 'new-dir' | 'rename'
  parentRel: string
  value: string
  target?: FsEntry
}

const parentOf = (rel: string): string => rel.split('/').slice(0, -1).join('/')

const ICON_PROPS = {
  viewBox: '0 0 16 16',
  width: 14,
  height: 14,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

/** 手写内联 SVG（与项目其余图标同风格） */
const ICONS: { file: ReactNode; dir: ReactNode; refresh: ReactNode; collapse: ReactNode } = {
  file: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M9 1.8H4.2A1.2 1.2 0 0 0 3 3v10a1.2 1.2 0 0 0 1.2 1.2h7.6A1.2 1.2 0 0 0 13 13V5.8z" />
      <path d="M9 1.8v4h4" />
      <path d="M8 8.8v3.6M6.2 10.6h3.6" />
    </svg>
  ),
  dir: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M1.8 4.2A1.2 1.2 0 0 1 3 3h3l1.4 1.8H13a1.2 1.2 0 0 1 1.2 1.2v6.8A1.2 1.2 0 0 1 13 14H3a1.2 1.2 0 0 1-1.2-1.2z" />
      <path d="M8 7.8v3.6M6.2 9.6h3.6" />
    </svg>
  ),
  refresh: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <path d="M13.4 8a5.4 5.4 0 1 1-1.7-3.9" />
      <path d="M13.4 2.6v3.2h-3.2" />
    </svg>
  ),
  collapse: (
    <svg {...ICON_PROPS} aria-hidden="true">
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.6" />
      <path d="M5.2 8h5.6" />
    </svg>
  )
}

export default function ExplorerPanel(): JSX.Element {
  const wbOpenFile = useAppStore((s) => s.wbOpenFile)
  const [tree, setTree] = useState<TreeState>({
    children: {},
    expanded: new Set(),
    loading: new Set(),
    errors: {}
  })
  const [workspace, setWorkspace] = useState<string>('')
  const [selected, setSelected] = useState<FsEntry | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FsEntry | null } | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const editRef = useRef<HTMLInputElement>(null)

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

  useEffect(() => {
    void (async () => {
      const ws = await window.api.getWorkspace()
      setWorkspace(ws.path)
      await loadDir('')
    })()
  }, [loadDir])

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

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  /** 新建落点 = 当前选中的文件夹（对齐 VSCode）；选中文件则落它所在的目录，没选落根 */
  const newTarget = (): string => {
    if (!selected) return ''
    return selected.kind === 'dir' ? selected.rel : parentOf(selected.rel)
  }

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

  /**
   * 点文件 = 在**右侧独立开一栏**预览（复用已有的「纯文件栏」，没有就在最右新建一栏）——
   * 于是资源管理器这一栏可以只当"目录树"用（对齐 DSH 的形态）。
   */
  const openFile = (entry: FsEntry): void => {
    setSelected(entry)
    if (entry.kind !== 'file') return
    wbOpenFile(entry.rel)
  }

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
    // 目录没展开先展开，否则输入框藏在下层看不见
    if (kind !== 'rename' && parentRel && !tree.expanded.has(parentRel)) {
      void loadDir(parentRel)
      setTree((t) => ({ ...t, expanded: new Set(t.expanded).add(parentRel) }))
    }
    setEditing({
      kind,
      parentRel,
      value: kind === 'rename' ? (target?.name ?? '') : '',
      ...(target ? { target } : {})
    })
  }

  const commitEdit = async (): Promise<void> => {
    const e = editing
    if (!e) return
    const name = e.value.trim()
    setEditing(null)
    if (!name) return
    if (name.includes('/') || name.includes('\\')) {
      setNotice({ ok: false, text: '名字里不能带路径分隔符' })
      return
    }
    const rel = e.parentRel ? `${e.parentRel}/${name}` : name
    if (e.kind === 'new-file') await runOp(() => window.api.writeWorkspaceFile(rel, ''), e.parentRel)
    else if (e.kind === 'new-dir') await runOp(() => window.api.createWorkspaceDir(rel), e.parentRel)
    else if (e.target) {
      await runOp(() => window.api.renameWorkspacePath(e.target!.rel, rel), parentOf(e.target.rel))
    }
  }

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
            onChange={(ev) => setEditing((cur) => (cur ? { ...cur, value: ev.target.value } : cur))}
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
          // 只有文件行可拖（拖进输入框当附件）；目录不行 —— 附件是"一个文件的内容"
          draggable={e.kind === 'file'}
          onDragStart={(ev) => {
            if (e.kind !== 'file') return
            ev.dataTransfer.setData(DRAG_PATH_MIME, e.rel)
            ev.dataTransfer.effectAllowed = 'copy'
          }}
          onClick={() => {
            // 点目录也要选中：工具栏「新建」落到选中的文件夹下
            setSelected(e)
            if (e.kind === 'dir') void toggleDir(e)
            else openFile(e)
          }}
          onDragOver={(ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            setDropTarget(e.rel)
          }}
          onDragLeave={() => setDropTarget((t) => (t === e.rel ? null : t))}
          onDrop={(ev) => void handleDrop(ev, e.kind === 'dir' ? e.rel : parentOf(e.rel))}
          onContextMenu={(ev) => {
            ev.preventDefault()
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
  const target = newTarget()
  const targetLabel = target === '' ? '工作区根目录' : target

  return (
    <div
      className={`ex-panel ${dropTarget === '' ? 'ex-panel-drop' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDropTarget('')
      }}
      onDragLeave={() => setDropTarget((t) => (t === '' ? null : t))}
      onDrop={(e) => void handleDrop(e, '')}
      onContextMenu={(e) => {
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
        <span className="ex-tools">
          <button
            className="ex-icon-btn"
            title={`在「${targetLabel}」下新建文件`}
            onClick={() => startEdit('new-file', target)}
          >
            {ICONS.file}
          </button>
          <button
            className="ex-icon-btn"
            title={`在「${targetLabel}」下新建文件夹`}
            onClick={() => startEdit('new-dir', target)}
          >
            {ICONS.dir}
          </button>
          <button className="ex-icon-btn" title="刷新" onClick={() => void loadDir('')}>
            {ICONS.refresh}
          </button>
          <button
            className="ex-icon-btn"
            title="折叠全部"
            onClick={() => setTree((t) => ({ ...t, expanded: new Set() }))}
          >
            {ICONS.collapse}
          </button>
        </span>
      </div>
      <div className="ex-path" title={workspace}>
        {workspace || '（未设置工作区）'}
      </div>

      {notice && <div className={`ex-notice ${notice.ok ? '' : 'ex-notice-bad'}`}>{notice.text}</div>}

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
                  在右侧打开预览
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
              <button
                className="ex-menu-item"
                onClick={() =>
                  startEdit('rename', parentOf(menu.entry!.rel), menu.entry!)
                }
              >
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
