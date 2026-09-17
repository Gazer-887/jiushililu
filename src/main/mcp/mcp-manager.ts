// MCP 客户端管理器（plan23 S1）：配置读写（原子写）+ 连接管理 + 工具聚合 + 调用转发。
// ⚠️ 本文件不 import electron：userData 路径与应用版本由组合根注入（同 playbook-store 的架构不变量）。
// 依赖 @modelcontextprotocol/sdk（官方 SDK，plan23 D-060）；该包 ESM-only，由 vite 打进 CJS 产物
// （config/electron.vite.config.ts 的 externalizeDepsPlugin 排除项，D-060 注）。

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  McpSaveResult,
  McpServerConfig,
  McpServerState,
  McpServerStatus,
  McpServerTool
} from '@shared/ipc'

/** 交给 runner 的工具引用：fullName = mcp__<server>__<tool>（D-061） */
export interface McpToolRef {
  server: string
  name: string
  description?: string
  fullName: string
  /** 启动命令+参数（桌面派 server 识别用，plan44 决策 3；SSE 无 command 时为空） */
  launchHint?: string
  /** MCP inputSchema（JSON Schema）—— 与 AgentTool.parameters 同族，直接透传给模型 */
  inputSchema?: Record<string, unknown>
}

interface McpConfigFile {
  servers: McpServerConfig[]
}

const CONFIG_FILE = 'mcp-servers.json'

/** 轻校验（手写，不引 zod 到主进程运行时——SDK 自带的 zod 只服务协议层） */
function validateServerConfig(input: McpServerConfig): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.name)) {
    return 'name 需小写字母/数字/-/_ 组成，1~64 字符，以字母或数字开头'
  }
  if (input.transport === 'stdio' && !input.command) return 'stdio 传输需要 command'
  if (input.transport === 'sse' && !input.url) return 'sse 传输需要 url'
  return null
}

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? '')
  return content
    .map((b) => {
      const block = b as { type?: string; text?: string }
      if (block.type === 'text') return block.text ?? ''
      return `[${block.type ?? '未知'} 类型内容]`
    })
    .join('\n')
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export interface McpManager {
  /** 全部服务器及其状态（配置 ∪ 运行态） */
  listServers(): McpServerStatus[]
  /** 已连接服务器的全部工具（加 mcp__ 前缀），按 server 再按工具名字典序（D-061） */
  activeTools(): McpToolRef[]
  /** 是否存在已连接服务器（D-065：「有消费者才注册」的判定口） */
  hasConnected(): boolean
  saveServer(input: McpServerConfig): McpSaveResult
  deleteServer(name: string): McpSaveResult
  /** 断开并重连（UI「重连」按钮；配置变更后也走它） */
  reconnect(name: string): Promise<McpSaveResult>
  /** 转发调用（D-066：错误以人话返回，不抛异常 —— 让模型看到错误并自纠） */
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<string>
  /** 连接状态变化时通知（UI 刷新） */
  onChange(cb: () => void): () => void
  /** 组合根在启动时调用：全量连接，失败不阻塞（D-063） */
  connectAll(): Promise<void>
}

export function createMcpManager(deps: {
  userDataDir: string
  clientVersion: string
  onWarn?: (w: string) => void
  /** 测试注入：默认按配置建 stdio/SSE transport；传入则忽略 cfg.transport（内存传输跑真协议） */
  createTransport?: (cfg: McpServerConfig) => Promise<Transport>
}): McpManager {
  const configPath = join(deps.userDataDir, CONFIG_FILE)
  const clients = new Map<string, Client>()
  const toolsCache = new Map<string, McpServerTool[]>()
  const errors = new Map<string, string>()
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const cb of listeners) cb()
  }
  const warn = (w: string): void => {
    deps.onWarn?.(w)
  }

  function readConfig(): McpConfigFile {
    if (!existsSync(configPath)) return { servers: [] }
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<McpConfigFile>
      return { servers: Array.isArray(parsed.servers) ? parsed.servers : [] }
    } catch (e) {
      warn(`MCP 配置解析失败（将按空配置处理）：${errText(e)}`)
      return { servers: [] }
    }
  }

  function writeConfig(cfg: McpConfigFile): void {
    // 原子写（D-062）：临时文件 + rename；配置可能含 env token，绝不半写
    const tmp = `${configPath}.tmp`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
    renameSync(tmp, configPath)
  }

  async function connectServer(cfg: McpServerConfig): Promise<void> {
    const invalid = validateServerConfig(cfg)
    if (invalid) {
      errors.set(cfg.name, invalid)
      return
    }
    try {
      const client = new Client({ name: 'jiushililu-mcp', version: deps.clientVersion }, { capabilities: {} })
      const transport = deps.createTransport
        ? await deps.createTransport(cfg)
        : cfg.transport === 'stdio'
          ? new StdioClientTransport({
              command: cfg.command!,
              args: cfg.args ?? [],
              env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
              stderr: 'pipe'
            })
          : new SSEClientTransport(new URL(cfg.url!))
      await client.connect(transport)
      const tools = await client.listTools()
      clients.set(cfg.name, client)
      toolsCache.set(
        cfg.name,
        tools.tools.map((t) => ({
          name: t.name,
          description: t.description,
          ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {})
        }))
      )
      errors.delete(cfg.name)
    } catch (e) {
      // D-063 fail-soft：一个坏 server 拖不垮应用
      errors.set(cfg.name, errText(e))
      warn(`MCP 服务器「${cfg.name}」连接失败：${errText(e)}`)
    }
  }

  async function disconnectServer(name: string): Promise<void> {
    const client = clients.get(name)
    if (!client) return
    try {
      await client.close()
    } catch (e) {
      warn(`MCP 服务器「${name}」断开失败（忽略）：${errText(e)}`)
    }
    clients.delete(name)
    toolsCache.delete(name)
  }

  const manager: McpManager = {
    listServers(): McpServerStatus[] {
      return readConfig().servers.map((cfg) => {
        const state: McpServerState = cfg.enabled
          ? clients.has(cfg.name)
            ? 'connected'
            : 'error'
          : 'disabled'
        return {
          config: cfg,
          state,
          ...(state === 'error' ? { error: errors.get(cfg.name) ?? '未知错误' } : {}),
          tools: toolsCache.get(cfg.name) ?? []
        }
      })
    },

    activeTools(): McpToolRef[] {
      const refs: McpToolRef[] = []
      for (const status of manager.listServers()) {
        if (status.state !== 'connected') continue
        for (const tool of [...status.tools].sort((a, b) => a.name.localeCompare(b.name))) {
          refs.push({
            server: status.config.name,
            name: tool.name,
            ...(tool.description ? { description: tool.description } : {}),
            fullName: `mcp__${status.config.name}__${tool.name}`,
            launchHint: [status.config.command ?? '', ...(status.config.args ?? [])].join(' '),
            ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {})
          })
        }
      }
      return refs.sort((a, b) => a.fullName.localeCompare(b.fullName))
    },

    hasConnected(): boolean {
      return clients.size > 0
    },

    saveServer(input): McpSaveResult {
      const invalid = validateServerConfig(input)
      if (invalid) return { ok: false, reason: invalid }
      const cfg = readConfig()
      const others = cfg.servers.filter((s) => s.name !== input.name)
      // 同名覆盖即"更新"；不同 transport 的字段残留无意义，由调用方传入完整对象
      writeConfig({ servers: [...others, input] })
      return { ok: true }
    },

    deleteServer(name): McpSaveResult {
      const cfg = readConfig()
      const next = cfg.servers.filter((s) => s.name !== name)
      if (next.length === cfg.servers.length) return { ok: false, reason: `没有名为「${name}」的服务器` }
      writeConfig({ servers: next })
      // 先取句柄、清运行态，再 fire-and-forget close（close 异步，句柄不能等 map 清空后去找）
      const client = clients.get(name)
      clients.delete(name)
      toolsCache.delete(name)
      errors.delete(name)
      if (client) void client.close().catch(() => {})
      notify()
      return { ok: true }
    },

    async reconnect(name): Promise<McpSaveResult> {
      const cfg = readConfig().servers.find((s) => s.name === name)
      if (!cfg) return { ok: false, reason: `没有名为「${name}」的服务器（可能已被删除）` }
      await disconnectServer(name)
      if (!cfg.enabled) {
        errors.delete(name)
        notify()
        return { ok: true }
      }
      await connectServer(cfg)
      notify()
      return { ok: true }
    },

    async callTool(server, tool, args): Promise<string> {
      const client = clients.get(server)
      if (!client) return `MCP 服务器「${server}」未连接，无法调用 ${tool}。`
      try {
        const result = await client.callTool({ name: tool, arguments: args })
        const text = contentToText(result.content)
        // D-066：isError 以人话返回（不抛异常）—— 让模型看到错误并自纠
        return result.isError ? `MCP 工具返回错误：${text}` : text
      } catch (e) {
        return `MCP 调用失败（${server}/${tool}）：${errText(e)}`
      }
    },

    onChange(cb): () => void {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },

    async connectAll(): Promise<void> {
      for (const cfg of readConfig().servers) {
        if (!cfg.enabled) continue
        await connectServer(cfg)
      }
      notify()
    }
  }

  return manager
}
