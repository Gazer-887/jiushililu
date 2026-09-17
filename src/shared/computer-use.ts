/**
 * computer-use 门控（plan44 S1）—— 白名单与判据的单一真相源（主/渲染共读）。
 *
 * 哲学（决策 3b）：**白名单命中才放行，未知一律屏蔽并记日志** —— Windows-MCP 升级新增的
 * 工具名不该自动获得权限。门控只作用于桌面派 server（识别：server 名或启动命令含 windows-mcp），
 * 其他 MCP server 不受本闸影响。
 */

export const COMPUTER_USE_LAUNCH_HINT = 'windows-mcp'

/** 放行清单（决策 3；`Process` 按 01:36 裁决放行 + 描述标注风险） */
export const COMPUTER_USE_ALLOWLIST: readonly string[] = [
  'Screenshot',
  'Snapshot',
  'Click',
  'Type',
  'Scroll',
  'Move',
  'Shortcut',
  'Wait',
  'WaitFor',
  'App',
  'MultiSelect',
  'MultiEdit',
  'Clipboard',
  'Notification',
  'Process'
]

/** 描述里必须带风险标注的放行项 */
export const COMPUTER_USE_RISKY_TOOLS: readonly string[] = ['Process']
export const PROCESS_RISK_NOTE = '⚠️ 可终止任意进程，破坏力真实 —— 调用前必须向用户说明目标。'

/**
 * 主屏强制（O2 裁决的落地修正）：上游文档实证 `display` 是**工具参数**而非启动参数
 * （启动只有 --transport/--tools 等），故在门控侧按 inputSchema 如实覆写：
 * array → [0]，integer/number → 0，schema 里没有 display 参数就不动（不猜）。
 */
export function forceMainDisplay(
  inputSchema: Record<string, unknown> | undefined,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const props = inputSchema?.properties as
    | Record<string, { type?: string }>
    | undefined
  const d = props?.display
  if (!d) return payload
  if (d.type === 'array') return { ...payload, display: [0] }
  if (d.type === 'integer' || d.type === 'number') return { ...payload, display: 0 }
  return payload
}

/** 桌面派 server 识别：配置名或启动命令含 windows-mcp（推荐卡片写入的就是这套命名） */
export function isWindowsMcpServer(serverName: string, launchHint: string): boolean {
  const hay = `${serverName} ${launchHint}`.toLowerCase()
  return hay.includes(COMPUTER_USE_LAUNCH_HINT)
}

export type GateDecision = 'keep' | 'drop-server-off' | 'drop-not-allowlisted'

/** 纯门控判据（单测钉死）：非桌面派直通；桌面派未开关全拦；开启时命中白名单才放行 */
export function gateComputerUseTool(args: {
  isComputerUseServer: boolean
  enabled: boolean
  toolName: string
}): GateDecision {
  if (!args.isComputerUseServer) return 'keep'
  if (!args.enabled) return 'drop-server-off'
  return COMPUTER_USE_ALLOWLIST.includes(args.toolName) ? 'keep' : 'drop-not-allowlisted'
}
