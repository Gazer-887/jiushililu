import { useEffect, useRef, useState } from 'react'
import type { BrowserState } from '@shared/ipc'

// 浏览器面板：**真浏览器**（主进程 WebContentsView），不是 iframe 占位。
//
// 原生视图浮在窗口之上、不参与 DOM 布局，所以必须：① 用 ResizeObserver 把本区域的位置尺寸
// 同步给主进程；② 本组件卸载时通知主进程摘掉视图（否则它留在窗口上挡住整个界面）。

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
    </div>
  )
}
