import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createMcpManager, type McpManager } from '@main/mcp/mcp-manager'
import { createMcpTools } from '@main/agent/tools/mcp-tools'

// MCP 管理器单测（plan23 S5）：**InMemoryTransport 跑真协议**（不是 mock —— JSON-RPC 帧真实编解码）。
// 判据对应 plan23 §验收 1/2/3/4。

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'jsll-mcp-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** 起一个内存 MCP server：echo 工具（文本回显）+ unknown 时报错 */
async function makeEchoServer(): Promise<{ clientTransport: Transport }> {
  const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: '回显输入文本',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string', description: '要回显的文本' } },
          required: ['text']
        }
      }
    ]
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'echo') {
      const text = (req.params.arguments as { text?: string } | undefined)?.text ?? ''
      return { content: [{ type: 'text', text: `echo: ${text}` }] }
    }
    return { content: [{ type: 'text', text: `未知工具 ${req.params.name}` }], isError: true }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return { clientTransport }
}

function writeConfig(dir: string, servers: unknown[]): void {
  writeFileSync(join(dir, 'mcp-servers.json'), JSON.stringify({ servers }), 'utf8')
}

async function makeManager(
  createTransport: (cfg: { name: string }) => Promise<Transport>
): Promise<McpManager> {
  const dir = tmp()
  writeConfig(dir, [{ name: 'test', transport: 'stdio', command: 'unused', enabled: true }])
  return createMcpManager({
    userDataDir: dir,
    clientVersion: '0.0.0-test',
    createTransport
  })
}

describe('mcp-manager（真协议 · InMemory）', () => {
  it('连接 → 发现工具（mcp__ 前缀）→ 调用返回文本（判据 1）', async () => {
    const { clientTransport } = await makeEchoServer()
    const manager = await makeManager(async () => clientTransport)
    await manager.connectAll()

    expect(manager.hasConnected()).toBe(true)
    const tools = manager.activeTools()
    expect(tools.map((t) => t.fullName)).toEqual(['mcp__test__echo'])
    expect(tools[0]?.inputSchema).toBeDefined()

    const out = await manager.callTool('test', 'echo', { text: '你好' })
    expect(out).toBe('echo: 你好')
  })

  it('server 报错（isError）→ 人话文本返回，不抛异常（判据 2 / D-066）', async () => {
    const { clientTransport } = await makeEchoServer()
    const manager = await makeManager(async () => clientTransport)
    await manager.connectAll()

    const out = await manager.callTool('test', 'no-such-tool', {})
    expect(out).toContain('MCP 工具返回错误')
    expect(out).toContain('未知工具 no-such-tool')
  })

  it('连接失败 → state=error，不阻塞其他流程（D-063）', async () => {
    const manager = await makeManager(async () => {
      throw new Error('进程起不来')
    })
    await manager.connectAll()
    const status = manager.listServers()[0]
    expect(status.state).toBe('error')
    expect(status.error).toContain('进程起不来')
    expect(manager.hasConnected()).toBe(false)
    expect(manager.activeTools()).toEqual([])
  })

  it('未配置任何服务器 → 无工具、不连接（D-065）', async () => {
    const dir = tmp()
    const manager = createMcpManager({
      userDataDir: dir,
      clientVersion: '0.0.0-test',
      createTransport: async () => {
        throw new Error('不该被调用')
      }
    })
    await manager.connectAll()
    expect(manager.hasConnected()).toBe(false)
    expect(manager.activeTools()).toEqual([])
  })
})

describe('createMcpTools（门控与透传）', () => {
  it('执行走确认桥：拒绝 → 不调用，返回取消文案（判据 4）', async () => {
    const { clientTransport } = await makeEchoServer()
    const manager = await makeManager(async () => clientTransport)
    await manager.connectAll()
    const tools = createMcpTools({
      manager,
      confirm: async () => false
    })
    const echo = tools.find((t) => t.schema.name === 'mcp__test__echo')!
    const out = (await echo.execute({ text: '不该被执行' })) as string
    expect(out).toContain('用户取消')
  })

  it('确认通过 → 正常调用；inputSchema 透传给模型（判据 4）', async () => {
    const { clientTransport } = await makeEchoServer()
    const manager = await makeManager(async () => clientTransport)
    await manager.connectAll()
    let confirmCalls = 0
    const tools = createMcpTools({
      manager,
      confirm: async (req) => {
        confirmCalls += 1
        expect(req.tool).toBe('mcp__test__echo')
        return true
      }
    })
    const echo = tools.find((t) => t.schema.name === 'mcp__test__echo')!
    expect(echo.schema.parameters).toBeDefined()
    const out = (await echo.execute({ text: '通过' })) as string
    expect(confirmCalls).toBe(1)
    expect(out).toBe('echo: 通过')
  })
})

// 占位的 Client import 使用（保持显式依赖以便升级时排查）：构造引用而不实例化
void Client
