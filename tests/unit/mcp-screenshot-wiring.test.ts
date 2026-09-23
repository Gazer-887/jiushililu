// 截图怎么走到界面上、又为什么走不到模型嘴里（plan44 S2b 的两条承重通路）。
// 这一片修的是"点了截图，界面只给一行字"；而它最容易被修成新问题 ——
// **把 base64 塞进上下文**：那既烧 token，又让每次存档重写一遍图片（plan10 分层白做）。
// 所以两条判据各管一头：图必须到得了界面，也必须到不了模型。

import { describe, expect, it } from 'vitest'
import { runAgentLoop } from '@main/agent/loop'
import { createMcpTools } from '@main/agent/tools/mcp-tools'
import type { McpCallResult, McpImagePart, McpManager } from '@main/mcp/mcp-manager'
import type { AgentChatResult, AgentMessage, AgentTool, ToolEvent, ToolImageRef } from '@shared/agent'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function shotTool(outcome: string | { text: string; images?: ToolImageRef[] }): AgentTool {
  return {
    schema: {
      name: 'shot',
      description: '截图',
      parameters: { type: 'object', properties: {} }
    },
    async execute() {
      return outcome
    }
  }
}

async function oneRound(outcome: string | { text: string; images?: ToolImageRef[] }): Promise<{
  events: ToolEvent[]
  toModel: AgentMessage[]
}> {
  const events: ToolEvent[] = []
  const toModel: AgentMessage[] = []
  let round = 0
  await runAgentLoop({
    systemPrompt: '测试',
    history: [{ role: 'user', content: '截一张图' }],
    tools: [shotTool(outcome)],
    chat: async (messages) => {
      round++
      toModel.push(...messages.slice(-1))
      if (round === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'shot', arguments: '{}' }] } satisfies AgentChatResult
      }
      return { text: '好了', toolCalls: [] } satisfies AgentChatResult
    },
    onToolEvent: (e) => void events.push(e)
  })
  return { events, toModel }
}

describe('主循环：图片引用只交给界面事件', () => {
  it('工具返回 ToolOutcome → 工具事件带 images，而**回灌给模型的那条只有文本**', async () => {
    const ref: ToolImageRef = { name: '20260924T022033-0-abcdef.png', mime: 'image/png', bytes: 68 }
    const { events, toModel } = await oneRound({ text: '屏幕已捕获（约 0 KB，已存为界面可查看的截图）', images: [ref] })
    const end = events.find((e) => e.phase === 'end')
    expect(end?.images).toEqual([ref])
    // 模型侧：既没有 base64，也没有文件名 —— 它连"去哪张图"都不该知道，界面才知道
    const joined = JSON.stringify(toModel)
    expect(joined).not.toContain(PNG)
    expect(joined).not.toContain(ref.name)
  })

  it('阳性对照：工具只回文本时，事件里**不出现** images 字段（空数组也算"有截图"是假账）', async () => {
    const { events } = await oneRound('纯文本结果')
    const end = events.find((e) => e.phase === 'end')
    expect(end).toBeDefined()
    expect('images' in (end ?? {})).toBe(false)
  })
})

describe('MCP 工具层：交图给装配根注入的落盘函数', () => {
  const managerWith = (result: McpCallResult): McpManager =>
    ({
      hasConnected: () => true,
      activeTools: () => [
        { server: 'desk', name: 'screenshot', fullName: 'mcp__desk__screenshot', inputSchema: { type: 'object', properties: {} } }
      ],
      callTool: async () => result
    }) as unknown as McpManager

  const depsOf = (saved: ToolImageRef[], seen: McpImagePart[][]) => ({
    manager: managerWith({ text: '屏幕已捕获', images: [{ mime: 'image/png', base64: PNG }] }),
    computerControl: true,
    onGatedDrop: () => {},
    saveImages: (imgs: McpImagePart[]) => {
      seen.push(imgs)
      return saved
    }
  })

  it('manager 给出图片 → 调一次落盘，工具结果为 ToolOutcome（带引用）', async () => {
    const seen: McpImagePart[][] = []
    const ref: ToolImageRef = { name: '20260924T022033-0-abcdef.png', mime: 'image/png', bytes: 68 }
    const tools = createMcpTools(depsOf([ref], seen))
    const out = await tools[0]!.execute({})
    expect(seen).toHaveLength(1)
    expect(seen[0]?.[0]?.base64).toBe(PNG)
    expect(out).toEqual({ text: '屏幕已捕获', images: [ref] })
  })

  it('落盘被拒（类型不收 / 超上限，返回空引用）→ 退回纯文本，不造一个空 images 骗界面', async () => {
    const seen: McpImagePart[][] = []
    const tools = createMcpTools(depsOf([], seen))
    const out = await tools[0]!.execute({})
    expect(typeof out).toBe('string')
    expect(out).toBe('屏幕已捕获')
  })
})
