// MCP 工具 → AgentTool 的转换层（plan23 S2 / D-061 / D-064）。
// 工具名用 mcp__<server>__<tool>（D-061）：多服务器重名不打架，来源可辨。
// 执行走确认桥（D-064）：服务器是在用户机器上跑的**外部代码**，保守默认每次确认。

import type { AgentTool } from '@shared/agent'
import type { McpManager, McpToolRef } from '../../mcp/mcp-manager'

export interface McpToolDeps {
  manager: McpManager
  /** 执行前确认（D-064）。缺省 = 不确认（仅测试场景；生产装配必传 confirmCommand 的包装） */
  confirm?: (req: { tool: string; detail: string }) => Promise<boolean>
}

export function createMcpTools(deps: McpToolDeps): AgentTool[] {
  // plan34 S2b：被禁 server 的工具天然不下发 —— 开关走配置 `cfg.enabled`（单一真相源），
  // `activeTools()` 只认 connected 态，`enabled=false` 的 server 根本不在里面（manager 已保证）。
  return deps.manager.activeTools().map((ref: McpToolRef): AgentTool => {
    const label = `${ref.server}/${ref.name}`
    return {
      schema: {
        name: ref.fullName,
        description: ref.description ?? `外部 MCP 工具（服务器 ${ref.server}）`,
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
        return deps.manager.callTool(ref.server, ref.name, payload)
      }
    }
  })
}
