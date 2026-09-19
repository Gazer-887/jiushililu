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
import { createAllTools, type ToolHooks } from '@main/agent/runner'

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

/** 走**真实装配口**取本轮下发的工具名 —— 这才是"用户实际拿到的清单" */
function toolNames(hooks: ToolHooks): string[] {
  return createAllTools(process.cwd(), hooks).map((t) => t.schema.name)
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
      confirm: async () => false,
      // 非桌面派 server 不受门控影响，但这两个字段**必填**（D-119 ① 复查后收紧）
      computerControl: false,
      onGatedDrop: () => {}
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
      },
      computerControl: false,
      onGatedDrop: () => {}
    })
    const echo = tools.find((t) => t.schema.name === 'mcp__test__echo')!
    expect(echo.schema.parameters).toBeDefined()
    const out = (await echo.execute({ text: '通过' })) as string
    expect(confirmCalls).toBe(1)
    expect(out).toBe('echo: 通过')
  })
})

// ── 装配层透传（2026-09-19 真机 bug 的回归测试）────────────────────────────
// 事故：`createAllTools` 调 `createMcpTools` 时**漏传** `computerControl` / `onGatedDrop`，
// 于是桌面派工具被整体丢弃、且一条日志都不留。**纯判据单测与非桌面派单测都验不出来** ——
// 病根在"hooks → 装配 → 门控"这条缝上，所以这里必须在 `createAllTools` 这一层断言。
describe('装配层透传：桌面派门控（回归 · 2026-09-19）', () => {
  /** 起一个 `windows-mcp` 派内存 server：白名单内的 Screenshot + 名单外的 PowerShell */
  async function makeDesktopServer(): Promise<{ clientTransport: Transport }> {
    const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: ['Screenshot', 'Snapshot', 'PowerShell'].map((name) => ({
        name,
        description: `${name} 工具`,
        inputSchema: { type: 'object', properties: {} }
      }))
    }))
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: 'ok' }]
    }))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    return { clientTransport }
  }

  async function makeDesktopManager(): Promise<McpManager> {
    const { clientTransport } = await makeDesktopServer()
    const dir = tmp()
    writeConfig(dir, [
      { name: 'windows-mcp', transport: 'stdio', command: 'uvx', args: ['windows-mcp', 'serve'], enabled: true }
    ])
    const manager = createMcpManager({
      userDataDir: dir,
      clientVersion: '0.0.0-test',
      createTransport: async () => clientTransport
    })
    await manager.connectAll()
    expect(manager.activeTools().length).toBe(3) // 前置：三条都在 manager 里（门控还没上）
    return manager
  }

  it('开关关闭 → 白名单内的也不下发（drop-server-off）', async () => {
    const manager = await makeDesktopManager()
    const names = toolNames({ mcp: { manager, computerControl: false } })
    expect(names).not.toContain('mcp__windows-mcp__Screenshot')
    expect(names).not.toContain('mcp__windows-mcp__Snapshot')
    expect(names).not.toContain('mcp__windows-mcp__PowerShell')
  })

  it('⚠️ 开关通过 hooks 传到装配层 → 白名单内下发、名单外仍拦（漏传的话这里全空）', async () => {
    const manager = await makeDesktopManager()
    const names = toolNames({ mcp: { manager, computerControl: true } })
    expect(names).toContain('mcp__windows-mcp__Screenshot')
    expect(names).toContain('mcp__windows-mcp__Snapshot')
    expect(names).not.toContain('mcp__windows-mcp__PowerShell')
  })

  it('两类原因都上报：关着时白名单内也拦、开着时只拦名单外', async () => {
    // ⚠️ 断言只钉"拦了哪些、为什么拦"这两条**硬事实**，不掺任何执行路径假设
    // （D-119 ① 复查意见：原先的写法把"漏传"与"确认桥"绑在一起，将来若按权限档调整
    //  确认桥的注入条件，这条回归测试会把正确实现判红）。
    const closed = await makeDesktopManager()
    const dropsClosed: Array<{ name: string; reason: string }> = []
    toolNames({
      mcp: {
        manager: closed,
        computerControl: false,
        onGatedDrop: (fullName, reason) => dropsClosed.push({ name: fullName, reason })
      }
    })
    expect(dropsClosed.map((d) => d.name).sort()).toEqual([
      'mcp__windows-mcp__PowerShell',
      'mcp__windows-mcp__Screenshot',
      'mcp__windows-mcp__Snapshot'
    ])
    expect(dropsClosed.every((d) => d.reason === 'drop-server-off')).toBe(true)

    const opened = await makeDesktopManager()
    const dropsOpened: Array<{ name: string; reason: string }> = []
    toolNames({
      mcp: {
        manager: opened,
        computerControl: true,
        onGatedDrop: (fullName, reason) => dropsOpened.push({ name: fullName, reason })
      }
    })
    expect(dropsOpened).toEqual([{ name: 'mcp__windows-mcp__PowerShell', reason: 'drop-not-allowlisted' }])
  })

  it('hooks 不提供 onGatedDrop 时也有默认落点（不许"拦了却不说"）', async () => {
    // `onGatedDrop` 在 ToolHooks 上是可选的，但 `createMcpTools` 必填 —— 装配层必须兜底。
    // 这条防的是"回调为空 ⇒ 日志一条都没有 ⇒ 排查被带偏"（本 bug 的真实现场）。
    const manager = await makeDesktopManager()
    const names = toolNames({ mcp: { manager, computerControl: true } })
    expect(names).toContain('mcp__windows-mcp__Screenshot') // 兜底没把功能弄坏
  })
})

// 占位的 Client import 使用（保持显式依赖以便升级时排查）：构造引用而不实例化
void Client
