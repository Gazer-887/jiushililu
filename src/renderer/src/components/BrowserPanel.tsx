import { useEffect, useRef, useState } from 'react'
import type { BrowserState } from '@shared/ipc'

// 浏览器面板：**真浏览器**（主进程 WebContentsView），不是 iframe 占位。
//
// 原生视图浮在窗口之上、不参与 DOM 布局，所以必须：① 用 ResizeObserver 把本区域的位置尺寸
// 同步给主进程；② 本组件卸载时通知主进程摘掉视图（否则它留在窗口上挡住整个界面）。
// plan60：标签条（多标签）+ 截图预览 + 外部浏览器打开（D-157 兼容小入口）。

export default function BrowserPanel(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<BrowserState>({
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false
  })
  const [addr, setAddr] = useState('')
  // plan60：截图预览（base64 data URL，关掉即丢，不落盘 —— 落盘是 agent 截图工具那条路）
  const [preview, setPreview] = useState<string | null>(null)
  const [shotBusy, setShotBusy] = useState(false)

  useEffect(() => {
    void window.api.getBrowserState().then((s) => {
      setState(s)
      if (s.url && s.url !== 'about:blank') setAddr(s.url)
    })
    return window.api.onBrowserChanged((s) => {
      setState(s)
      if (s.url && s.url !== 'about:blank' && document.activeElement?.tagName !== 'INPUT') {
        setAddr(s.url)
      }
    })
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const sync = (): void => {
      const r = host.getBoundingClientRect()
      void window.api.setBrowserBounds({ x: r.left, y: r.top, width: r.width, height: r.height })
    }

    void window.api.setBrowserVisible(true)
    sync()

    const ro = new ResizeObserver(sync)
    ro.observe(host)
    window.addEventListener('resize', sync)

    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
      void window.api.setBrowserVisible(false)
    }
  }, [])

  const go = (): void => {
    const url = addr.trim()
    if (url) void window.api.browserNavigate(url)
  }

  const tabs = state.tabs ?? []
  const activeTabId = state.activeTabId ?? ''

  const shot = (): void => {
    if (shotBusy) return
    setShotBusy(true)
    void window.api
      .browserScreenshot()
      .then((r) => setPreview(`data:image/png;base64,${r.base64}`))
      .catch(() => setPreview(null))
      .finally(() => setShotBusy(false))
  }

  return (
    <div className="browser-panel">
      <div className="bp-bar">
        <button
          className="bp-btn"
          title="后退"
          disabled={!state.canGoBack}
          onClick={() => void window.api.browserBack()}
        >
          ‹
        </button>
        <button
          className="bp-btn"
          title="前进"
          disabled={!state.canGoForward}
          onClick={() => void window.api.browserForward()}
        >
          ›
        </button>
        <button className="bp-btn" title="刷新" onClick={() => void window.api.browserReload()}>
          ⟳
        </button>
        <input
          className="bp-addr"
          value={addr}
          placeholder="输入网址后按回车"
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
        />
        {/* plan60：截图（预览看一眼就关，不落盘）+ 外部浏览器打开（D-157 兼容小入口） */}
        <button
          className="bp-btn"
          title="截取当前页（只预览，不保存）"
          disabled={shotBusy}
          onClick={() => shot()}
        >
          📷
        </button>
        <button
          className="bp-btn"
          title="在外部浏览器中打开当前页"
          disabled={!state.url || state.url === 'about:blank'}
          onClick={() => {
            if (state.url) void window.api.browserOpenExternal(state.url)
          }}
        >
          ↗
        </button>
      </div>

      {/* plan60：标签条（切走的标签不丢状态；关到零个时回空态，不强留空白标签） */}
      <div className="bp-tabs">
        {tabs.map((t) => (
          <span key={t.id} className={`bp-tab${t.id === activeTabId ? ' on' : ''}`}>
            <button
              className="bp-tab-name"
              title={t.url}
              onClick={() => void window.api.browserTabSelect(t.id)}
            >
              {t.title || t.url || t.id}
            </button>
            <button
              className="bp-tab-x"
              title="关闭该标签页"
              onClick={() => void window.api.browserTabClose(t.id)}
            >
              ×
            </button>
          </span>
        ))}
        <button
          className="bp-btn"
          title="新建标签页"
          onClick={() => void window.api.browserTabNew()}
        >
          ＋
        </button>
      </div>

      {/* 原生视图由主进程按这块区域定位覆盖上来（所以这里本身是空的） */}
      <div ref={hostRef} className="bp-host">
        {!state.url || state.url === 'about:blank' ? (
          <div className="bp-empty">
            <div className="bp-empty-title">内置浏览器</div>
          </div>
        ) : null}
      </div>

      {state.loading && <div className="bp-loading">加载中…</div>}

      {/* plan60：截图预览（看一眼就关；要存档走 agent 截图工具那条落盘路） */}
      {preview && (
        <div className="bp-shot">
          <img className="bp-shot-img" src={preview} alt="当前页截图预览" />
          <button className="bp-btn" title="关闭预览" onClick={() => setPreview(null)}>
            关闭
          </button>
        </div>
      )}
    </div>
  )
}
