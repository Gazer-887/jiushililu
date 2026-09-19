// MCP 工具 → AgentTool 的转换层（plan23 S2 / D-061 / D-064）。
// 工具名用 mcp__<server>__<tool>（D-061）：多服务器重名不打架，来源可辨。
// 执行走确认桥（D-064）：服务器是在用户机器上跑的**外部代码**，保守默认每次确认。

import type { AgentTool } from '@shared/agent'
import type { McpManager } from '../../mcp/mcp-manager'
import {
  PROCESS_RISK_NOTE,
  COMPUTER_USE_RISKY_TOOLS,
  forceMainDisplay,
  gateComputerUseTool,
  isWindowsMcpServer
} from '@shared/computer-use'

export interface McpToolDeps {
  manager: McpManager
  /** 执行前确认（D-064）。缺省 = 不确认（仅测试场景；生产装配必传 confirmCommand 的包装） */
  confirm?: (req: { tool: string; detail: string }) => Promise<boolean>
  /**
   * 电脑控制开关（plan44 决策 4，单一真相源 = 通用设置）。**必填**。
   *
   * ⚠️ **为什么不给默认值**（2026-09-19 真机 bug 的教训，D-119 ①）：它原来是 `computerControl?: boolean`，
   * 于是装配层「忘了传」在类型上完全合法 —— 编译通过、测试全绿、运行起来静默全拦。
   * **权限开关的失效方向必须是"关"**，但"忘记传"不该是一种**沉默的**关法：它让排查时面对一个
   * 没有任何痕迹的空状态（连日志都没有）。改为必填后，漏传是**编译错误**，当场就暴露。
   *
   * ⚠️ 调用方请传**确切的布尔值**（`x === true`），不要用 `...(cond ? {x} : {})` 的条件展开 ——
   * 那会让 `false` 变成"字段不存在"，语义上看着等价，实则把"显式关闭"与"压根没设置"混成一回事。
   */
  computerControl: boolean
  /**
   * 被门控拦下的工具名（日志用；决策 3b「未知一律屏蔽并记一条」）。**必填**，理由同上：
   * 漏传它 = 拦了却不说，排查时"该有的日志一条都没有"会把方向带偏（本 bug 就是这么骗过一轮排查的）。
   */
  onGatedDrop: (fullName: string, reason: string) => void
}

export function createMcpTools(deps: McpToolDeps): AgentTool[] {
  // plan34 S2b：被禁 server 的工具天然不下发 —— 开关走配置 `cfg.enabled`（单一真相源），
  // `activeTools()` 只认 connected 态，`enabled=false` 的 server 根本不在里面（manager 已保证）。
  const tools: AgentTool[] = []
  for (const ref of deps.manager.activeTools()) {
    const isDesktop = isWindowsMcpServer(ref.server, ref.launchHint ?? '')
    const decision = gateComputerUseTool({
      isComputerUseServer: isDesktop,
      enabled: deps.computerControl,
      toolName: ref.name
    })
    if (decision !== 'keep') {
      deps.onGatedDrop(ref.fullName, decision)
      continue
    }
    const label = `${ref.server}/${ref.name}`
    const riskyNote =
      isDesktop && COMPUTER_USE_RISKY_TOOLS.includes(ref.name) ? `\n${PROCESS_RISK_NOTE}` : ''
    tools.push({
      schema: {
        name: ref.fullName,
        description: `${ref.description ?? `外部 MCP 工具（服务器 ${ref.server}）`}${riskyNote}`,
        // MCP 的 inputSchema 与本项目工具参数同为 JSON Schema，直接透传（D-066）
        parameters: ref.inputSchema ?? { type: 'object', properties: {} }
      },
      async execute(args) {
        const payload = (args ?? {}) as Record<string, unknown>
        if (deps.confirm) {
          const ok = await deps.confirm({
            tool: ref.fullName,
            detail: `调用外部 MCP 工具 ${label}（参数：${JSON.stringify(payload).slice(0, 300)}）`
          })
          if (!ok) return '用户取消了本次 MCP 工具调用。'
        }
        // D-066：callTool 的错误以人话文本返回（manager 内已处理），模型可读可自纠
        // O2：桌面派只打主屏（display 是工具参数，按 schema 覆写；非桌面派直通）
        return deps.manager.callTool(
          ref.server,
          ref.name,
          isDesktop ? forceMainDisplay(ref.inputSchema, payload) : payload
        )
      }
    })
  }
  return tools
}
