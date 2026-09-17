import { useEffect, useState } from 'react'
import type { McpServerStatus } from '@shared/ipc'

/** 风险披露（决策 8，逐字）—— 最后一句是技术天花板，不粉饰 */
const RISK_LINES = [
  '截取你的整个屏幕（包括其他窗口的内容）',
  '模拟鼠标点击与键盘输入，作用于**任何**前台窗口',
  '读取窗口标题与 UI 元素文本'
]

/**
 * computer-use 推荐卡片（plan44 S3）：只说明、只写配置——不代装、不代开开关。
 * 两道闸：① 这里「添加」写入 MCP 配置；② 通用设置的「电脑控制」开关。缺依赖 uv 时置灰。
 */
export default function ComputerUseRecommend(): React.ReactElement | null {
  const [servers, setServers] = useState<McpServerStatus[] | null>(null)
  const [uvReady, setUvReady] = useState<boolean | null>(null)
  const [showRisk, setShowRisk] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    void window.api.mcpListServers().then(setServers)
    void window.api
      .detectRuntimes(false)
      .then((snap) => {
        const uv = snap.groups.find((g) => g.id === 'uv')
        setUvReady((uv?.main.length ?? 0) + (uv?.others.length ?? 0) > 0)
      })
      .catch(() => setUvReady(false))
  }, [])

  const added = (servers ?? []).some(
    (s) => s.config.name === 'windows-mcp' || String(s.config.command ?? '').includes('windows-mcp')
  )
  if (servers === null) return null

  async function add(): Promise<void> {
    const r = await window.api.mcpSaveServer({
      name: 'windows-mcp',
      transport: 'stdio',
      command: 'uvx',
      args: ['windows-mcp', 'serve'],
      enabled: true
    })
    setNote(
      r.ok
        ? '已写入 MCP 配置。启用还需两步：到「通用设置」打开「电脑控制」开关；首次调用仍会逐次确认。'
        : `添加失败：${r.ok ? '' : (r as { error?: string }).error ?? '未知错误'}`
    )
    if (r.ok) setServers(await window.api.mcpListServers())
  }

  return (
    <div className="cu-card">
      <div className="cu-head">
        <b>电脑操作（computer-use）</b>
        <span className={`cu-tag ${added ? 'is-added' : ''}`}>{added ? '已添加' : '未启用'}</span>
      </div>
      <p className="cu-desc">
        让 AI 能看见屏幕并操作鼠标键盘，用于没有 API 的桌面软件。本期仅支持主显示器。
      </p>
      <p className="cu-meta">
        依赖：uv（{uvReady === true ? '已检测到' : uvReady === false ? '未检测到，请刷新' : '检测中…'}）
        <br />
        来源：windows-mcp（MIT，开源桌面自动化 MCP server）
      </p>
      <div className="cu-actions">
        <button type="button" className="btn-secondary" onClick={() => setShowRisk(true)}>
          查看风险说明
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={added || uvReady !== true}
          title={uvReady === false ? '未检测到 uv，无法启动该服务（安装请自理或交给 Agent）' : undefined}
          onClick={() => setShowRisk(true)}
        >
          {added ? '已添加' : '添加'}
        </button>
      </div>
      {note.length > 0 && <p className="hint">{note}</p>}
      {showRisk && (
        <div className="voice-disclosure-mask" onClick={() => setShowRisk(false)}>
          <div className="voice-disclosure" onClick={(e) => e.stopPropagation()}>
            <h3>开启后，AI 将能够：</h3>
            <ul className="cu-risk-list">
              {RISK_LINES.map((l) => (
                <li key={l}>{l.replace(/\*\*/g, '')}</li>
              ))}
            </ul>
            <p><b>这意味着：</b>如果 AI 误判，它可能在你不知情时点击或输入。涉及转账、删除、发送等操作的界面，请勿在开启状态下离开电脑。</p>
            <p><b>我们已做的限制：</b>屏蔽了文件系统、注册表、PowerShell 类工具，避免绕过工作区边界。</p>
            <p><b>我们做不到的：</b>无法区分“你本人”与“AI”的输入——操作系统层面它们是一样的。</p>
            <div className="voice-disclosure-actions">
              <button type="button" className="btn-secondary" onClick={() => setShowRisk(false)}>
                返回
              </button>
              {!added && uvReady === true && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    setShowRisk(false)
                    void add()
                  }}
                >
                  我已了解，添加服务
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
