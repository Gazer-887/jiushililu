import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelSettings } from '@shared/ipc'
import type { AgentChatResult, AgentMessage, AgentLoopResult, AgentTool } from '@shared/agent'
import { ToolGate } from './guard'
import { createFileTools } from './tools/file-tools'
import { mergeAgentLayers } from './loader'
import { runAgentLoop } from './loop'
import { chatWithToolsOpenAI } from '../providers/openai-agent'
import { chatWithToolsAnthropic } from '../providers/anthropic-agent'

// Agent 运行入口（IPC agent:run 的后端）：把加载器、门控、工具、Provider 通道拼成一杆枪。
// 职责单一：不碰 UI、不碰流式对话——那是 ChatView 与 chat:* 通道的事。

export interface AgentRuntimeContext {
  /** Agent 专属工作区：文件工具只能在这里读写（app userData/agent-workspace） */
  workspaceRoot: string
  /** 内置 Agent 定义目录（打包资源随 extraResources 分发） */
  builtinAgentsDir: string
  /** 用户自定义 Agent 目录（userData/agents） */
  userAgentsDir: string
}

export function ensureAgentRuntime(ctx: AgentRuntimeContext): void {
  mkdirSync(ctx.workspaceRoot, { recursive: true })
  mkdirSync(ctx.userAgentsDir, { recursive: true })
}

export function loadAgentRegistry(ctx: AgentRuntimeContext): ReturnType<typeof mergeAgentLayers> {
  return mergeAgentLayers(ctx.builtinAgentsDir, ctx.userAgentsDir)
}

export interface RunAgentArgs {
  settings: ModelSettings
  apiKey: string
  task: string
  /** 指定已注册的自定义 Agent；缺省 = 内核默认（全工具） */
  agentName?: string
}

export async function runAgent(
  ctx: AgentRuntimeContext,
  args: RunAgentArgs
): Promise<AgentLoopResult & { agent: string }> {
  const registry = loadAgentRegistry(ctx)
  const allTools: AgentTool[] = createFileTools(ctx.workspaceRoot)
  const allNames = allTools.map((t) => t.schema.name)

  const def = args.agentName ? (registry.definitions.get(args.agentName) ?? null) : null
  if (args.agentName && !def) {
    throw new Error(
      `找不到名为「${args.agentName}」的 Agent 定义（已加载：${[...registry.definitions.keys()].join('、') || '无'}）`
    )
  }

  // 白名单（D4）：定义声明了 tools → 只给这些；缺省 → 全量
  const allowed = def?.tools ?? allNames
  const gate = new ToolGate(allowed)
  const tools = allTools.filter((t) => gate.check(t.schema.name).ok)

  const systemPrompt = def
    ? `你是子代理「${def.name}」。${def.description}\n\n${def.systemPrompt}`
    : '你是九十里路的内核 Agent：专注于完成任务，可使用提供的工具读写工作区内的文件。'

  // 定义可指定模型偏好（def.model 覆盖当前会话模型）
  const effective: ModelSettings = def?.model ? { ...args.settings, model: def.model } : args.settings
  const chat = (messages: AgentMessage[]): Promise<AgentChatResult> => {
    const signal = AbortSignal.timeout(effective.timeoutMs)
    return effective.providerType === 'anthropic'
      ? chatWithToolsAnthropic(effective, args.apiKey, messages, [], signal)
      : chatWithToolsOpenAI(effective, args.apiKey, messages, [], signal)
  }

  const result = await runAgentLoop({
    systemPrompt,
    userTask: args.task,
    tools,
    maxRounds: args.settings.maxToolRounds || 12,
    chat
  })
  return { ...result, agent: def?.name ?? '内核默认' }
}

export function defaultAgentContext(userDataDir: string, builtinAgentsDir: string): AgentRuntimeContext {
  const ctx: AgentRuntimeContext = {
    workspaceRoot: join(userDataDir, 'agent-workspace'),
    builtinAgentsDir,
    userAgentsDir: join(userDataDir, 'agents')
  }
  ensureAgentRuntime(ctx)
  return ctx
}
