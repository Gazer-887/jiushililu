import { useEffect, useRef, useState } from 'react'
import type { BrowserState } from '@shared/ipc'

// 浏览器面板（P2 右抽屉）：**真浏览器**（主进程的 WebContentsView），不是 iframe 占位。
//
// 关键：原生视图浮在窗口之上，不参与 DOM 布局——所以这里要
// ① 用 ResizeObserver 把本区域的位置尺寸同步给主进程
// ② 面板不可见时通知主进程把视图摘掉（否则它会挡住整个界面）

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

  // 订阅主进程的状态推送
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

  // 视图显隐 + 区域同步
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
      // 面板卸载 → 摘掉原生视图（否则它留在窗口上遮挡界面）
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
          placeholder="输入网址后回车（真实浏览器，Agent 可同时操作）"
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
        />
      </div>

      {/* 原生浏览器视图由主进程按这块区域定位并覆盖上来 */}
      <div ref={hostRef} className="bp-host">
        {!state.url || state.url === 'about:blank' ? (
          <div className="bp-empty">
            <div className="bp-empty-title">内置浏览器</div>
            <div className="bp-empty-desc">
              上方输入网址即可浏览。这是真浏览器（支持 JS 渲染），
              <br />
              Agent 也能直接操控它——你可以让它"打开某网站并读出内容"。
            </div>
          </div>
        ) : null}
      </div>

      {state.loading && <div className="bp-loading">加载中…</div>}
    </div>
  )
}
