import { afterAll, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpManager } from '@main/mcp/mcp-manager'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const root = mkdtempSync(join(tmpdir(), 'jsll-mcp-lifecycle-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
writeFileSync(join(root, 'mcp-servers.json'), JSON.stringify({ servers: [
  { name: 'test', transport: 'stdio', command: 'unused', enabled: true }
] }))

it('握手失败后仍释放已创建的传输', async () => {
  const close = vi.fn(async () => {})
  const transport: Transport = {
    start: async () => { throw new Error('握手故障') },
    send: async () => {}, close
  }
  const manager = createMcpManager({ userDataDir: root, clientVersion: 'test',
    createTransport: async () => transport })
  await manager.connectAll()
  expect(close).toHaveBeenCalled()
  expect(close).toHaveBeenCalledTimes(1)
  expect(manager.hasConnected()).toBe(false)
})

it('释放在途传输后禁止重新连接，迟到的 transport 也会关闭', async () => {
  let created!: (transport: Transport) => void
  const close = vi.fn(async () => {})
  const manager = createMcpManager({ userDataDir: root, clientVersion: 'test',
    createTransport: () => new Promise((resolve) => { created = resolve }) })
  const connecting = manager.connectAll()
  const first = manager.dispose()
  expect(manager.dispose()).toBe(first)
  await first
  created({ start: async () => {}, send: async () => {}, close })
  await connecting
  expect(close).toHaveBeenCalledTimes(1)
  expect(manager.hasConnected()).toBe(false)
  expect(await manager.reconnect('test')).toMatchObject({ ok: false, reason: 'MCP 正在关闭' })
})

it('真实协议工具调用在途时释放连接，未完成请求成为失败而不是假成功', async () => {
  const server = new Server({ name: 'fixture', version: 'test' }, { capabilities: { tools: {} } })
  let reached!: () => void
  const waiting = new Promise<void>((resolve) => { reached = resolve })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'wait', inputSchema: { type: 'object' } }] }))
  server.setRequestHandler(CallToolRequestSchema, async () => { reached(); return new Promise(() => {}) })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const manager = createMcpManager({ userDataDir: root, clientVersion: 'test', createTransport: async () => clientTransport })
  await manager.connectAll()
  const call = manager.callTool('test', 'wait', {})
  await waiting
  await manager.dispose()
  expect((await call).text).toContain('MCP 调用失败')
  expect(manager.hasConnected()).toBe(false)
  await server.close()
})
