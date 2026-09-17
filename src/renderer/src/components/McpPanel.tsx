import { useCallback, useEffect, useState } from 'react'
import type { McpServerConfig, McpServerStatus, McpTransportKind } from '@shared/ipc'

// MCP 服务器管理分区（plan23 S4）：列表（状态徽标 / 工具数）+ 增删 + 重连。
// 配置住 userData/mcp-servers.json（含 env token —— 用户资产，不入 git）；执行走确认桥（D-064）。

const STATE_LABEL: Record<McpServerStatus['state'], string> = {
  connected: '已连接',
  error: '连接失败',
  disabled: '已停用'
}

const TRANSPORT_LABEL: Record<McpTransportKind, string> = {
  stdio: 'stdio（本地进程）',
  sse: 'SSE（远程）'
}

type Draft = McpServerConfig

const EMPTY_DRAFT: Draft = { name: '', transport: 'stdio', command: '', args: [], env: {}, url: '', enabled: true }

/** env 编辑用「每行 KEY=VALUE」；解析失败的原样保留在输入框里，保存时再校验 */
function parseEnvText(text: string): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const eq = t.indexOf('=')
    if (eq <= 0) return null
    out[t.slice(0, eq).trim()] = t.slice(eq + 1)
  }
  return out
}

export default function McpPanel(): JSX.Element {
  const [servers, setServers] = useState<McpServerStatus[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [envText, setEnvText] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const reload = useCallback((): void => {
    // plan34 S2b：开关状态就在 `cfg.enabled` 里（配置即真相源），listServers 直接带出，无需另拉名单
    void window.api.mcpListServers().then(setServers)
  }, [])

  useEffect(() => {
    reload()
    // 状态变化（连接/断开/重连完成）由主进程广播：所有窗口各自重读
    return window.api.onMcpChanged(reload)
  }, [reload])

  const save = async (): Promise<void> => {
    if (!draft) return
    const env = parseEnvText(envText)
    if (env === null) {
      setNotice({ ok: false, text: '环境变量格式不对：每行应为 KEY=VALUE' })
      return
    }
    const r = await window.api.mcpSaveServer({ ...draft, env })
    setNotice({ ok: r.ok, text: r.ok ? '已保存并尝试连接' : (r.reason ?? '保存失败') })
    if (r.ok) setDraft(null)
    reload()
  }

  const remove = async (name: string): Promise<void> => {
    const r = await window.api.mcpDeleteServer(name)
    setNotice({ ok: r.ok, text: r.ok ? '已删除' : (r.reason ?? '删除失败') })
    reload()
  }

  const reconnect = async (name: string): Promise<void> => {
    const r = await window.api.mcpReconnect(name)
    setNotice({ ok: r.ok, text: r.ok ? '已重连' : (r.reason ?? '重连失败') })
    reload()
  }

  /**
   * plan34 S2b：开关 = **写配置 `enabled` + reconnect** —— Q2 拍板的「真断开」：
   * 关 → 存盘（connectAll 今后跳过它）+ 立即断开进程；开 → 存盘 + 立即连接。
   * reconnect 两向都处理好了（先 disconnect，再按 enabled 决定连不连），不用新 API。
   */
  const toggleEnabled = async (s: McpServerStatus): Promise<void> => {
    const next = !(s.config.enabled !== false)
    const r = await window.api.mcpSaveServer({ ...s.config, enabled: next })
    if (!r.ok) {
      setNotice({ ok: false, text: r.reason ?? '开关失败' })
      return
    }
    await window.api.mcpReconnect(s.config.name) // notify() 会让列表自动刷新
  }

  return (
    <div className="mcp-panel">
      <p className="mcp-intro">
        MCP（Model Context Protocol）让接入**外部工具服务器**像装插件一样简单：配置一个本地进程（stdio）
        或远程地址（SSE），它声明的工具会以 <code>mcp__服务器名__工具名</code> 出现在 Agent 的工具清单里。
        每次调用前都会向你确认。
        开关是<strong>真关</strong>：关闭后它的工具不再下发给模型（不是只藏界面），下一轮对话即生效。
      </p>

      {notice ? <p className={notice.ok ? 'mcp-notice-ok' : 'mcp-notice-bad'}>{notice.text}</p> : null}

      <div className="mcp-list">
        {servers === null ? (
          <p className="mcp-loading">加载中…</p>
        ) : servers.length === 0 ? (
          <p className="mcp-empty">尚未配置任何 MCP 服务器。</p>
        ) : (
          servers.map((s) => (
            <div key={s.config.name} className={`mcp-server ${s.config.enabled === false ? 'mcp-server-off' : ''}`}>
              <div className="mcp-server-head">
                <span className="mcp-server-name">{s.config.name}</span>
                <span className={`mcp-server-state mcp-state-${s.state}`}>{STATE_LABEL[s.state]}</span>
                <span className="mcp-server-transport">{TRANSPORT_LABEL[s.config.transport]}</span>
                <span className="mcp-server-tools">
                  {s.state === 'connected' ? `${s.tools.length} 个工具` : s.config.enabled === false ? '已关闭' : '工具未知'}
                </span>
                <label
                  className="skills-item-switch"
                  title={s.config.enabled === false ? '已关闭：进程已断开，工具不下发给模型' : '开启中'}
                >
                  <input type="checkbox" checked={s.config.enabled !== false} onChange={() => void toggleEnabled(s)} />
                  <span>{s.config.enabled === false ? '已关' : '开启'}</span>
                </label>
              </div>
              {s.error ? <p className="mcp-server-error">{s.error}</p> : null}
              <div className="mcp-server-actions">
                <button className="mcp-btn" onClick={() => void reconnect(s.config.name)}>
                  重连
                </button>
                <button className="mcp-btn" onClick={() => void remove(s.config.name)}>
                  删除
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {draft === null ? (
        <button
          className="mcp-btn mcp-btn-add"
          onClick={() => {
            setDraft({ ...EMPTY_DRAFT })
            setEnvText('')
          }}
        >
          添加服务器
        </button>
      ) : (
        <div className="mcp-form">
          <label className="mcp-field">
            <span>名称（小写字母/数字/-/_）</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="filesystem"
            />
          </label>
          <label className="mcp-field">
            <span>传输方式</span>
            <select
              value={draft.transport}
              onChange={(e) => setDraft({ ...draft, transport: e.target.value as McpTransportKind })}
            >
              <option value="stdio">stdio（本地进程）</option>
              <option value="sse">SSE（远程地址）</option>
            </select>
          </label>
          {draft.transport === 'stdio' ? (
            <>
              <label className="mcp-field">
                <span>启动命令</span>
                <input
                  value={draft.command ?? ''}
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  placeholder="npx"
                />
              </label>
              <label className="mcp-field">
                <span>参数（空格分隔）</span>
                <input
                  value={(draft.args ?? []).join(' ')}
                  onChange={(e) => setDraft({ ...draft, args: e.target.value.split(' ').filter(Boolean) })}
                  placeholder="-y @modelcontextprotocol/server-filesystem /path/to/dir"
                />
              </label>
            </>
          ) : (
            <label className="mcp-field">
              <span>SSE 地址</span>
              <input
                value={draft.url ?? ''}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                placeholder="http://localhost:3000/sse"
              />
            </label>
          )}
          <label className="mcp-field">
            <span>环境变量（每行 KEY=VALUE，可留空）</span>
            <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} rows={3} />
          </label>
          <label className="mcp-field mcp-field-check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            <span>启用（启动时自动连接）</span>
          </label>
          <div className="mcp-form-actions">
            <button className="mcp-btn" onClick={() => void save()}>
              保存并连接
            </button>
            <button className="mcp-btn" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
