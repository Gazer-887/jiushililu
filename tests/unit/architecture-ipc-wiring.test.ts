// 真IPC→runner→loop→Provider→记忆库整链，仅替换Electron与网络出口，不替换内部装配。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSettings } from '@shared/ipc'

const f = vi.hoisted(() => ({
  root: '', handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>(),
  notices: [] as Array<{ channel: string; payload: { conversationId?: string; written?: string[] } }>
}))
vi.mock('electron', () => ({
  app: { getPath: () => { if (!f.root) throw new Error('测试数据根未设置'); return f.root } },
  ipcMain: { handle: (key: string, fn: (e: unknown, input: unknown) => Promise<unknown>) => f.handlers.set(key, fn) },
  dialog: {}, BrowserWindow: { getAllWindows: () => [] }, shell: {}, clipboard: {},
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('electron-store', () => ({ default: class {
  store: Record<string, unknown> = { memoryEnabled: true }
  get(key: string) { return this.store[key] }
  set(key: string, value: unknown) { this.store[key] = value }
} }))
vi.mock('@main/window-registry', () => ({
  sendToAll: (channel: string, payload: { conversationId?: string; written?: string[] }) => { f.notices.push({ channel, payload }); return 1 },
  getMainWindow: () => null, getWindow: () => null, isWindowOpen: () => false
}))
vi.mock('@main/store/models', async (original) => ({
  ...await original<typeof import('@main/store/models')>(),
  getSettingsView: () => ({ providerType: 'openai-compatible', baseURL: 'https://public.invalid', model: 'public-model',
    temperature: null, topP: null, topK: null, maxTokens: 512, timeoutMs: 1000, stream: false,
    contextWindow: 65536, reasoningEffort: 'default', maxToolRounds: 4, inputModalities: ['text'] } as ModelSettings),
  getDecryptedApiKey: () => 'public-fake-key', hasApiKey: () => true
}))
const { IPC } = await import('@shared/ipc')
const { registerIpcHandlers } = await import('@main/ipc')
const { createAgentContext } = await import('@main/agent/runner')
const { createMemoryStore } = await import('@main/store/memory-store')
const { createPlaybookStore } = await import('@main/store/playbook-store')
const { setHttpFetch } = await import('@main/providers/http-client')
f.root = mkdtempSync(join(tmpdir(), 'jsl-architecture-ipc-'))
let sequence = 0
beforeEach(() => { f.notices.length = 0; f.handlers.clear() })
afterAll(() => {
  setHttpFetch(null)
  expect(resolve(dirname(f.root))).toBe(resolve(tmpdir())); expect(basename(f.root)).toMatch(/^jsl-architecture-ipc-/)
  rmSync(f.root, { recursive: true, force: true })
})

function setup() {
  const memory = createMemoryStore(join(f.root, `memory-case-${++sequence}`), undefined, { ftsPath: null, modelWritesNeedApproval: () => false })
  const agent = createAgentContext({ getWorkspaceRoot: () => f.root, builtinAgentsDir: join(f.root, 'builtin'),
    userAgentsDir: join(f.root, 'agents'), checkpointDir: join(f.root, 'checkpoints'),
    memory: { repo: memory, enabled: () => true } })
  registerIpcHandlers({ agent, memory, userDataDir: f.root, playbook: createPlaybookStore(f.root),
    trash: async () => {}, confirm: { ask: async () => true, respond: () => false, abortAll: () => {} },
    ask: { ask: async () => ({ answered: false as const, reason: 'no-window' as const }), respond: () => false, abortAll: () => {} },
    planApproval: { request: async () => true, respond: () => false, abortAll: () => {} }, terminal: {} as never,
    system: { getBlockers: () => [] } as never, execEventSink: { append: () => {} }, network: {} as never })
  return { memory, agent }
}
function event(id: number, onSend?: (channel: string, payload: unknown) => void) {
  const messages: Array<{ channel: string; payload: unknown }> = []
  return { sender: { id, isDestroyed: () => false, send: (channel: string, payload: unknown) => { messages.push({ channel, payload }); onSend?.(channel, payload) } }, messages }
}
function requestBody(init?: RequestInit): { messages: Array<{ role: string; content: string }> } {
  return JSON.parse(String(init?.body))
}
const response = (message: Record<string, unknown>) => {
  const delta = { ...message, ...(Array.isArray(message.tool_calls) ? {
    tool_calls: message.tool_calls.map((call, index) => ({ ...call, index }))
  } : {}) }
  return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, {
    status: 200, headers: { 'Content-Type': 'text/event-stream' }
  })
}
function remember(name: string) {
  return { id: name, type: 'function', function: { name: 'remember', arguments: JSON.stringify({
    name, description: name, body: `${name} `.repeat(30), class: 'default'
  }) } }
}
function notice(owner: string) { return f.notices.filter((n) => n.channel === IPC.memoryNotice && n.payload.conversationId === owner) }

describe('聊天和一次性任务实际装配', () => {
  it.each(['chat', 'agent'] as const)('聊天A写完停在模型等待，%s B完成后各归本轮', async (mode) => {
    const { memory } = setup(); const suffix = ++sequence
    const aName = `AlphaEditor${suffix}`; const bName = `BetaBuild${suffix}`
    let arrived!: () => void; const waiting = new Promise<void>((r) => { arrived = r })
    let release!: () => void; const finish = new Promise<void>((r) => { release = r })
    setHttpFetch(async (_url, init) => {
      const body = requestBody(init); const a = body.messages.some((m) => m.role === 'user' && m.content === aName)
      const hasTool = body.messages.some((m) => m.role === 'tool')
      if (!hasTool) return response({ content: '', tool_calls: [remember(a ? aName : bName)] })
      if (a) { arrived(); await finish }
      return response({ content: '完成' })
    })
    const aEvent = event(1); const bEvent = event(2)
    const a = f.handlers.get(IPC.chatSend)!(aEvent, { conversationId: `A${suffix}`, messages: [{ role: 'user', content: aName }] })
    try {
      await Promise.race([waiting, a.then(() => { throw new Error(`A未到模型等待：${JSON.stringify(aEvent.messages)}`) })])
      expect(memory.list().entries.map((entry) => entry.name), JSON.stringify(aEvent.messages)).toContain(aName)
      if (mode === 'chat') await f.handlers.get(IPC.chatSend)!(bEvent, { conversationId: `B${suffix}`, messages: [{ role: 'user', content: bName }] })
      else expect(await f.handlers.get(IPC.agentRun)!(bEvent, { task: bName })).toMatchObject({ ok: true })
      const owner = mode === 'chat' ? `B${suffix}` : 'agent-task'
      expect(notice(owner)).toHaveLength(1); expect(notice(owner)[0].payload.written).toEqual([bName])
    } finally { release(); await a }
    expect(notice(`A${suffix}`)).toHaveLength(1); expect(notice(`A${suffix}`)[0].payload.written).toEqual([aName])
  })
  it.each(['chat', 'agent'] as const)('%s的HTTP400错误出口不含上游正文，并释放运行位', async (mode) => {
    setup(); setHttpFetch(async () => new Response('PUBLIC_PRIVATE_BODY_MARKER', { status: 400 }))
    const e = event(3)
    if (mode === 'chat') {
      const payload = { conversationId: 'error-chat', messages: [{ role: 'user', content: '公共错误请求' }] }
      await f.handlers.get(IPC.chatSend)!(e, payload); await f.handlers.get(IPC.chatSend)!(e, payload)
      const errors = e.messages.filter((m) => m.channel === IPC.chatError)
      expect(errors).toHaveLength(2); expect(JSON.stringify(errors)).toContain('400'); expect(JSON.stringify(errors)).not.toContain('PUBLIC_PRIVATE_BODY_MARKER')
    } else {
      const first = await f.handlers.get(IPC.agentRun)!(e, { task: '公共错误请求' })
      const second = await f.handlers.get(IPC.agentRun)!(e, { task: '公共错误请求' })
      expect(JSON.stringify([first, second])).toContain('400'); expect(JSON.stringify([first, second])).not.toContain('PUBLIC_PRIVATE_BODY_MARKER')
      expect(JSON.stringify(second)).not.toContain('已有 Agent')
    }
  })
  it('聊天真实停止入口阻断同帧第二次remember，已写痕迹仍收尾', async () => {
    const { memory, agent } = setup(); const suffix = ++sequence
    const first = `GammaRule${suffix}`; const second = `DeltaPath${suffix}`
    setHttpFetch(async () => response({ content: '', tool_calls: [remember(first), remember(second)] }))
    const e = event(4, (channel, payload) => {
      if (channel === IPC.chatTool && (payload as { payload: { phase: string } }).payload.phase === 'end') {
        void f.handlers.get(IPC.chatAbort)!({}, 'cancel-chat')
      }
    })
    await f.handlers.get(IPC.chatSend)!(e, { conversationId: 'cancel-chat', messages: [{ role: 'user', content: '公共取消' }] })
    expect(memory.list().entries.map((entry) => entry.name), JSON.stringify(e.messages)).toContain(first)
    expect(memory.list().entries.map((entry) => entry.name)).not.toContain(second)
    expect(notice('cancel-chat')[0].payload.written).toEqual([first])
    expect(JSON.stringify(e.messages.filter((m) => m.channel === IPC.chatError))).toContain('已停止生成')
    expect(agent.checkpoints.list().every((run) => run.status !== 'running')).toBe(true)
  })
})
